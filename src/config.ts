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
  language: z.string().length(2).default("en"),
  previewAction: z.enum(["reject", "jpg", "pdf"]).default("reject"),
  tempDir: z.string().default(""),
  shutdownTimeoutMs: z.coerce.number().int().min(100).default(30000),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const raw = {
    printerIp: process.env.PRINTER_IP,
    scanDestName: process.env.SCAN_DEST_NAME || undefined,
    scanDestId: process.env.SCAN_DEST_ID ? parseInt(process.env.SCAN_DEST_ID, 16) : undefined,
    outputDir: process.env.OUTPUT_DIR || undefined,
    keepaliveInterval: process.env.KEEPALIVE_INTERVAL || undefined,
    healthPort: process.env.HEALTH_PORT || undefined,
    logLevel: process.env.LOG_LEVEL || undefined,
    language: process.env.LANGUAGE || undefined,
    previewAction: process.env.PREVIEW_ACTION || undefined,
    tempDir: process.env.TEMP_DIR || undefined,
    shutdownTimeoutMs: process.env.SHUTDOWN_TIMEOUT_MS || undefined,
  };

  return configSchema.parse(raw);
}
