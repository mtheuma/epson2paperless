import { loadConfig } from "./config.js";
import { setLogLevel, setLogFormat, createLogger } from "./logger.js";
import { runScanNowLifecycle } from "./lifecycle.js";
import {
  logStartupBanner,
  installCrashHandlers,
  buildPaperlessOptions,
  dispatchScanSession,
} from "./startup.js";

const log = createLogger("scan-now");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  setLogFormat(config.logFormat);

  logStartupBanner(config, "epson2paperless scan-now — host-triggered single scan");
  installCrashHandlers();

  // No panel to ask, so the env-var fallbacks decide. Same vars the FF-680W
  // job-number branch already uses (see resolveScanDispatch in startup.ts).
  const duplex = config.scanSides === "duplex";
  const action = config.scanFormat;
  log.info(
    `Starting host-triggered scan (SCAN_SIDES=${config.scanSides}, SCAN_FORMAT=${action}) — ` +
      `no discovery, no push-scan listener`,
  );

  const scan = dispatchScanSession({
    config,
    duplex,
    action,
    paperless: buildPaperlessOptions(config),
  });

  const signalled = new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });

  const exitCode = await runScanNowLifecycle({
    scan,
    signalled,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
