// src/esci2/dialects/registry.test.ts
import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";

describe("REGISTRY", () => {
  it("contains exactly four known fingerprints", () => {
    expect(REGISTRY.size).toBe(4);
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
});
