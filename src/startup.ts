import { isPaperlessEnabled, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { getLocalIpForTarget } from "./network.js";
import { createKeepaliveResponder, type KeepaliveResponder } from "./keepalive.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";
import { detectVariant, type Variant } from "./protocol-probe.js";
import { runEsci2Scan, runEsci2ScanOverPlain } from "./esci2/scanner.js";
import { runEsciScan } from "./esci/scanner.js";
import { runFf680wJobListCommit, runFf680wJobNumberCommit } from "./ff680w-job-control.js";
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
  const scanDestNameBytes = Buffer.byteLength(config.scanDestName, "utf-8");
  if (scanDestNameBytes >= 15) {
    log.warn(
      `SCAN_DEST_NAME is ${scanDestNameBytes} bytes; Epson discovery may reject names 15 bytes or longer`,
    );
  }
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

const FF680W_PRODUCT_NAME = "PID 016B";

export function buildPushScanServerOptions(config: Config): PushScanServerOptions {
  return {
    beforeResponse: async ({ kind, info }) => {
      if (info.productName !== FF680W_PRODUCT_NAME) return;

      if (kind === "jobList") {
        log.debug("FF-680W JobList received — committing dummy job over TCP/1865");
        await runFf680wJobListCommit({ printerIp: config.printerIp });
        return;
      }

      if (kind === "pushScan" && info.jobNumber !== null && info.pushScanId === null) {
        log.debug(
          `FF-680W JobNumberIn=${info.jobNumber} received — reading selected job over TCP/1865`,
        );
        await runFf680wJobNumberCommit({ printerIp: config.printerIp });
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

  if (
    info.productName === FF680W_PRODUCT_NAME &&
    info.jobNumber !== null &&
    info.pushScanId === null
  ) {
    const duplex = config.scanSides === "duplex";
    log.info(
      `FF-680W JobNumberIn=${info.jobNumber} with no PushScanIDIn — ` +
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
      resolution: args.config.scanResolution,
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
      resolution: args.config.scanResolution,
      paperless: args.paperless,
    });
  }
  // Legacy. Source is autodetected from the FS F status byte (see esci/scanner.ts
  // STATUS_2). ESCI_FORCE_SOURCE overrides the autodetection for users hitting
  // edge cases the autodetect doesn't cover (yet).
  return runEsciScan({
    printerIp: args.config.printerIp,
    port: 1865,
    outputDir: args.config.outputDir,
    tempDir: args.config.tempDir,
    duplex: args.duplex,
    forcedSource: args.config.esciForceSource ?? null,
    format: args.action,
    jpegQuality: args.config.jpegQuality,
    paperless: args.paperless,
    diagnoseProtocol: args.config.diagnoseProtocol,
  });
}
