import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const WF3835_FP = "860a899be9dc4fc27b68f8aed21a49ccfe87733a3974813f0c2ade6810e89dc7";
const entry = REGISTRY.get(WF3835_FP)!;

// The registry entry's static fields are asserted in registry.test.ts alongside
// the other dialects. This file covers only what's specific to the WF-3835's
// composed PARA. The WF-3835 is an A4 WorkForce office AIO (flatbed + ADF
// simplex, plain TCP), speculative from the issue #174 diagnostic: an
// ET-15000-shaped dialect that additionally carries the optional #QITOFF
// segment — so its PARA sizes are the ET-4800/ET-15000's plus 8.

describe("WF-3835 composed PARA size", () => {
  it("flatbed is 944 bytes (ET-4800's 936 + 8 for the #QITOFF segment)", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(944);
  });

  it("adf-simplex is 952 bytes (+8 for the ADF-only #PAGd000 segment)", () => {
    expect(composePara(makeParaSpec(entry, "adf-simplex", "jpg")).length).toBe(952);
  });
});

describe("WF-3835 action invariance", () => {
  it("flatbed JPG equals flatbed PDF byte-for-byte", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });

  it("ADF simplex JPG equals ADF simplex PDF byte-for-byte", () => {
    const jpg = composePara(makeParaSpec(entry, "adf-simplex", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "adf-simplex", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });
});
