import { loadConfig } from "./config.js";
import { setLogLevel, setLogFormat, createLogger } from "./logger.js";
import { createPushScanServer } from "./pushscan.js";
import { runScanNowLifecycle } from "./lifecycle.js";
import {
  logStartupBanner,
  startPrinterDiscovery,
  installCrashHandlers,
  buildOneShotPushScanCallback,
  buildPushScanServerOptions,
} from "./startup.js";
import { createPrinterTarget } from "./network.js";
import { createSingleScanAdmission } from "./scan-admission.js";

const log = createLogger("one-shot");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  setLogFormat(config.logFormat);

  logStartupBanner(config, "epson2paperless one-shot — will exit after the first scan completes");
  const target = await createPrinterTarget(config);
  const responder = await startPrinterDiscovery(config, target);

  // Resolves once the panel's first accepted push-scan has started a session.
  // The scan promise is wrapped in an object on purpose: resolving a Promise
  // *with* another promise would adopt it, and scanStarted would then wait for
  // the whole scan instead of just its start.
  let onScanStarted!: (started: { scan: Promise<void> }) => void;
  const scanStarted = new Promise<{ scan: Promise<void> }>((resolve) => {
    onScanStarted = resolve;
  });
  // A second panel press while the scan runs is refused at beforeResponse so
  // the panel errors at once, instead of getting an OK and then waiting for a
  // session that never opens (issue #198). The slot never reopens: this
  // process exits after its one scan.
  const admission = createSingleScanAdmission();

  const pushscanServer = createPushScanServer(
    2968,
    buildOneShotPushScanCallback({ config, admission, onScanStarted }),
    buildPushScanServerOptions(config, target, admission),
  );

  log.info("epson2paperless ready — waiting for one scan from printer panel");

  const signalled = new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
  installCrashHandlers();

  // Nothing to drain until the panel has pushed, so a signal before then exits
  // straight away with the signal code. Once a scan is running, the shared
  // coordinator owns the signal → drain → exit-code decision, same as
  // scan:now (issue #134).
  const first = await Promise.race([
    scanStarted.then(({ scan }) => ({ kind: "scan", scan }) as const),
    signalled.then((signal) => ({ kind: "signal", signal }) as const),
  ]);

  let exitCode: number;
  if (first.kind === "signal") {
    log.info(`Received ${first.signal} before any scan started — shutting down`);
    exitCode = first.signal === "SIGTERM" ? 143 : 130;
  } else {
    exitCode = await runScanNowLifecycle({
      scan: first.scan,
      signalled,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    });
  }

  try {
    pushscanServer.close();
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
