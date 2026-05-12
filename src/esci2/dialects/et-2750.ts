import { buildParaPayload } from "../commands.js";
import type { Dialect, ParaAxes } from "../dialect.js";

/**
 * Epson ET-2750 (ESC/I-2 over plain TCP). Flatbed-only hardware — no ADF,
 * no duplex. Wire bytes from
 * tools/pcap-extract/captures/et-2750/flatbed-single-page-pdf.jsonl.
 *
 * INIT_POLL is 2 cycles (vs 3 for TLS family); sending a third FS Y after
 * the printer has moved on returns a non-ACK. See protocol-decode notes
 * at .reference/wireshark-captures/et-2750/protocol-decode.md.
 */
export const et2750Dialect: Dialect = {
  // Computed from the ET-2750 pcap-extracted CAPA body.
  // Re-derive: see Task 5 step 1 of the plan.
  capaFingerprint: "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7",
  displayName: "ET-2750 (ESC/I-2 over plain TCP)",
  hardware: { flatbed: true, adf: false, duplex: false },
  sourceDetection: "fixed-flatbed",
  initPollIterations: 2,
  buildPara(axes: ParaAxes): Buffer {
    if (axes.source === "adf") {
      throw new Error(
        `et2750Dialect.buildPara: source=adf is not supported (ET-2750 has no ADF hardware)`,
      );
    }
    return buildParaPayload({
      source: "flatbed",
      duplex: false,
      profile: "esci2-plain",
    });
  },
};
