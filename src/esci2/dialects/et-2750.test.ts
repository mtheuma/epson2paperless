import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET2750_FP = "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7";
const entry = REGISTRY.get(ET2750_FP)!;

describe("ET-2750 registry entry", () => {
  it("is flatbed-only (no ADF extents)", () => {
    expect(entry.adfExtents).toBeNull();
  });

  it("uses fixed-flatbed source detection", () => {
    expect(entry.sourceDetection).toBe("fixed-flatbed");
  });

  it("uses 2 init-poll iterations", () => {
    expect(entry.initPollIterations).toBe(2);
  });
});

describe("ET-2750 composed PARA", () => {
  it("flatbed JPG matches flatbed PDF (action-invariant)", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });

  it("composer throws on adf-simplex (no adfExtents)", () => {
    expect(() => composePara(makeParaSpec(entry, "adf-simplex", "jpg"))).toThrow(
      /adf.*adfExtents/i,
    );
  });
});
