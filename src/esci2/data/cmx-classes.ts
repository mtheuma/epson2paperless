// src/esci2/data/cmx-classes.ts
//
// AUTO-GENERATED-LITERAL data module. Each class is the 24-byte #CMX...
// segment captured verbatim from:
//   - et2750-um08: tools/pcap-extract/captures/et-2750/flatbed-single-page-pdf.jsonl, PARA body offsets 864..888.
//   - xp7100-jpg:  xp-7100-fixtures/jpg-flatbed.bin, offsets 864..888.
//   - xp7100-pdf:  xp-7100-fixtures/pdf-single.bin, offsets 864..888.
//   - et4800-um08: tools/pcap-extract/captures/et-4800/flatbed-jpg.jsonl, PARA body offsets 864..888.
// identity-um08 is a name, not a capture: the identity matrix, the et2750-um08
// bytes (which the xp7100-pdf capture also carries), for an override whose
// record should say it sends the identity matrix rather than whose it is.

import type { ColourLook } from "./colour-look.js";

export type CmxClassName =
  | "et2750-um08"
  | "xp7100-jpg"
  | "xp7100-pdf"
  | "et4800-um08"
  | "identity-um08";

const ET2750_UM08 = Buffer.from("23434d58554d303868303039200000002000000020000000", "hex");

export const CMX_CLASSES: Readonly<Record<CmxClassName, Buffer>> = {
  "et2750-um08": ET2750_UM08,
  "xp7100-jpg": Buffer.from("23434d58554d303868303039210184001f00810024000000", "hex"),
  "xp7100-pdf": Buffer.from("23434d58554d303868303039200000002000000020000000", "hex"),
  // payload 20 01 84 00 1f 00 00 00 24 00 00 00 — distinct from et2750 + xp7100.
  "et4800-um08": Buffer.from("23434d58554d303868303039200184001f00000024000000", "hex"),
  "identity-um08": ET2750_UM08,
};

// Every class is the 12-byte "#CMXUM08h009" header followed by nine one-byte
// coefficients (h009, a 3×3 matrix) and three zero bytes of padding. 0x20 is
// the diagonal value of the identity matrix, as the ET-2750 and XP-7100 PDF
// captures carry it.
const UM08_HEADER = Buffer.from("#CMXUM08h009", "ascii");
const UNITY = 0x20;
const DIAGONAL = new Set([0, 4, 8]);

/**
 * Whether a #CMX segment is the identity matrix, judged from its bytes alone.
 * Throws on any other matrix format: its identity form is unknown, so it can't
 * be classified either way.
 */
export function isIdentityCmx(segment: Buffer): boolean {
  if (segment.length !== 24 || !segment.subarray(0, 12).equals(UM08_HEADER)) {
    const header = segment.subarray(0, 12).toString("ascii");
    throw new Error(`isIdentityCmx: unknown matrix format ${header} (${segment.length} bytes)`);
  }
  return segment.subarray(12).every((byte, i) => byte === (DIAGONAL.has(i) ? UNITY : 0));
}

/** An identity matrix leaves colour to the host; any other is the model's own colour profile. */
export function cmxClassLook(name: CmxClassName): ColourLook {
  return isIdentityCmx(CMX_CLASSES[name]) ? "neutral" : "epson-look";
}
