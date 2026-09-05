import { loadConfig } from "./config.js";
import { setLogLevel, setLogFormat, createLogger } from "./logger.js";
import { createPushScanServer } from "./pushscan.js";
import { createHealthServer, setLastScanTime } from "./health.js";
import { createInflightTracker, shutdown as runShutdown } from "./lifecycle.js";
import {
  logStartupBanner,
  startPrinterDiscovery,
  installCrashHandlers,
  buildPaperlessOptions,
  buildPushScanServerOptions,
  buildScanTriggerOptions,
  resolveScanDispatch,
  dispatchScanSession,
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
    (info, peerAddress) => {
      const scan = resolveScanDispatch(info, config);
      if (scan === null) {
        log.warn(
          `Ignoring push-scan: action=${info.action}, previewAction=${config.previewAction}`,
        );
        admission.release(); // admitted at beforeResponse, but nothing will scan
        return;
      }
      log.info(
        `PushScan received (duplex=${scan.duplex}, action=${scan.action}) — starting scan session`,
      );
      setLastScanTime(new Date().toISOString());

      const scanPromise = dispatchScanSession({
        config,
        duplex: scan.duplex,
        action: scan.action,
        paperless: buildPaperlessOptions(config),
        productName: info.productName,
        printerIp: peerAddress,
      });
      // Converts the reservation taken at beforeResponse into a tracked scan.
      admission.commit(scanPromise);
    },
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
