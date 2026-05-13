import { describe, it, expect } from "vitest";
import { et4950FamilyDialect } from "./et-4950-family.js";
import { buildParaFlatbedTls, buildParaAdf } from "../commands.js";

describe("et4950FamilyDialect", () => {
  it("has hardware {flatbed, adf, duplex} all true", () => {
    expect(et4950FamilyDialect.hardware).toEqual({ flatbed: true, adf: true, duplex: true });
  });

  it("uses stat-length source detection", () => {
    expect(et4950FamilyDialect.sourceDetection).toBe("stat-length");
  });

  it("uses 3 init-poll iterations", () => {
    expect(et4950FamilyDialect.initPollIterations).toBe(3);
  });

  describe("buildPara byte-equivalence with per-source builders", () => {
    it("flatbed JPG matches buildParaFlatbedTls()", () => {
      const fromDialect = et4950FamilyDialect.buildPara({
        source: "flatbed",
        duplex: false,
        action: "jpg",
      });
      expect(fromDialect.equals(buildParaFlatbedTls())).toBe(true);
    });

    it("flatbed PDF is byte-identical to flatbed JPG (action-invariant)", () => {
      const jpg = et4950FamilyDialect.buildPara({
        source: "flatbed",
        duplex: false,
        action: "jpg",
      });
      const pdf = et4950FamilyDialect.buildPara({
        source: "flatbed",
        duplex: false,
        action: "pdf",
      });
      expect(jpg.equals(pdf)).toBe(true);
    });

    it("ADF simplex matches buildParaAdf(false)", () => {
      const fromDialect = et4950FamilyDialect.buildPara({
        source: "adf",
        duplex: false,
        action: "jpg",
      });
      expect(fromDialect.equals(buildParaAdf(false))).toBe(true);
    });

    it("ADF duplex matches buildParaAdf(true)", () => {
      const fromDialect = et4950FamilyDialect.buildPara({
        source: "adf",
        duplex: true,
        action: "jpg",
      });
      expect(fromDialect.equals(buildParaAdf(true))).toBe(true);
    });
  });
});
