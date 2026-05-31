import { describe, it, expect } from "vitest";
import { lookupRegistryEntry, applyEntrySourceOverride, makeParaSpec } from "./dispatch.js";
import { REGISTRY } from "./registry.js";
import { UnsupportedDialectError } from "../diagnostic.js";

const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";
const ET2750_FP = "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7";
const UNKNOWN_FP = "0000000000000000000000000000000000000000000000000000000000000000";

const ET4950_CAPA = Buffer.from("#GMMLISTUG10UG18#CMXLISTUNITUM08", "ascii"); // minimal stub
const ET4950_INFO = Buffer.from("#PRDh010PID 1147        #FB AREAd850i0001170", "ascii");

describe("lookupRegistryEntry", () => {
  it("returns the entry for a known fingerprint", () => {
    const e = lookupRegistryEntry(ET4950_FP, ET4950_CAPA, ET4950_INFO, "tls");
    expect(e).toBe(REGISTRY.get(ET4950_FP));
  });

  it("throws UnsupportedDialectError with diagnostic for an unknown fingerprint", () => {
    expect(() => lookupRegistryEntry(UNKNOWN_FP, ET4950_CAPA, ET4950_INFO, "plain")).toThrow(
      UnsupportedDialectError,
    );
  });

  it("the thrown error carries the fingerprint and diagnostic", () => {
    try {
      lookupRegistryEntry(UNKNOWN_FP, ET4950_CAPA, ET4950_INFO, "plain");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedDialectError);
      const e = err as UnsupportedDialectError;
      expect(e.capaFingerprint).toBe(UNKNOWN_FP);
      expect(e.diagnostic).toContain("CAPA fingerprint:");
      expect(e.diagnostic).toContain("esci2-plain");
    }
  });
});

describe("applyEntrySourceOverride", () => {
  it("pins ctx.source = 'flatbed' for fixed-flatbed entries", () => {
    const entry = REGISTRY.get(ET2750_FP)!; // fixed-flatbed
    const ctx = { source: "adf" as "adf" | "flatbed", duplex: false };
    applyEntrySourceOverride(ctx, entry);
    expect(ctx.source).toBe("flatbed");
  });

  it("leaves ctx.source unchanged for stat-length entries", () => {
    const entry = REGISTRY.get(ET4950_FP)!; // stat-length
    const ctx = { source: "adf" as "adf" | "flatbed", duplex: false };
    applyEntrySourceOverride(ctx, entry);
    expect(ctx.source).toBe("adf");
  });
});

describe("makeParaSpec", () => {
  it("projects entry + flatbed onto ParaSpec.fbExtents", () => {
    const entry = REGISTRY.get(ET4950_FP)!;
    const spec = makeParaSpec(entry, "flatbed", "jpg");
    expect(spec.source).toBe("flatbed");
    expect(spec.action).toBe("jpg");
    expect(spec.gmm).toBe("UG10");
    expect(spec.fbExtents).toEqual(entry.fbExtents);
    expect(spec.adfExtents).toEqual(entry.adfExtents);
    expect(spec.optionalSegments).toEqual({ qit: true, cct: true });
  });

  it("projects entry + adf-simplex correctly", () => {
    const entry = REGISTRY.get(ET4950_FP)!;
    const spec = makeParaSpec(entry, "adf-simplex", "jpg");
    expect(spec.source).toBe("adf-simplex");
  });

  it("projects entry + adf-duplex correctly", () => {
    const entry = REGISTRY.get(ET4950_FP)!;
    const spec = makeParaSpec(entry, "adf-duplex", "pdf");
    expect(spec.source).toBe("adf-duplex");
    expect(spec.action).toBe("pdf");
  });
});
