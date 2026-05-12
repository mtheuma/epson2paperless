import { describe, it, expect } from "vitest";
import { et2750Dialect } from "./et-2750.js";
import { buildParaPayload } from "../commands.js";

describe("et2750Dialect", () => {
  it("has flatbed-only hardware", () => {
    expect(et2750Dialect.hardware).toEqual({ flatbed: true, adf: false, duplex: false });
  });

  it("uses fixed-flatbed source detection", () => {
    expect(et2750Dialect.sourceDetection).toBe("fixed-flatbed");
  });

  it("uses 2 init-poll iterations", () => {
    expect(et2750Dialect.initPollIterations).toBe(2);
  });

  it("flatbed JPG matches buildParaPayload(profile=esci2-plain)", () => {
    const fromDialect = et2750Dialect.buildPara({
      source: "flatbed",
      duplex: false,
      action: "jpg",
    });
    const fromLegacy = buildParaPayload({
      source: "flatbed",
      duplex: false,
      profile: "esci2-plain",
    });
    expect(fromDialect.equals(fromLegacy)).toBe(true);
  });

  it("flatbed PDF is byte-identical to flatbed JPG", () => {
    const jpg = et2750Dialect.buildPara({ source: "flatbed", duplex: false, action: "jpg" });
    const pdf = et2750Dialect.buildPara({ source: "flatbed", duplex: false, action: "pdf" });
    expect(jpg.equals(pdf)).toBe(true);
  });

  it("throws on source=adf (hardware guard)", () => {
    expect(() => et2750Dialect.buildPara({ source: "adf", duplex: false, action: "jpg" })).toThrow(
      /adf.*not supported/i,
    );
  });
});
