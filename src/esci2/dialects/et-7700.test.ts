import { describe, it, expect } from "vitest";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";
import { CMX_CLASSES } from "../data/cmx-classes.js";
import { GAMMA_CLASSES } from "../data/gamma-classes.js";
import { recordedDialect } from "../test-support/dialects.js";

const ET7700_FP = "72319314b621fea0aab6cc16f4fd891534cec08f33ce80116a849f6f6e1e58d4";
const entry = recordedDialect(ET7700_FP);

// The model override's static fields are asserted in model-overrides.test.ts alongside
// the other dialects. This file covers only what's specific to the ET-7700's
// composed PARA. The ET-7700 is an A4 EcoTank Photo (flatbed-only, ESC/I-2 over
// plain TCP), speculative from the issue #145 diagnostic and shaped like the
// ET-8500: the optional #QITOFF segment and an 804-byte gamma triplet, so its
// flatbed PARA is the ET-8500's 944 bytes. It sends a neutral pair: the
// XP-7100's xp7100-pdf tone curve with the identity colour matrix. Its replay
// fixtures record the earlier pair; scanner.test.ts pins the difference.

describe("ET-7700 composed PARA size", () => {
  it("flatbed is 944 bytes (ET-4800's 936 + 8 for the #QITOFF segment)", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(944);
  });
});

describe("ET-7700 action invariance", () => {
  it("flatbed JPG equals flatbed PDF byte-for-byte", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });
});

describe("ET-7700 neutral colour pair", () => {
  it.each(["jpg", "pdf"] as const)(
    "%s PARA carries the xp7100-pdf tone curve and the identity matrix, in UG18",
    (action) => {
      const para = composePara(makeParaSpec(entry, "flatbed", action));
      expect(para.includes("#GMMUG18")).toBe(true);
      expect(para.includes(GAMMA_CLASSES["xp7100-pdf"])).toBe(true);
      expect(para.includes(CMX_CLASSES["identity-um08"])).toBe(true);
    },
  );
});
