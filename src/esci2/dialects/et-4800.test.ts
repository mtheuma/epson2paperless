import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET4800_FP = "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2";
const entry = REGISTRY.get(ET4800_FP)!;

describe("ET-4800 registry entry", () => {
  it("supports flatbed + ADF simplex (non-null ADF extents, no duplex hardware)", () => {
    expect(entry.adfExtents).not.toBeNull();
    expect(entry.adfExtents).toEqual({ x0: 69, y0: 0, w: 2481, h: 3506 });
  });

  it("uses stat-length source detection (paper-presence based)", () => {
    expect(entry.sourceDetection).toBe("stat-length");
  });

  it("uses 3 init-poll iterations (ET-4950 recipe)", () => {
    expect(entry.initPollIterations).toBe(3);
  });

  it("uses the UG18 gamma constant", () => {
    expect(entry.gmm).toBe("UG18");
  });

  it("uses the et4800-specific gamma + cmx classes", () => {
    expect(entry.gammaClass).toEqual({ jpg: "et4800-stock", pdf: "et4800-stock" });
    expect(entry.cmxClass).toEqual({ jpg: "et4800-um08", pdf: "et4800-um08" });
  });

  it("omits the QIT/CCT optional segments", () => {
    expect(entry.optionalSegments).toEqual({ qit: false, cct: false });
  });
});

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
