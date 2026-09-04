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
  resolveEffectiveAction,
  type PushScanInfo,
  type PushScanServerOptions,
} from "./pushscan.js";

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
  // NOT what gets advertised — the keepalive handler recomputes the local
  // address per announcement, against that announcement's source, and spreads
  // that over `keepalive.ipAddress`. On a multi-homed host the two can differ,
  // so the log must not read as "this is the address we advertise".
  const localIp = await getLocalIpForTarget(printerIp);
  log.info(`Route to printer ${printerIp}: via local address ${localIp}`);

  const responder = createKeepaliveResponder({
    keepalive: {
      clientName: config.scanDestName,
      // Seed value only — never reaches the wire. See the recompute note above.
      ipAddress: localIp,
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

export function buildPushScanServerOptions(
  config: Config,
  target?: PrinterTarget,
): PushScanServerOptions {
  return {
    validatePeer: target ? (peer) => target.accepts(peer) : undefined,
    beforeResponse: async ({ kind, info, peerAddress }) => {
      const targetIp = peerAddress || config.printerIp;
      if (!targetIp) throw new Error("Push-scan peer address is required");
      if (!usesJobControl(info.productName)) return;

      if (kind === "jobList") {
        log.debug(`${info.productName} JobList received — committing dummy job over TCP/1865`);
        await runJobListCommit({ printerIp: targetIp });
        return;
      }

      if (kind === "pushScan" && info.jobNumber !== null && info.pushScanId === null) {
        log.debug(
          `${info.productName} JobNumberIn=${info.jobNumber} received — reading selected job over TCP/1865`,
        );
        await runJobNumberCommit({ printerIp: targetIp });
      }
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
