import { describe, it, expect } from "vitest";
import { et2950Dialect } from "./et-2950.js";
import { buildParaFlatbedTls } from "../commands.js";

// Note on scope: there is no captured ET-2950 fixture. This file is a
// plumbing/provenance guard, not a printer-byte correctness fixture —
// unlike `et-2750.test.ts` and `et-4950-family.test.ts`, which anchor
// to bytes extracted from real-hardware captures. The PARA bytes are
// inherited from the ET-4950 flatbed builder on the basis of matching
// CAPA tokens (see the dialect-file comment for the full rationale).
// First real-hardware report against this dialect is the actual
// correctness check.
describe("et2950Dialect", () => {
  it("has flatbed-only hardware", () => {
    expect(et2950Dialect.hardware).toEqual({ flatbed: true, adf: false, duplex: false });
  });

  it("uses fixed-flatbed source detection", () => {
    expect(et2950Dialect.sourceDetection).toBe("fixed-flatbed");
  });

  it("uses 3 init-poll iterations (TLS-family default, unverified for this model)", () => {
    expect(et2950Dialect.initPollIterations).toBe(3);
  });

  it("flatbed JPG inherits buildParaFlatbedTls() bytes verbatim", () => {
    const fromDialect = et2950Dialect.buildPara({
      source: "flatbed",
      duplex: false,
      action: "jpg",
    });
    expect(fromDialect.equals(buildParaFlatbedTls())).toBe(true);
  });

  it("flatbed PDF is byte-identical to flatbed JPG (action-invariant on this family)", () => {
    const jpg = et2950Dialect.buildPara({ source: "flatbed", duplex: false, action: "jpg" });
    const pdf = et2950Dialect.buildPara({ source: "flatbed", duplex: false, action: "pdf" });
    expect(jpg.equals(pdf)).toBe(true);
  });

  it("throws on source=adf (hardware guard)", () => {
    expect(() => et2950Dialect.buildPara({ source: "adf", duplex: false, action: "jpg" })).toThrow(
      /adf.*not supported/i,
    );
  });

  it("fingerprint matches the one reported in issue #92", () => {
    expect(et2950Dialect.capaFingerprint).toBe(
      "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
    );
  });
});
