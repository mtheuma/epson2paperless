import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET2810_FP = "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e";
const entry = REGISTRY.get(ET2810_FP)!;

// The registry entry's static fields are asserted in registry.test.ts alongside
// the other dialects. This file covers only what's specific to the ET-2810's
// composed PARA. The ET-2810 is an entry-level A4 EcoTank (flatbed-only,
// ESC/I-2 over plain TCP). Its CAPA is ET-4800-shaped — same FB AREA
// ("d850i0001170"), same CMX (UNITUM08), QIT/CCT absent — so its flatbed PARA
// is the ET-4800's 936 bytes.

describe("ET-2810 composed PARA size", () => {
  it("flatbed is 936 bytes (matches the ET-4800's flatbed PARA)", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(936);
  });
});

describe("ET-2810 action invariance", () => {
  it("flatbed JPG equals flatbed PDF byte-for-byte", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });
});

describe("ET-2810 PARA equivalence with the ET-4800", () => {
  it("flatbed PARA is byte-identical to the ET-4800's", () => {
    const et4800 = REGISTRY.get(
      "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2",
    )!;
    const a = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const b = composePara(makeParaSpec(et4800, "flatbed", "jpg"));
    expect(a.equals(b)).toBe(true);
  });
});
