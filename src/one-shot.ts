import { loadConfig, isPaperlessEnabled } from "./config.js";
import { setLogLevel, createLogger } from "./logger.js";
import { getLocalIpForTarget } from "./network.js";
import { createKeepaliveResponder } from "./keepalive.js";
import { createPushScanServer, resolveEffectiveAction } from "./pushscan.js";
import { startScanSession } from "./scanner.js";
import { createInflightTracker } from "./lifecycle.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";

const log = createLogger("one-shot");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info("epson2paperless one-shot — will exit after the first scan completes");
  log.info(`Printer IP: ${config.printerIp}`);
  log.info(`Destination name: ${config.scanDestName}`);
  log.info(`Output directory: ${config.outputDir}`);

  const hasUrl = Boolean(config.paperlessUrl);
  const hasToken = Boolean(config.paperlessToken);
  if (hasUrl && hasToken) {
    const retention = config.paperlessDeleteAfterUpload
      ? "local files deleted after successful upload"
      : "local files retained";
    log.info(`Paperless upload: enabled (${config.paperlessUrl}) — ${retention}`);
  } else if (hasUrl || hasToken) {
    log.warn(
      "Paperless upload disabled: both PAPERLESS_URL and PAPERLESS_TOKEN (or PAPERLESS_TOKEN_FILE) must be set",
    );
  } else {
    log.info("Paperless upload: disabled (no PAPERLESS_URL/PAPERLESS_TOKEN)");
  }

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

  // Outer coordination: `scanSettled` resolves when the one scan finishes,
  // and rejects if a signal interrupts us before the panel press.
  let scanComplete!: () => void;
  let scanFailed!: (err: unknown) => void;
  const scanSettled = new Promise<void>((res, rej) => {
    scanComplete = res;
    scanFailed = rej;
  });

  const inflight = createInflightTracker();
  let scanStarted = false;

  const pushscanServer = createPushScanServer(2968, (info) => {
    const effective = resolveEffectiveAction(info.action, config.previewAction);
    if (effective === null) {
      log.warn(`Ignoring push-scan: action=${info.action}, previewAction=${config.previewAction}`);
      return;
    }
    if (scanStarted) {
      log.warn("Additional push-scan received — ignoring (one-shot already in progress)");
      return;
    }
    scanStarted = true;
    log.info(
      `PushScan received (duplex=${info.duplex}, action=${effective}) — starting TLS scan session`,
    );

    const paperless: PaperlessUploadOptions | undefined = isPaperlessEnabled(config)
      ? {
          url: config.paperlessUrl!,
          token: config.paperlessToken!,
          deleteAfterUpload: config.paperlessDeleteAfterUpload,
        }
      : undefined;

    const scanPromise = startScanSession({
      printerIp: config.printerIp,
      port: 1865,
      destId: config.scanDestId,
      outputDir: config.outputDir,
      tempDir: config.tempDir,
      duplex: info.duplex,
      action: effective,
      paperless,
    });
    void inflight.track(scanPromise);
    scanPromise.then(() => scanComplete()).catch((err) => scanFailed(err));
  });

  log.info("epson2paperless ready — waiting for one scan from printer panel");

  const onSignal = (signal: string): void => {
    log.info(`Received ${signal} — interrupting one-shot`);
    scanFailed(new Error(`Interrupted by ${signal}`));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let exitCode = 0;
  try {
    await scanSettled;
    log.info("Scan complete — shutting down");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`One-shot aborted: ${msg}`);
    exitCode = 130;
  }

  // Teardown mirrors the daemon's runShutdown ordering: close the push-scan
  // listener first so no new requests arrive, drain any in-flight scan via
  // the inflight tracker, then stop the multicast responder.
  try {
    pushscanServer.close();
    const drainResult = await inflight.waitAll(config.shutdownTimeoutMs);
    if (drainResult.timedOut > 0) {
      log.warn(
        `${drainResult.timedOut} scan(s) still in flight after ${config.shutdownTimeoutMs}ms — exiting anyway`,
      );
    }
    responder.stop();
  } catch (err) {
    log.error("Teardown failed", err);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
