import { loadConfig } from "./config.js";
import { setLogLevel, setLogFormat, createLogger } from "./logger.js";
import { createPushScanServer, resolveEffectiveAction } from "./pushscan.js";
import { startScanSession } from "./scanner.js";
import { createHealthServer, setLastScanTime } from "./health.js";
import { createInflightTracker, shutdown as runShutdown } from "./lifecycle.js";
import {
  logStartupBanner,
  startPrinterDiscovery,
  installCrashHandlers,
  buildPaperlessOptions,
} from "./startup.js";

const log = createLogger("main");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  setLogFormat(config.logFormat);

  logStartupBanner(config, "epson2paperless starting");
  const { responder } = await startPrinterDiscovery(config);

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
      paperless: buildPaperlessOptions(config),
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

  installCrashHandlers();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
