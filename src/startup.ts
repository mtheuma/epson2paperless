import { isPaperlessEnabled, resolveGrayscaleConversion, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { createPrinterTarget, getLocalIpForTarget, type PrinterTarget } from "./network.js";
import { createKeepaliveResponder, type KeepaliveResponder } from "./keepalive.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";
import { detectVariant, type Variant } from "./protocol-probe.js";
import { runEsci2Scan, runEsci2ScanOverPlain } from "./esci2/scanner.js";
import { runEsciScan } from "./esci/scanner.js";
import { resolveLegacyEntry } from "./esci/dialects/registry.js";
import { runJobListCommit, runJobNumberCommit } from "./job-control.js";
import { PID_FF680W, PID_DS575W } from "./printer-ids.js";
import {
  PushScanRefusedError,
  resolveEffectiveAction,
  type PushScanCallback,
  type PushScanInfo,
  type PushScanReleaseHook,
  type PushScanServerOptions,
} from "./pushscan.js";
import { setLastScanTime, type ScanTriggerOptions } from "./health.js";
import type { ScanAdmission, SingleScanAdmission } from "./scan-admission.js";

const log = createLogger("startup");

export function logStartupBanner(config: Config, modeMessage: string): void {
  log.info(modeMessage);
  log.info(`Printer target: ${config.printerIp ?? config.printerHostname}`);
  log.info(`Destination name: ${config.scanDestName}`);
  log.info(`Output directory: ${config.outputDir}`);

  if (isPaperlessEnabled(config)) {
    const retention = config.paperlessDeleteAfterUpload
      ? "local files deleted after successful upload"
      : "local files retained";
    log.info(`Paperless upload: enabled (${config.paperlessUrl}) — ${retention}`);
  } else if (config.paperlessUrl || config.paperlessToken) {
    log.warn(
      "Paperless upload disabled: both PAPERLESS_URL and PAPERLESS_TOKEN (or PAPERLESS_TOKEN_FILE) must be set",
    );
  } else {
    log.info("Paperless upload: disabled (no PAPERLESS_URL/PAPERLESS_TOKEN)");
  }

  if (config.printerCertFingerprint) {
    log.info(
      `Printer cert pinning: enabled (sha256 ${config.printerCertFingerprint.slice(0, 8)}…)`,
    );
  } else {
    log.info(
      "Printer cert pinning: disabled (set PRINTER_PROTOCOL=esci2 + PRINTER_CERT_FINGERPRINT to enable)",
    );
  }

  log.info(
    `Protocol: ${config.printerProtocol}${config.printerProtocol === "auto" ? " (TLS-probe at first scan)" : ""}`,
  );
  if (config.diagnoseProtocol) {
    log.info(
      "Protocol diagnostic mode: ENABLED (DIAGNOSE_PROTOCOL=true) — legacy ESC @ failures will trigger an FS Y probe and abort. Disable for normal scanning.",
    );
  }
  if (config.netscanVersion !== "auto") {
    log.info(
      `NetScanMonitor keepalive version: FORCED v${config.netscanVersion} (NETSCAN_VERSION) — auto normally selects by announced PID. Unset for normal operation.`,
    );
  }
  log.info(`JPEG quality: ${config.jpegQuality}`);
}

export async function startPrinterDiscovery(
  config: Config,
  existingTarget?: PrinterTarget,
): Promise<KeepaliveResponder> {
  const target = existingTarget ?? (await createPrinterTarget(config));
  const printerIp = await target.target();
  // Fail-fast reachability check: if the host has no route to the printer at
  // all, say so now rather than at the first beacon. The address it returns is
  // NOT what gets advertised — the keepalive handler computes the local
  // address per announcement, against that announcement's source. On a
  // multi-homed host the two can differ, so the log must not read as "this is
  // the address we advertise".
  const localIp = await getLocalIpForTarget(printerIp);
  log.info(`Route to printer ${printerIp}: via local address ${localIp}`);

  const responder = createKeepaliveResponder({
    keepalive: {
      clientName: config.scanDestName,
      eventPort: 2968,
      destId: config.scanDestId,
      language: config.language,
      // "auto" leaves version undefined so the responder picks per-announcement
      // (3.0 for the V3_KEEPALIVE_PRODUCTS PIDs — FF-680W, DS-575W — 2.0
      // otherwise). An explicit NETSCAN_VERSION
      // pins every burst to that wire format — compatibility-triage aid for
      // button-only scanners we don't recognise yet.
      version: config.netscanVersion === "auto" ? undefined : config.netscanVersion,
    },
    printerIp,
    target,
    printerPort: 2968,
    multicastAddress: "239.255.255.253",
    multicastPort: 2968,
    burstCount: 3,
    burstIntervalMs: 500,
  });
  await responder.start();
  return responder;
}

export function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception — exiting", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection (not exiting)", reason);
  });
}

export function buildPaperlessOptions(config: Config): PaperlessUploadOptions | undefined {
  if (!isPaperlessEnabled(config)) return undefined;
  return {
    url: config.paperlessUrl,
    token: config.paperlessToken,
    deleteAfterUpload: config.paperlessDeleteAfterUpload,
  };
}

// Button-only scanners (no destination-picker panel) trigger scanning through a
// JobList → dummy-job-commit → JobNumber handshake rather than a direct
// PushScanIDIn. Both the FF-680W and its DS-575W sibling use this flow; the
// job-control commands in job-control.ts were reverse-engineered from the
// FF-680W, and the DS-575W's JobList is structurally identical (verified on the
// wire, issue #128). Mirrors V3_KEEPALIVE_PRODUCTS in keepalive.ts — separate
// axis, shared membership today (see printer-ids.ts).
const JOB_CONTROL_PRODUCTS = new Set([PID_FF680W, PID_DS575W]);

function usesJobControl(productName: string | null): boolean {
  return productName !== null && JOB_CONTROL_PRODUCTS.has(productName);
}

/**
 * Options for the push-scan server on TCP 2968.
 *
 * `admission` is required, and `target` therefore takes an explicit
 * `undefined` rather than being optional: an omitted gate used to admit every
 * push-scan silently, which is how one-shot shipped without one (issue #198)
 * past both the compiler and the suite. Callers with genuinely nothing to gate
 * pass an explicit no-gate stub so the intent is visible at the call site.
 */
export function buildPushScanServerOptions(
  config: Config,
  target: PrinterTarget | undefined,
  admission: Pick<ScanAdmission, "isBusy" | "reserve">,
): PushScanServerOptions {
  return {
    validatePeer: target ? (peer) => target.accepts(peer) : undefined,
    beforeResponse: async ({ kind, info, peerAddress }) => {
      // Shared admission with the POST /scan webhook (issue #137): the printer
      // serves one scan at a time. A panel press while a scan runs is refused
      // here, before any job-control round-trip and before the OK response —
      // refusing in the onPushScan callback would be too late, the printer
      // would already be waiting for a session that never opens.
      //
      // Admitting also *reserves* the slot from this moment. The trigger only
      // becomes a tracked scan once the OK has been flushed and the callback
      // runs; on the FF-680W / DS-575W that gap holds the JOBR read below (a
      // network round-trip with a 3 s timeout), and on every model it holds
      // the response write. Without the reservation a webhook arriving in
      // that gap would be admitted and two scans would start. The hook we
      // return lets pushscan.ts drop the reservation if this trigger ends
      // without the callback firing; the callback itself converts it into a
      // tracked scan via admission.commit(). JobList is destination selection,
      // not a scan, so it is never gated and never reserves.
      let release: PushScanReleaseHook | undefined;
      if (kind === "pushScan") {
        if (admission.isBusy()) throw new PushScanRefusedError("another scan is in flight");
        release = admission.reserve();
      }

      try {
        const targetIp = peerAddress || config.printerIp;
        if (!targetIp) throw new Error("Push-scan peer address is required");
        if (!usesJobControl(info.productName)) return release;

        if (kind === "jobList") {
          log.debug(`${info.productName} JobList received — committing dummy job over TCP/1865`);
          await runJobListCommit({ printerIp: targetIp });
          return release;
        }

        if (kind === "pushScan" && info.jobNumber !== null && info.pushScanId === null) {
          log.debug(
            `${info.productName} JobNumberIn=${info.jobNumber} received — reading selected job over TCP/1865`,
          );
          await runJobNumberCommit({ printerIp: targetIp });
        }
        return release;
      } catch (err) {
        // The printer gets ERROR and no callback will fire, so nothing else
        // would ever drop this reservation.
        release?.();
        throw err;
      }
    },
  };
}

export interface DaemonPushScanDeps {
  config: Config;
  /** Holds the reservation taken for this trigger at `beforeResponse`. */
  admission: Pick<ScanAdmission, "commit" | "release">;
  /** Injectable for tests; defaults to {@link dispatchScanSession}. */
  dispatch?: (args: DispatchArgs) => Promise<void>;
}

/**
 * The daemon's onPushScan callback (index.ts). Every admitted panel trigger
 * arrives holding a reservation, so both arms have to dispose of it: the scan
 * converts it into a tracked promise via commit(), and a trigger that resolves
 * to no scan drops it via release(). Leaking it would wedge the shared gate
 * (issue #137) for the life of the process.
 */
export function buildDaemonPushScanCallback(deps: DaemonPushScanDeps): PushScanCallback {
  const { config, admission } = deps;
  const dispatch = deps.dispatch ?? dispatchScanSession;

  return (info, peerAddress) => {
    const scan = resolveScanDispatch(info, config);
    if (scan === null) {
      log.warn(`Ignoring push-scan: action=${info.action}, previewAction=${config.previewAction}`);
      admission.release(); // admitted at beforeResponse, but nothing will scan
      return;
    }
    log.info(
      `PushScan received (duplex=${scan.duplex}, action=${scan.action}) — starting scan session`,
    );
    setLastScanTime(new Date().toISOString());

    const scanPromise = dispatch({
      config,
      duplex: scan.duplex,
      action: scan.action,
      paperless: buildPaperlessOptions(config),
      productName: info.productName,
      printerIp: peerAddress,
    });
    // Converts the reservation taken at beforeResponse into a tracked scan.
    admission.commit(scanPromise);
  };
}

export interface OneShotPushScanDeps {
  config: Config;
  /** Holds the reservation taken for this trigger at `beforeResponse`. */
  admission: Pick<SingleScanAdmission, "commit" | "release">;
  /** Resolved exactly once, with the first accepted trigger's scan promise. */
  onScanStarted: (started: { scan: Promise<void> }) => void;
  /** Injectable for tests; defaults to {@link dispatchScanSession}. */
  dispatch?: (args: DispatchArgs) => Promise<void>;
}

/**
 * One-shot's onPushScan callback (one-shot.ts). Same reject arm as the daemon,
 * but the accepted arm fires once for the life of the process: commit() here
 * is permanent (the slot never reopens) and `onScanStarted` is a promise
 * resolver, so a second trigger that reached the callback anyway — the panel
 * press that raced `beforeResponse` — has to be dropped before either.
 */
export function buildOneShotPushScanCallback(deps: OneShotPushScanDeps): PushScanCallback {
  const { config, admission, onScanStarted } = deps;
  const dispatch = deps.dispatch ?? dispatchScanSession;
  let started = false;

  return (info, peerAddress) => {
    const scan = resolveScanDispatch(info, config);
    if (scan === null) {
      log.warn(`Ignoring push-scan: action=${info.action}, previewAction=${config.previewAction}`);
      admission.release(); // admitted at beforeResponse, but nothing will scan
      return;
    }
    if (started) {
      log.warn("Additional push-scan received — ignoring (one-shot already in progress)");
      return;
    }
    started = true;
    admission.commit();
    log.info(
      `PushScan received (duplex=${scan.duplex}, action=${scan.action}) — starting scan session`,
    );

    onScanStarted({
      scan: dispatch({
        config,
        duplex: scan.duplex,
        action: scan.action,
        paperless: buildPaperlessOptions(config),
        productName: info.productName,
        printerIp: peerAddress,
      }),
    });
  };
}

export interface ScanWebhookDeps {
  config: Config;
  target: Pick<PrinterTarget, "target">;
  /** Shared with the panel path so admission is mutual (see scan-admission.ts). */
  admission: Pick<ScanAdmission, "isBusy" | "track">;
  /** Injectable for tests; defaults to {@link dispatchScanSession}. */
  dispatch?: (args: DispatchArgs) => Promise<void>;
}

/**
 * Wires the POST /scan webhook (issue #137) to the scan pipeline. Returns
 * undefined when SCAN_TRIGGER_TOKEN is unset, which leaves the health server
 * as a pure read-only probe. The scan runs exactly as `scan:now` does: no
 * panel, so format/sides come from the request (defaulting to SCAN_FORMAT /
 * SCAN_SIDES), no PID hint, printer address from the resolved target.
 */
export function buildScanTriggerOptions(deps: ScanWebhookDeps): ScanTriggerOptions | undefined {
  const { config, target, admission } = deps;
  if (!config.scanTriggerToken) return undefined;
  const dispatch = deps.dispatch ?? dispatchScanSession;

  return {
    token: config.scanTriggerToken,
    defaults: { scanFormat: config.scanFormat, scanSides: config.scanSides },
    isBusy: () => admission.isBusy(),
    onScan: (request, peerAddress) => {
      log.info(
        `Webhook scan accepted from ${peerAddress} (format=${request.format}, sides=${request.sides})`,
      );
      setLastScanTime(new Date().toISOString());
      // The busy check in health.ts and this track() share one synchronous
      // turn, so two simultaneous POSTs cannot both be admitted. target() is
      // awaited *inside* the tracked promise for exactly that reason: the
      // slot is taken before anything yields. No reservation is needed on
      // this side — unlike a panel trigger, the webhook has no response
      // round-trip between admission and tracking.
      const scan = (async () => {
        const printerIp = await target.target();
        await dispatch({
          config,
          duplex: request.sides === "duplex",
          action: request.format,
          paperless: buildPaperlessOptions(config),
          productName: null,
          printerIp,
        });
      })();
      admission.track(scan);
    },
  };
}

export function resolveScanDispatch(
  info: PushScanInfo,
  config: Config,
): { duplex: boolean; action: "jpg" | "pdf" } | null {
  const effective = resolveEffectiveAction(info.action, config.previewAction);
  if (effective !== null) {
    return { duplex: info.duplex, action: effective };
  }

  if (usesJobControl(info.productName) && info.jobNumber !== null && info.pushScanId === null) {
    const duplex = config.scanSides === "duplex";
    log.info(
      `${info.productName} JobNumberIn=${info.jobNumber} with no PushScanIDIn — ` +
        `using SCAN_SIDES=${config.scanSides}, SCAN_FORMAT=${config.scanFormat}`,
    );
    return { duplex, action: config.scanFormat };
  }

  return null;
}

export interface DispatchArgs {
  config: Config;
  duplex: boolean;
  action: "jpg" | "pdf";
  paperless: PaperlessUploadOptions | undefined;
  productName: string | null;
  printerIp?: string;
}

export async function dispatchScanSession(args: DispatchArgs): Promise<void> {
  // The validated push-scan peer (daemon / one-shot) or the resolved target
  // (scan:now); fixed-IP mode falls back to config. Resolve once so the routing
  // IP can't diverge between detectVariant and the scanner it dispatches to.
  const printerIp = args.printerIp ?? args.config.printerIp;
  if (!printerIp) throw new Error("No printer address: pass a peer or set PRINTER_IP");
  const variant: Variant = await detectVariant({
    printerIp,
    port: 1865,
    override: args.config.printerProtocol,
    timeoutMs: 3000,
    // PID hint: lets the probe correct the welcome-discriminator verdict for
    // ESC/I-2 models whose welcome is byte-identical to the legacy one
    // (currently the ET-7700). Null for scan:now, which has no panel to ask.
    productName: args.productName,
  });
  // Zod rejects ESCI_FORCE_SOURCE only alongside an explicit esci2/esci2-plain
  // override; under auto it validates and then does nothing on a non-legacy
  // route. Say so, instead of failing loudly in one mode and silently in the
  // other.
  if (variant !== "esci" && args.config.esciForceSource) {
    log.warn(
      `ESCI_FORCE_SOURCE is set but this session resolved to ${variant} — ` +
        `the flag only affects the legacy ESC/I path and is ignored.`,
    );
  }
  if (variant === "esci2") {
    return runEsci2Scan({
      printerIp,
      port: 1865,
      destId: args.config.scanDestId,
      outputDir: args.config.outputDir,
      tempDir: args.config.tempDir,
      duplex: args.duplex,
      action: args.action,
      postProcess: args.config.postProcess,
      jpegQuality: args.config.jpegQuality,
      whitePoint: args.config.printerWhitePoint,
      resolution: args.config.scanResolution,
      colorMode: args.config.scanColorMode,
      paperless: args.paperless,
      printerCertFingerprint: args.config.printerCertFingerprint,
    });
  }
  if (variant === "esci2-plain") {
    // Same ScanSession shape as the TLS path; the shell sets
    // `transport = "plain"` on `initialCtx` itself, so the dispatcher
    // only chooses which entry point to call. Cert fingerprint is
    // ignored on this path (no TLS layer); config-time Zod validation
    // rejects the combo at startup.
    return runEsci2ScanOverPlain({
      printerIp,
      port: 1865,
      destId: args.config.scanDestId,
      outputDir: args.config.outputDir,
      tempDir: args.config.tempDir,
      duplex: args.duplex,
      action: args.action,
      postProcess: args.config.postProcess,
      jpegQuality: args.config.jpegQuality,
      whitePoint: args.config.printerWhitePoint,
      resolution: args.config.scanResolution,
      colorMode: args.config.scanColorMode,
      paperless: args.paperless,
    });
  }
  // Legacy. Source is autodetected from the FS F status byte (see esci/scanner.ts
  // STATUS_2). ESCI_FORCE_SOURCE overrides the autodetection for users hitting
  // edge cases the autodetect doesn't cover (yet).
  const entry = resolveLegacyEntry(args.productName);
  // The legacy ESC/I wire has no colour-mode axis at all, so greyscale is
  // entirely a post-processing concern (wireGrayscaleSupported: false).
  // Gate the announcement on the resolved value itself — not a re-derived
  // condition — so the log can never drift from the behaviour it describes.
  const grayscaleConversion = resolveGrayscaleConversion(args.config.scanColorMode, false);
  if (grayscaleConversion === "force") {
    log.info(
      "SCAN_COLOR_MODE=grayscale: the legacy ESC/I wire has no greyscale request — " +
        "scanning in colour and converting to greyscale host-side.",
    );
  }
  return runEsciScan({
    printerIp,
    port: 1865,
    outputDir: args.config.outputDir,
    tempDir: args.config.tempDir,
    entry,
    duplex: args.duplex,
    forcedSource: args.config.esciForceSource ?? null,
    format: args.action,
    jpegQuality: args.config.jpegQuality,
    resolution: args.config.scanResolution,
    whitePoint: args.config.printerWhitePoint,
    postProcess: args.config.postProcess,
    grayscaleConversion,
    paperless: args.paperless,
    diagnoseProtocol: args.config.diagnoseProtocol,
  });
}
