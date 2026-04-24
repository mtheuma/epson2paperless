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

  type ExitReason =
    | { kind: "complete" }
    | { kind: "fail"; err: unknown }
    | { kind: "signal"; signal: NodeJS.Signals };

  let settle!: (reason: ExitReason) => void;
  const settled = new Promise<ExitReason>((res) => {
    settle = res;
  });

  const inflight = createInflightTracker();

  const pushscanServer = createPushScanServer(2968, (info) => {
    const effective = resolveEffectiveAction(info.action, config.previewAction);
    if (effective === null) {
      log.warn(`Ignoring push-scan: action=${info.action}, previewAction=${config.previewAction}`);
      return;
    }
    if (inflight.count > 0) {
      log.warn("Additional push-scan received — ignoring (one-shot already in progress)");
      return;
    }
    log.info(
      `PushScan received (duplex=${info.duplex}, action=${effective}) — starting TLS scan session`,
    );

    const paperless: PaperlessUploadOptions | undefined = isPaperlessEnabled(config)
      ? {
          url: config.paperlessUrl,
          token: config.paperlessToken,
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
    scanPromise.then(
      () => settle({ kind: "complete" }),
      (err) => settle({ kind: "fail", err }),
    );
  });

  log.info("epson2paperless ready — waiting for one scan from printer panel");

  const onSignal = (signal: NodeJS.Signals): void => {
    log.info(`Received ${signal} — interrupting one-shot`);
    settle({ kind: "signal", signal });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception — exiting", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection (not exiting)", reason);
  });

  const reason = await settled;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  let exitCode: number;
  switch (reason.kind) {
    case "complete":
      log.info("Scan complete — shutting down");
      exitCode = 0;
      break;
    case "fail":
      log.error("Scan failed — shutting down", reason.err);
      exitCode = 1;
      break;
    case "signal":
      exitCode = reason.signal === "SIGTERM" ? 143 : 130;
      break;
  }

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
