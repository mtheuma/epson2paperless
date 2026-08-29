import { loadConfig } from "./config.js";
import { setLogLevel, setLogFormat, createLogger } from "./logger.js";
import { createPushScanServer } from "./pushscan.js";
import { createInflightTracker } from "./lifecycle.js";
import {
  logStartupBanner,
  startPrinterDiscovery,
  installCrashHandlers,
  buildPaperlessOptions,
  buildPushScanServerOptions,
  resolveScanDispatch,
  dispatchScanSession,
} from "./startup.js";
import { createPrinterTarget } from "./network.js";

const log = createLogger("one-shot");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  setLogFormat(config.logFormat);

  logStartupBanner(config, "epson2paperless one-shot — will exit after the first scan completes");
  const target = await createPrinterTarget(config);
  const responder = await startPrinterDiscovery(config, target);

  type ExitReason =
    | { kind: "complete" }
    | { kind: "fail"; err: unknown }
    | { kind: "signal"; signal: NodeJS.Signals };

  let settle!: (reason: ExitReason) => void;
  const settled = new Promise<ExitReason>((res) => {
    settle = res;
  });

  const inflight = createInflightTracker();

  const pushscanServer = createPushScanServer(
    2968,
    (info) => {
      const scan = resolveScanDispatch(info, config);
      if (scan === null) {
        log.warn(
          `Ignoring push-scan: action=${info.action}, previewAction=${config.previewAction}`,
        );
        return;
      }
      if (inflight.count > 0) {
        log.warn("Additional push-scan received — ignoring (one-shot already in progress)");
        return;
      }
      log.info(
        `PushScan received (duplex=${scan.duplex}, action=${scan.action}) — starting scan session`,
      );

      const scanPromise = dispatchScanSession({
        config,
        duplex: scan.duplex,
        action: scan.action,
        paperless: buildPaperlessOptions(config),
        productName: info.productName,
        printerIp: info.peerAddress,
      });
      void inflight.track(scanPromise);
      scanPromise.then(
        () => settle({ kind: "complete" }),
        (err) => settle({ kind: "fail", err }),
      );
    },
    buildPushScanServerOptions(config, target),
  );

  log.info("epson2paperless ready — waiting for one scan from printer panel");

  const onSignal = (signal: NodeJS.Signals): void => {
    log.info(`Received ${signal} — interrupting one-shot`);
    settle({ kind: "signal", signal });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  installCrashHandlers();

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
