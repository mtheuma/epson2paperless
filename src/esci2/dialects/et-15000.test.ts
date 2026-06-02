import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET15000_FP = "d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55";
const entry = REGISTRY.get(ET15000_FP)!;

// The registry entry's static fields are asserted in registry.test.ts alongside
// the other dialects. This file covers only what's specific to ET-15000's
// composed PARA. The ET-15000 is an A4 EcoTank (flatbed + ADF simplex, no
// duplex) on plain TCP, structurally identical to the ET-4800 — so its PARA
// sizes match the ET-4800's.

describe("ET-15000 composed PARA size", () => {
  it("flatbed is 936 bytes", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(936);
  });

  it("adf-simplex is 944 bytes (+8 for the ADF-only #PAGd000 segment)", () => {
    expect(composePara(makeParaSpec(entry, "adf-simplex", "jpg")).length).toBe(944);
  });
});

describe("ET-15000 action invariance", () => {
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
