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
   * What hardware the dialect supports. `buildPara` throws when called for
   * an unsupported axis (e.g. source=adf on a flatbed-only dialect).
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

/**
 * Thrown when a session lands on a printer whose CAPA fingerprint isn't
 * in the registry. Carries enough context for the user to file an issue
 * that the maintainer can act on.
 */
export class UnsupportedDialectError extends Error {
  constructor(
    public readonly capaFingerprint: string,
    public readonly diagnostic: string,
  ) {
    super(
      `Unsupported printer CAPA fingerprint ${capaFingerprint}. ` +
        `Please file an issue with the diagnostic block below:\n\n${diagnostic}`,
    );
    this.name = "UnsupportedDialectError";
  }
}
