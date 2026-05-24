import { buildParaFlatbedTls } from "../commands.js";
import type { Dialect, ParaAxes } from "../dialect.js";

/**
 * Epson ET-2950 (ESC/I-2 over TLS). Flatbed-only hardware — no ADF, no
 * duplex.
 *
 * **Inferred clean-room support — no captured ET-2950 fixture exists.**
 * The PARA bytes are reused from `buildParaFlatbedTls()` (the ET-4950
 * family flatbed body) because the ET-2950's diagnostic CAPA tokens match
 * the ET-4950's on every axis that drives PARA: `GMM=UG10UG18`,
 * `CMX=UNITUM08`, `QIT=PREFON  OFF`, `FMT=RAW JPG`. The Epson Scan 2
 * Linux source (see `.reference/research/epson-scan-2-source-findings.md`,
 * read clean-room by a sibling agent) shows that the PARA serialiser is
 * a single token-walking switch — per-printer variation comes purely
 * from which CAPA tokens are advertised and which host-driver setters
 * were called. With ET-2950's CAPA matching ET-4950's, the host driver
 * should produce byte-identical PARA.
 *
 * Two acknowledged residual uncertainties (any can fail with a generic
 * `Validation failed in state PARA` rather than a specific `#parFAIL`):
 *
 *   1. CCT advertisement. The findings doc enumerates a 928-byte form
 *      (ET-4950-equivalent, includes `#CCTCOL `) and a 920-byte form
 *      (without). The reporter's diagnostic predates `#CCTLIST` parsing,
 *      so we ship the 928-byte form; subsequent reporters will surface
 *      CCT presence/absence in their diagnostic block.
 *   2. `initPollIterations: 3`. The ET-4950 family uses 3, ET-2750 uses
 *      2 (rejects a 3rd poll). ET-2950 firmware is unknown; we pick the
 *      TLS-family value.
 *   3. `#FB AREA d850i0001170` undecoded (the reporter's diagnostic
 *      shape differs from ET-4950's 3-integer form). We inherit
 *      ET-4950's full-A4-at-300-DPI `#ACQ` extents; if the printer's
 *      actual max area is smaller, PARA validation will fail.
 *
 * Any of these failure modes is non-destructive — the engine aborts and
 * unlocks via the transport adapter. Issue #92 tracks reporter follow-up.
 */
export const et2950Dialect: Dialect = {
  // From the diagnostic block in issue #92 (the user's printer's CAPA
  // fingerprint, not derived from any captured fixture).
  capaFingerprint: "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
  displayName: "ET-2950 (ESC/I-2 over TLS)",
  hardware: { flatbed: true, adf: false, duplex: false },
  sourceDetection: "fixed-flatbed",
  initPollIterations: 3,
  buildPara(axes: ParaAxes): Buffer {
    if (axes.source === "adf") {
      throw new Error(
        `et2950Dialect.buildPara: source=adf is not supported (ET-2950 has no ADF hardware)`,
      );
    }
    return buildParaFlatbedTls();
  },
};
