import { loadConfig } from "./config.js";
import { setLogLevel, setLogFormat, createLogger } from "./logger.js";
import { createPushScanServer } from "./pushscan.js";
import { createHealthServer } from "./health.js";
import { createInflightTracker, shutdown as runShutdown } from "./lifecycle.js";
import {
  logStartupBanner,
  startPrinterDiscovery,
  installCrashHandlers,
  buildDaemonPushScanCallback,
  buildPushScanServerOptions,
  buildScanTriggerOptions,
} from "./startup.js";
import { createPrinterTarget } from "./network.js";
import { createScanAdmission } from "./scan-admission.js";

const log = createLogger("main");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  setLogFormat(config.logFormat);

  logStartupBanner(config, "epson2paperless starting");
  const target = await createPrinterTarget(config);
  const responder = await startPrinterDiscovery(config, target);

  const inflight = createInflightTracker();
  // One scan at a time, whichever door it came through (issue #137).
  const admission = createScanAdmission(inflight);

  const pushscanServer = createPushScanServer(
    2968,
    buildDaemonPushScanCallback({ config, admission }),
    buildPushScanServerOptions(config, target, admission),
  );

  const healthServer = createHealthServer(config.healthPort, {
    scanTrigger: buildScanTriggerOptions({ config, target, admission }),
  });
  // Logged here rather than in the shared startup banner: scan:now and
  // one-shot print that banner too, and neither opens an HTTP server.
  log.info(
    config.scanTriggerToken
      ? `Scan webhook enabled: POST /scan on port ${config.healthPort}`
      : "Scan webhook disabled (SCAN_TRIGGER_TOKEN unset)",
  );

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
