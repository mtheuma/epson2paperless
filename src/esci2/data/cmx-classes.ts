// src/esci2/data/cmx-classes.ts
//
// AUTO-GENERATED-LITERAL data module. Each class is the 24-byte #CMX...
// segment captured verbatim from:
//   - et2750-um08: buildParaFlatbedPlain() in commands.ts, offsets 864..888.
//   - xp7100-jpg:  xp-7100-fixtures/jpg-flatbed.bin, offsets 864..888.
//   - xp7100-pdf:  xp-7100-fixtures/pdf-single.bin, offsets 864..888.

export type CmxClassName = "et2750-um08" | "xp7100-jpg" | "xp7100-pdf";

export const CMX_CLASSES: Readonly<Record<CmxClassName, Buffer>> = {
  "et2750-um08": Buffer.from("23434d58554d303868303039200000002000000020000000", "hex"),
  "xp7100-jpg":  Buffer.from("23434d58554d303868303039210184001f00810024000000", "hex"),
  "xp7100-pdf":  Buffer.from("23434d58554d303868303039200000002000000020000000", "hex"),
};
