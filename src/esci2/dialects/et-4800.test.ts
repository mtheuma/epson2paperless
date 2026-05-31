import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET4800_FP = "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2";
const entry = REGISTRY.get(ET4800_FP)!;

// The registry entry's static fields (source detection, gmm, classes, extents,
// optional segments) are asserted in registry.test.ts alongside the other
// dialects. This file covers only what's specific to ET-4800's composed PARA.

describe("ET-4800 composed PARA size", () => {
  it("flatbed is 936 bytes", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(936);
  });

  it("adf-simplex is 944 bytes (+8 for the ADF-only #PAGd000 segment)", () => {
    expect(composePara(makeParaSpec(entry, "adf-simplex", "jpg")).length).toBe(944);
  });
});

describe("ET-4800 action invariance", () => {
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
