import { describe, it, expect } from "vitest";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";
import { CMX_CLASSES } from "../data/cmx-classes.js";
import { recordedDialect } from "../test-support/dialects.js";
import { changedParaSegments } from "../test-support/para-diff.js";

const ET8500_FP = "05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467";
const entry = recordedDialect(ET8500_FP);

// The model override's static fields are asserted in model-overrides.test.ts alongside
// the other dialects. This file covers only what's specific to the ET-8500's
// composed PARA. The ET-8500 is an A4 EcoTank Photo (flatbed-only, ESC/I-2 over
// both TLS and plain TCP across reporters). It sends a neutral pair: the
// et4950-stock tone curve with the identity colour matrix, and (unlike the
// ET-4800) the optional #QITOFF segment — every gamma triplet is 804 bytes, so
// its flatbed PARA is still the ET-4800's 936 bytes plus 8 for #QITOFF (944 total).

describe("ET-8500 composed PARA size", () => {
  it("flatbed is 944 bytes (ET-4800's 936 + 8 for the #QITOFF segment)", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(944);
  });
});

describe("ET-8500 action invariance", () => {
  it("flatbed JPG equals flatbed PDF byte-for-byte", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });
});

// No ET-8500 recording exists, so the neutral pair is pinned as a change
// against the mixed pair it replaced (the ET-4800's colour matrix): the PARA
// differs in #CMX and nowhere else. Its diagnostic records no resolution
// lists, so it is composed at every flatbed DPI the recorded ESC/I-2
// printers advertise between them.
describe("ET-8500 neutral colour pair", () => {
  const mixed = { ...entry, cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" } } as const;
  const DPIS = [50, 75, 100, 150, 200, 240, 300, 360, 400, 600, 1200];

  it.each(["jpg", "pdf"] as const)(
    "%s PARA differs from the mixed pair's only in #CMX, at every advertised DPI",
    (action) => {
      for (const dpi of DPIS) {
        const before = composePara(makeParaSpec(mixed, "flatbed", action, dpi));
        const after = composePara(makeParaSpec(entry, "flatbed", action, dpi));
        expect(changedParaSegments(before, after), `${action} @ ${dpi}`).toEqual(["CMX"]);
        expect(after.includes(CMX_CLASSES["identity-um08"]), `${action} @ ${dpi}`).toBe(true);
      }
    },
  );
});
