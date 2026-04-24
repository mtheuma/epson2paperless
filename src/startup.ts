import { isPaperlessEnabled, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { getLocalIpForTarget } from "./network.js";
import { createKeepaliveResponder, type KeepaliveResponder } from "./keepalive.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";

const log = createLogger("startup");

export function logStartupBanner(config: Config, modeMessage: string): void {
  log.info(modeMessage);
  log.info(`Printer IP: ${config.printerIp}`);
  log.info(`Destination name: ${config.scanDestName}`);
  log.info(`Output directory: ${config.outputDir}`);

  if (isPaperlessEnabled(config)) {
    const retention = config.paperlessDeleteAfterUpload
      ? "local files deleted after successful upload"
      : "local files retained";
    log.info(`Paperless upload: enabled (${config.paperlessUrl}) — ${retention}`);
  } else if (config.paperlessUrl || config.paperlessToken) {
    log.warn(
      "Paperless upload disabled: both PAPERLESS_URL and PAPERLESS_TOKEN (or PAPERLESS_TOKEN_FILE) must be set",
    );
  } else {
    log.info("Paperless upload: disabled (no PAPERLESS_URL/PAPERLESS_TOKEN)");
  }

  if (config.printerCertFingerprint) {
    log.info(
      `Printer cert pinning: enabled (sha256 ${config.printerCertFingerprint.slice(0, 8)}…)`,
    );
  } else {
    log.info("Printer cert pinning: disabled (set PRINTER_CERT_FINGERPRINT to enable)");
  }
}

export async function startPrinterDiscovery(config: Config): Promise<KeepaliveResponder> {
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
  return responder;
}

export function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception — exiting", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection (not exiting)", reason);
  });
}

export function buildPaperlessOptions(config: Config): PaperlessUploadOptions | undefined {
  if (!isPaperlessEnabled(config)) return undefined;
  return {
    url: config.paperlessUrl,
    token: config.paperlessToken,
    deleteAfterUpload: config.paperlessDeleteAfterUpload,
  };
}
