// src/esci2/dialects/registry.test.ts
import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";

describe("REGISTRY", () => {
  it("contains exactly eight known fingerprints", () => {
    expect(REGISTRY.size).toBe(8);
  });

  it("includes ET-4950 family entry", () => {
    const e = REGISTRY.get("2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2");
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("stat-length");
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG10");
    expect(e!.optionalSegments).toEqual({ qit: true, cct: true });
    expect(e!.adfExtents).not.toBeNull();
  });

  it("includes ET-2750 entry", () => {
    const e = REGISTRY.get("de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7");
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("fixed-flatbed");
    expect(e!.initPollIterations).toBe(2);
    expect(e!.gmm).toBe("UG18");
    expect(e!.adfExtents).toBeNull();
    expect(e!.cmxClass.jpg).toBe("et2750-um08");
    expect(e!.optionalSegments).toEqual({ qit: false, cct: false });
  });

  it("includes XP-7100 entry", () => {
    const e = REGISTRY.get("56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e");
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("stat-length");
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass.jpg).toBe("xp7100-jpg");
    expect(e!.gammaClass.pdf).toBe("xp7100-pdf");
    expect(e!.cmxClass.jpg).toBe("xp7100-jpg");
    expect(e!.cmxClass.pdf).toBe("xp7100-pdf");
    expect(e!.optionalSegments).toEqual({ qit: true, cct: false });
  });

  it("includes ET-2950 entry that reuses ET-4950 LUT", () => {
    const e = REGISTRY.get("b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb");
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("fixed-flatbed");
    expect(e!.gammaClass).toEqual({ jpg: "et4950-stock", pdf: "et4950-stock" });
    expect(e!.cmxClass).toEqual({ jpg: null, pdf: null });
    expect(e!.adfExtents).toBeNull();
  });

  it("includes ET-4800 entry (flatbed + ADF simplex, plain TCP)", () => {
    const e = REGISTRY.get("7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2");
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("stat-length");
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "et4800-stock", pdf: "et4800-stock" });
    expect(e!.cmxClass).toEqual({ jpg: "et4800-um08", pdf: "et4800-um08" });
    expect(e!.optionalSegments).toEqual({ qit: false, cct: false });
    expect(e!.fbExtents).toEqual({ x0: 0, y0: 0, w: 2481, h: 3506 });
    expect(e!.adfExtents).toEqual({ x0: 69, y0: 0, w: 2481, h: 3506 });
  });

  it("includes ET-15000 entry (flatbed + ADF simplex, plain TCP)", () => {
    const e = REGISTRY.get("d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55");
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("stat-length");
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "et4800-stock", pdf: "et4800-stock" });
    expect(e!.cmxClass).toEqual({ jpg: "et4800-um08", pdf: "et4800-um08" });
    expect(e!.optionalSegments).toEqual({ qit: false, cct: false });
    expect(e!.fbExtents).toEqual({ x0: 0, y0: 0, w: 2481, h: 3506 });
    expect(e!.adfExtents).toEqual({ x0: 69, y0: 0, w: 2481, h: 3506 });
  });

  it("includes ET-8500 entry (flatbed-only, TLS; TLS-sibling gamma + ET-4800 CMX)", () => {
    const e = REGISTRY.get("05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467");
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("fixed-flatbed");
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "et4950-stock", pdf: "et4950-stock" });
    expect(e!.cmxClass).toEqual({ jpg: "et4800-um08", pdf: "et4800-um08" });
    expect(e!.optionalSegments).toEqual({ qit: true, cct: false });
    expect(e!.fbExtents).toEqual({ x0: 0, y0: 0, w: 2481, h: 3506 });
    expect(e!.adfExtents).toBeNull();
  });

  it("includes FF-680W entry (ADF-only, plain TCP)", () => {
    const e = REGISTRY.get("5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd");
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("fixed-adf");
    expect(e!.initPollIterations).toBe(8);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "ff680w-adf", pdf: "ff680w-adf" });
    expect(e!.cmxClass).toEqual({ jpg: "et2750-um08", pdf: "et2750-um08" });
    expect(e!.optionalSegments).toEqual({ qit: false, cct: false });
    expect(e!.paraProfile).toBe("ff680w-adf");
    expect(e!.adfExtents).toEqual({ x0: 0, y0: 0, w: 1700, h: 7200 });
  });
});
