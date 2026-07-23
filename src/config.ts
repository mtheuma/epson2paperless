import { readFileSync } from "node:fs";
import { z } from "zod";

// FF-680W CAPA-advertised resolutions (#RSMLIST). SCAN_RESOLUTION is validated
// against this set and consumed by the adf-crp dialects (FF-680W and DS-575W —
// their #RSM/#RSS/#ACQ fields scale with it). FF-680W 200/300 and DS-575W
// 400/600 are wire-verified by PARA capture; the rest rely on the linear
// DPI-scaling formula in para-composer.ts. Other models ignore SCAN_RESOLUTION
// and scan at their dialect's fixed resolution.
export const FF680W_RESOLUTIONS = [50, 75, 100, 150, 200, 240, 300, 360, 400, 600] as const;
export const DEFAULT_SCAN_RESOLUTION = 200;
export const DEFAULT_JPEG_QUALITY = 90;

// SCAN_COLOR_MODE selects colour vs greyscale. "grayscale" changes the wire
// request, and only greyscale-capable dialects (currently the DS-575W) act on
// it; all other models ignore it and scan in colour, so the default is
// "color". "auto" always scans in colour and decides per page in
// post-processing (any model): pages with no colour content are saved as
// greyscale, the rest stay colour.
export const DEFAULT_SCAN_COLOR_MODE = "color" as const;

// IPv4 dotted-quad — each octet bounded to 0-255 with no leading zeros on
// multi-digit values. Leading zeros are rejected at this layer because
// Node's `dgram.connect()` does NOT treat strings like `001.002.003.004`
// as IPv4 literals — it silently picks `0.0.0.0` as the local interface,
// and `getLocalIpForTarget()` returns `0.0.0.0` rather than failing
// loudly. Catching them here surfaces a clear "must be a valid IPv4
// address" error at startup instead of a confusing late binding failure.
const ipv4Regex =
  /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;

const configSchema = z
  .object({
    printerIp: z
      .string({ error: "PRINTER_IP is required and must be a string" })
      .regex(ipv4Regex, "PRINTER_IP must be a valid IPv4 address"),
    scanDestName: z.string().default("Paperless"),
    // scanDestId is a hex byte (e.g. "02"); parsed in loadConfig.
    scanDestId: z.number().int().min(1).max(255).default(0x02),
    outputDir: z.string().default("/output"),
    healthPort: z.coerce.number().int().min(1).max(65535).default(3000),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    logFormat: z.enum(["text", "json"]).default("text"),
    language: z.string().length(2).default("en"),
    jpegQuality: z.coerce.number().int().min(1).max(100).default(DEFAULT_JPEG_QUALITY),
    previewAction: z.enum(["reject", "jpg", "pdf"]).default("reject"),
    postProcess: z.enum(["none", "document"]).default("none"),
    // Panel-less fallbacks — consulted whenever no panel choice reaches us:
    // the FF-680W job-number flow, and every host-triggered scan (scan-now).
    scanFormat: z.enum(["jpg", "pdf"]).default("pdf"),
    scanSides: z.enum(["simplex", "duplex"]).default("duplex"),
    scanResolution: z.coerce
      .number()
      .int()
      .refine((v) => (FF680W_RESOLUTIONS as readonly number[]).includes(v), {
        message: `SCAN_RESOLUTION must be one of the advertised DPIs (FF-680W / DS-575W): ${FF680W_RESOLUTIONS.join(", ")}`,
      })
      .default(DEFAULT_SCAN_RESOLUTION),
    scanColorMode: z.enum(["color", "grayscale", "auto"]).default(DEFAULT_SCAN_COLOR_MODE),
    esciForceSource: z.enum(["flatbed", "adf-simplex", "adf-duplex"]).optional(),
    printerProtocol: z.enum(["auto", "esci2", "esci2-plain", "esci"]).default("auto"),
    // Diagnostic-only. When true and the legacy `ESC @` init returns a non-ACK,
    // the legacy scanner sends one extra `FS Y` probe (the ET-4950 ESC/I-2 path's
    // first command) before failing, and logs both replies in detail. Used to
    // help classify unsupported printers that get past welcome+lock but reject
    // `ESC @`. Should remain false in normal operation.
    diagnoseProtocol: z.boolean().default(false),
    // Compatibility-triage aid. `auto` picks the NetScanMonitor keepalive wire
    // format from the announced PID (3.0 for the FF-680W and DS-575W, 2.0 for
    // everything else — see V3_KEEPALIVE_PRODUCTS in keepalive.ts). Forcing
    // `3.0` lets reporters with other unrecognised button-only scanners (DS-series
    // family) test v3 registration without a code change; v3 also switches the
    // burst to an ephemeral source port (see keepalive.ts).
    netscanVersion: z.enum(["auto", "2.0", "3.0"]).default("auto"),
    tempDir: z.string().default(""),
    shutdownTimeoutMs: z.coerce.number().int().min(100).default(30000),
    paperlessUrl: z.string().url("PAPERLESS_URL must be a valid URL").optional(),
    paperlessToken: z.string().optional(),
    paperlessDeleteAfterUpload: z.boolean().default(true),
    printerCertFingerprint: z
      .string()
      .regex(
        /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i,
        "PRINTER_CERT_FINGERPRINT must be 32 colon-separated hex bytes (sha256, e.g. AB:CD:EF:…)",
      )
      .transform((s) => s.toUpperCase())
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    // PRINTER_CERT_FINGERPRINT only makes sense on the TLS path. Reject
    // the combo for both legacy plain-TCP variants (esci, esci2-plain),
    // and for `auto` (where a probe failure could downgrade silently to
    // a non-TLS path and bypass the pin).
    const noTlsProtocol = cfg.printerProtocol === "esci" || cfg.printerProtocol === "esci2-plain";
    if (noTlsProtocol && cfg.printerCertFingerprint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `PRINTER_CERT_FINGERPRINT is incompatible with PRINTER_PROTOCOL=${cfg.printerProtocol} (no TLS layer to verify).`,
        path: ["printerCertFingerprint"],
      });
    }
    if (cfg.printerProtocol === "auto" && cfg.printerCertFingerprint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "PRINTER_CERT_FINGERPRINT requires PRINTER_PROTOCOL=esci2 explicitly. Under PRINTER_PROTOCOL=auto, a probe failure can downgrade silently to a non-TLS path (esci2-plain or esci), which would bypass the pin.",
        path: ["printerCertFingerprint"],
      });
    }
    // ESCI_FORCE_SOURCE only applies to the legacy ESC/I scanner —
    // ESC/I-2 (TLS or plain) detects source via INIT_POLL_STAT.
    if (
      (cfg.printerProtocol === "esci2" || cfg.printerProtocol === "esci2-plain") &&
      cfg.esciForceSource
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ESCI_FORCE_SOURCE has no effect with PRINTER_PROTOCOL=${cfg.printerProtocol}; remove one or the other.`,
        path: ["esciForceSource"],
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  if (process.env.LEGACY_FORCE_SOURCE !== undefined) {
    throw new Error(
      "LEGACY_FORCE_SOURCE has been renamed to ESCI_FORCE_SOURCE in v0.4.0. " +
        "Please update your env / compose file. The values are unchanged " +
        "(adf-simplex / adf-duplex / flatbed).",
    );
  }

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
    healthPort: process.env.HEALTH_PORT || undefined,
    logLevel: process.env.LOG_LEVEL || undefined,
    logFormat: process.env.LOG_FORMAT || undefined,
    language: process.env.LANGUAGE || undefined,
    jpegQuality: process.env.JPEG_QUALITY || undefined,
    previewAction: process.env.PREVIEW_ACTION || undefined,
    postProcess: process.env.POST_PROCESS || undefined,
    scanFormat: process.env.SCAN_FORMAT || undefined,
    scanSides: process.env.SCAN_SIDES || undefined,
    scanResolution: process.env.SCAN_RESOLUTION || undefined,
    scanColorMode: process.env.SCAN_COLOR_MODE || undefined,
    tempDir: process.env.TEMP_DIR || undefined,
    shutdownTimeoutMs: process.env.SHUTDOWN_TIMEOUT_MS || undefined,
    paperlessUrl: process.env.PAPERLESS_URL || undefined,
    paperlessToken,
    // undefined → Zod default (true) applies. Explicit "true" / "false" override it.
    paperlessDeleteAfterUpload:
      process.env.PAPERLESS_DELETE_AFTER_UPLOAD === undefined
        ? undefined
        : process.env.PAPERLESS_DELETE_AFTER_UPLOAD === "true",
    esciForceSource: process.env.ESCI_FORCE_SOURCE || undefined,
    printerCertFingerprint: process.env.PRINTER_CERT_FINGERPRINT || undefined,
    printerProtocol: process.env.PRINTER_PROTOCOL || undefined,
    diagnoseProtocol:
      process.env.DIAGNOSE_PROTOCOL === undefined
        ? undefined
        : process.env.DIAGNOSE_PROTOCOL === "true",
    netscanVersion: process.env.NETSCAN_VERSION || undefined,
  };

  return configSchema.parse(raw);
}

export function isPaperlessEnabled(
  config: Config,
): config is Config & { paperlessUrl: string; paperlessToken: string } {
  return Boolean(config.paperlessUrl && config.paperlessToken);
}
