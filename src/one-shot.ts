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
  trackPendingHooks,
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
  // The hook count covers the JobList round-trip that precedes admission on
  // button-only scanners, which the shutdown coordinator must also wait out.
  const { options: pushscanOptions, pending: hooksPending } = trackPendingHooks(
    buildPushScanServerOptions(config, target, admission),
  );

  const pushscanServer = createPushScanServer(
    2968,
    buildOneShotPushScanCallback({ config, admission, onScanStarted }),
    pushscanOptions,
  );

  log.info("epson2paperless ready — waiting for one scan from printer panel");

  const signalled = new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
  installCrashHandlers();

  // The coordinator owns the signal → drain → exit-code decision. A signal
  // with no trigger pending exits straight away; one that lands while a panel
  // trigger is still being answered gives it the rest of SHUTDOWN_TIMEOUT_MS
  // to start a scan (issue #202); a running scan drains like scan:now (issue
  // #134). The listener stays open throughout: the admission gate refuses new
  // presses, and a JobList's follow-up PushScan must still get through.
  const exitCode = await runOneShotLifecycle({
    scanStarted,
    signalled,
    triggerPending: () => admission.isBusy() || hooksPending() > 0,
    onTriggerAbandoned: (listener) => admission.onReleased(listener),
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
