import { readFileSync } from "node:fs";
import { z } from "zod";

const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;

const configSchema = z.object({
  printerIp: z
    .string({ error: "PRINTER_IP is required and must be a string" })
    .regex(ipv4Regex, "PRINTER_IP must be a valid IPv4 address"),
  scanDestName: z.string().default("Paperless"),
  // scanDestId is a hex byte (e.g. "02"); parsed in loadConfig.
  scanDestId: z.number().int().min(1).max(255).default(0x02),
  outputDir: z.string().default("/output"),
  keepaliveInterval: z.coerce.number().int().min(100).default(500),
  healthPort: z.coerce.number().int().min(1).max(65535).default(3000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  logFormat: z.enum(["text", "json"]).default("text"),
  language: z.string().length(2).default("en"),
  previewAction: z.enum(["reject", "jpg", "pdf"]).default("reject"),
  tempDir: z.string().default(""),
  shutdownTimeoutMs: z.coerce.number().int().min(100).default(30000),
  paperlessUrl: z.string().url("PAPERLESS_URL must be a valid URL").optional(),
  paperlessToken: z.string().optional(),
  paperlessDeleteAfterUpload: z.boolean().default(true),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  // Resolve PAPERLESS_TOKEN — PAPERLESS_TOKEN_FILE takes precedence when both
  // are set. A missing / unreadable _TOKEN_FILE is a startup error.
  let paperlessToken: string | undefined;
  if (process.env.PAPERLESS_TOKEN_FILE) {
    try {
      paperlessToken = readFileSync(process.env.PAPERLESS_TOKEN_FILE, "utf8").trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`PAPERLESS_TOKEN_FILE is set but cannot be read: ${msg}`);
    }
  } else if (process.env.PAPERLESS_TOKEN) {
    paperlessToken = process.env.PAPERLESS_TOKEN;
  }

  const raw = {
    printerIp: process.env.PRINTER_IP,
    scanDestName: process.env.SCAN_DEST_NAME || undefined,
    scanDestId: process.env.SCAN_DEST_ID ? parseInt(process.env.SCAN_DEST_ID, 16) : undefined,
    outputDir: process.env.OUTPUT_DIR || undefined,
    keepaliveInterval: process.env.KEEPALIVE_INTERVAL || undefined,
    healthPort: process.env.HEALTH_PORT || undefined,
    logLevel: process.env.LOG_LEVEL || undefined,
    logFormat: process.env.LOG_FORMAT || undefined,
    language: process.env.LANGUAGE || undefined,
    previewAction: process.env.PREVIEW_ACTION || undefined,
    tempDir: process.env.TEMP_DIR || undefined,
    shutdownTimeoutMs: process.env.SHUTDOWN_TIMEOUT_MS || undefined,
    paperlessUrl: process.env.PAPERLESS_URL || undefined,
    paperlessToken,
    // undefined → Zod default (true) applies. Explicit "true" / "false" override it.
    paperlessDeleteAfterUpload:
      process.env.PAPERLESS_DELETE_AFTER_UPLOAD === undefined
        ? undefined
        : process.env.PAPERLESS_DELETE_AFTER_UPLOAD === "true",
  };

  return configSchema.parse(raw);
}

export function isPaperlessEnabled(
  config: Config,
): config is Config & { paperlessUrl: string; paperlessToken: string } {
  return Boolean(config.paperlessUrl && config.paperlessToken);
}
