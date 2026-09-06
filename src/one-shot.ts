import { loadConfig } from "./config.js";
import { setLogLevel, setLogFormat, createLogger } from "./logger.js";
import { createPushScanServer } from "./pushscan.js";
import { runOneShotLifecycle } from "./lifecycle.js";
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

  // The coordinator owns the signal → drain → exit-code decision. A signal
  // with nothing admitted exits straight away; one that lands after a panel
  // trigger was admitted but before its callback ran gives that trigger the
  // rest of SHUTDOWN_TIMEOUT_MS to start (issue #202); a running scan drains
  // like scan:now (issue #134). close() stops new connections being accepted
  // and leaves the admitted trigger's own socket alone.
  const exitCode = await runOneShotLifecycle({
    scanStarted,
    signalled,
    admission,
    stopAcceptingTriggers: () => pushscanServer.close(),
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });

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
