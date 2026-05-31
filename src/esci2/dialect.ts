/**
 * Scan parameters that vary per-session. The dialect's `buildPara` consumes
 * these to produce the byte-exact PARA body for that combination.
 */
export interface ParaAxes {
  source: "flatbed" | "adf";
  duplex: boolean;
  action: "jpg" | "pdf";
}

/**
 * What a printer model's wire dialect carries. Selected at runtime by
 * sha256 fingerprint of the printer's CAPA#1 reply. Every wire behaviour
 * that was previously implicit in the transport profile lives here.
 */
export interface Dialect {
  /** sha256 hex of canonicalised CAPA#1 segments. The registry key. */
  readonly capaFingerprint: string;
  /** Human-readable label for logs and diagnostics; never used for dispatch. */
  readonly displayName: string;
  /**
   * Informational metadata describing what hardware the dialect supports.
   * Not consulted by the runtime — each dialect's `buildPara` is responsible
   * for guarding its own unsupported axes (e.g. ET-2750's flatbed-only check).
   * Reserved for future capability-aware paths (panel-state validation,
   * config-time hardware checks, diagnostic enrichment).
   */
  readonly hardware: { flatbed: boolean; adf: boolean; duplex: boolean };
  /**
   * How source is determined at INIT_POLL_STAT.
   * - "stat-length": header.length===0 → adf, header.length===12 → flatbed.
   * - "fixed-flatbed": no detection — trust the pre-set source value.
   */
  readonly sourceDetection: "stat-length" | "fixed-flatbed";
  /**
   * Scanner's chosen FS Y init-poll iteration count before MODE_SWITCH.
   * The printer accepts any reasonable count; the dialect picks a small
   * one and replay fixtures get trimmed to match.
   */
  readonly initPollIterations: number;
  /** Builds the byte-exact PARA body for the given scan axes. */
  buildPara(axes: ParaAxes): Buffer;
}

export { UnsupportedDialectError } from "./diagnostic.js";
