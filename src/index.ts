import { loadConfig } from "./config.js";
import { setLogLevel, createLogger } from "./logger.js";
import { getLocalIpForTarget } from "./network.js";
import { createKeepaliveResponder } from "./keepalive.js";
import { createPushScanServer, resolveEffectiveAction } from "./pushscan.js";
import { startScanSession } from "./scanner.js";
import { createHealthServer, setLastScanTime } from "./health.js";
import { createInflightTracker, shutdown as runShutdown } from "./lifecycle.js";

const log = createLogger("main");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info("epson2paperless starting");
  log.info(`Printer IP: ${config.printerIp}`);
  log.info(`Destination name: ${config.scanDestName}`);
  log.info(`Output directory: ${config.outputDir}`);

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

  const inflight = createInflightTracker();

  const pushscanServer = createPushScanServer(2968, (info) => {
    const effective = resolveEffectiveAction(info.action, config.previewAction);
    if (effective === null) {
      log.warn(`Ignoring push-scan: action=${info.action}, previewAction=${config.previewAction}`);
      return;
    }
    log.info(
      `PushScan received (duplex=${info.duplex}, action=${effective}) — starting TLS scan session`,
    );
    setLastScanTime(new Date().toISOString());

    const scanPromise = startScanSession({
      printerIp: config.printerIp,
      port: 1865,
      destId: config.scanDestId,
      outputDir: config.outputDir,
      tempDir: config.tempDir,
      duplex: info.duplex,
      action: effective,
    });
    void inflight.track(scanPromise);
  });

  const healthServer = createHealthServer(config.healthPort);

  log.info("epson2paperless ready — waiting for scan from printer panel");

  const handleSignal = (signal: string): void => {
    runShutdown({
      pushscanServer,
      healthServer,
      responder,
      inflight,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      signal,
      exit: process.exit.bind(process),
    }).catch((err) => {
      log.error("Shutdown failed", err);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception — exiting", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection (not exiting)", reason);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
