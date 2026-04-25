import { loadConfig } from "./config.js";
import { setLogLevel, setLogFormat, createLogger } from "./logger.js";
import { createPushScanServer, resolveEffectiveAction } from "./pushscan.js";
import { startScanSession } from "./scanner.js";
import { createInflightTracker } from "./lifecycle.js";
import {
  logStartupBanner,
  startPrinterDiscovery,
  installCrashHandlers,
  buildPaperlessOptions,
} from "./startup.js";

const log = createLogger("one-shot");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  setLogFormat(config.logFormat);

  logStartupBanner(config, "epson2paperless one-shot — will exit after the first scan completes");
  const responder = await startPrinterDiscovery(config);

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

    const scanPromise = startScanSession({
      printerIp: config.printerIp,
      port: 1865,
      destId: config.scanDestId,
      outputDir: config.outputDir,
      tempDir: config.tempDir,
      duplex: info.duplex,
      action: effective,
      paperless: buildPaperlessOptions(config),
      printerCertFingerprint: config.printerCertFingerprint,
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
