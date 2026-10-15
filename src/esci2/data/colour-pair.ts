// src/esci2/data/colour-pair.ts
//
// The colour-pair rule. A PARA's tone curve (#GMT) and colour matrix (#CMX)
// are chosen together, and a valid pair is one of:
//   - a neutral pair: identity matrix + gray-balance-only tone curve, leaving
//     colour to the host;
//   - an Epson-look pair: the model's own colour matrix + contrast tone curve;
//   - SoC-style: gamma mode UG10 and no colour matrix at all (the ET-4950
//     family), where the printer is sent a tone curve only.
// A mixed pair, one half of each, is never valid. Tone curves carry their
// look as a hand tag (GAMMA_CLASS_LOOK); matrices are classified from their
// bytes (cmxClassLook).

import { GAMMA_CLASS_LOOK, type GammaClassName } from "./gamma-classes.js";
import { cmxClassLook, type CmxClassName } from "./cmx-classes.js";

export type ColourLook = "neutral" | "epson-look";

export interface ColourPair {
  gmm: string;
  gamma: GammaClassName;
  cmx: CmxClassName | null;
}

export type ColourPairVerdict =
  | { valid: true; kind: ColourLook | "soc-style" }
  | { valid: false; reason: string };

export function checkColourPair(pair: ColourPair): ColourPairVerdict {
  if (pair.cmx === null) {
    if (pair.gmm === "UG10") return { valid: true, kind: "soc-style" };
    return {
      valid: false,
      reason: `no colour matrix with gamma mode ${pair.gmm}; only SoC-style (UG10) omits it`,
    };
  }
  const toneCurve = GAMMA_CLASS_LOOK[pair.gamma];
  const matrix = cmxClassLook(pair.cmx);
  if (toneCurve !== matrix) {
    return {
      valid: false,
      reason: `mixed pair: ${pair.gamma} tone curve is ${toneCurve}, ${pair.cmx} matrix is ${matrix}`,
    };
  }
  return { valid: true, kind: toneCurve };
}
