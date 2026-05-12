import { describe, it, expect } from "vitest";
import { et4950FamilyDialect } from "./et-4950-family.js";
import { buildParaPayload } from "../commands.js";

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

  describe("buildPara byte-equivalence with today's buildParaPayload", () => {
    it("flatbed JPG matches buildParaPayload(profile=esci2-tls, source=flatbed)", () => {
      const fromDialect = et4950FamilyDialect.buildPara({
        source: "flatbed",
        duplex: false,
        action: "jpg",
      });
      const fromLegacy = buildParaPayload({
        source: "flatbed",
        duplex: false,
        profile: "esci2-tls",
      });
      expect(fromDialect.equals(fromLegacy)).toBe(true);
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

    it("ADF simplex matches buildParaPayload(profile=esci2-tls, source=adf, duplex=false)", () => {
      const fromDialect = et4950FamilyDialect.buildPara({
        source: "adf",
        duplex: false,
        action: "jpg",
      });
      const fromLegacy = buildParaPayload({
        source: "adf",
        duplex: false,
        profile: "esci2-tls",
      });
      expect(fromDialect.equals(fromLegacy)).toBe(true);
    });

    it("ADF duplex matches buildParaPayload(profile=esci2-tls, source=adf, duplex=true)", () => {
      const fromDialect = et4950FamilyDialect.buildPara({
        source: "adf",
        duplex: true,
        action: "jpg",
      });
      const fromLegacy = buildParaPayload({
        source: "adf",
        duplex: true,
        profile: "esci2-tls",
      });
      expect(fromDialect.equals(fromLegacy)).toBe(true);
    });
  });
});
