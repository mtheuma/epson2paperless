import { buildParaPayload } from "../commands.js";
import type { Dialect, ParaAxes } from "../dialect.js";

/**
 * ET-4950 / ET-3950 / ET-4956 family (ESC/I-2 over TLS).
 * Wire bytes are transcribed from the ET-4950 Frida capture; the other
 * family members are assumed to share the same CAPA fingerprint and PARA
 * shape (no captures yet for those, will be verified if/when a report
 * arrives).
 *
 * PARA is action-invariant on this family: JPG and PDF actions both
 * produce byte-identical wire bytes. PDF is composed host-side from a
 * JPG-format scan.
 */
export const et4950FamilyDialect: Dialect = {
  // Computed from the ET-4950 Frida-capture CAPA#1 body.
  // Re-derive: see Task 4 step 1 of the plan.
  capaFingerprint: "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
  displayName: "ET-4950 family (ESC/I-2 over TLS)",
  hardware: { flatbed: true, adf: true, duplex: true },
  sourceDetection: "stat-length",
  initPollIterations: 3,
  buildPara(axes: ParaAxes): Buffer {
    // Action is ignored — this family's wire is format-agnostic.
    return buildParaPayload({
      source: axes.source,
      duplex: axes.duplex,
      profile: "esci2-tls",
    });
  },
};
