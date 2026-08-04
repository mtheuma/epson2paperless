import { isPaperlessEnabled, resolveGrayscaleConversion, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { getLocalIpForTarget } from "./network.js";
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
  log.info(`Printer IP: ${config.printerIp}`);
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

export async function startPrinterDiscovery(config: Config): Promise<KeepaliveResponder> {
  const localIp = await getLocalIpForTarget(config.printerIp);
  log.info(`Local IP: ${localIp}`);

  const responder = createKeepaliveResponder({
    keepalive: {
      clientName: config.scanDestName,
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
    printerIp: config.printerIp,
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

export function buildPushScanServerOptions(config: Config): PushScanServerOptions {
  return {
    beforeResponse: async ({ kind, info }) => {
      if (!usesJobControl(info.productName)) return;

      if (kind === "jobList") {
        log.debug(`${info.productName} JobList received — committing dummy job over TCP/1865`);
        await runJobListCommit({ printerIp: config.printerIp });
        return;
      }

      if (kind === "pushScan" && info.jobNumber !== null && info.pushScanId === null) {
        log.debug(
          `${info.productName} JobNumberIn=${info.jobNumber} received — reading selected job over TCP/1865`,
        );
        await runJobNumberCommit({ printerIp: config.printerIp });
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
}

export async function dispatchScanSession(args: DispatchArgs): Promise<void> {
  const variant: Variant = await detectVariant({
    printerIp: args.config.printerIp,
    port: 1865,
    override: args.config.printerProtocol,
    timeoutMs: 3000,
  });
  if (variant === "esci2") {
    return runEsci2Scan({
      printerIp: args.config.printerIp,
      port: 1865,
      destId: args.config.scanDestId,
      outputDir: args.config.outputDir,
      tempDir: args.config.tempDir,
      duplex: args.duplex,
      action: args.action,
      postProcess: args.config.postProcess,
      jpegQuality: args.config.jpegQuality,
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
      printerIp: args.config.printerIp,
      port: 1865,
      destId: args.config.scanDestId,
      outputDir: args.config.outputDir,
      tempDir: args.config.tempDir,
      duplex: args.duplex,
      action: args.action,
      postProcess: args.config.postProcess,
      jpegQuality: args.config.jpegQuality,
      resolution: args.config.scanResolution,
      colorMode: args.config.scanColorMode,
      paperless: args.paperless,
    });
  }
  // Legacy. Source is autodetected from the FS F status byte (see esci/scanner.ts
  // STATUS_2). ESCI_FORCE_SOURCE overrides the autodetection for users hitting
  // edge cases the autodetect doesn't cover (yet).
  const entry = resolveLegacyEntry(args.productName);
  // The legacy ESC/I command set has no greyscale wire request at all —
  // SCAN_COLOR_MODE=grayscale falls back to converting every page host-side
  // at finalize. Say so, or the colour wire traffic in a debug log reads as
  // the setting being ignored.
  if (args.config.scanColorMode === "grayscale") {
    log.info(
      "SCAN_COLOR_MODE=grayscale: the legacy ESC/I wire has no greyscale request — " +
        "scanning in colour and converting to greyscale host-side.",
    );
  }
  return runEsciScan({
    printerIp: args.config.printerIp,
    port: 1865,
    outputDir: args.config.outputDir,
    tempDir: args.config.tempDir,
    entry,
    duplex: args.duplex,
    forcedSource: args.config.esciForceSource ?? null,
    format: args.action,
    jpegQuality: args.config.jpegQuality,
    postProcess: args.config.postProcess,
    // The legacy wire has no colour-mode axis; greyscale is entirely a
    // post-processing concern here (wireGrayscaleSupported: false).
    grayscaleConversion: resolveGrayscaleConversion(args.config.scanColorMode, false),
    paperless: args.paperless,
    diagnoseProtocol: args.config.diagnoseProtocol,
  });
}
