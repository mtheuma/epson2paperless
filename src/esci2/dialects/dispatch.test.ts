import { describe, it, expect } from "vitest";
import {
  lookupRegistryEntry,
  applyEntrySourceOverride,
  makeParaSpec,
  assertSourceSupported,
} from "./dispatch.js";
import { REGISTRY } from "./registry.js";
import { UnsupportedDialectError } from "../diagnostic.js";

const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";
const ET2750_FP = "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7";
const ET2810_FP = "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e";
const FF680W_FP = "5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd";
const UNKNOWN_FP = "0000000000000000000000000000000000000000000000000000000000000000";
const ET4800_FP = "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2";

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

  it("pins ctx.source = 'adf' for fixed-adf entries", () => {
    const entry = REGISTRY.get(FF680W_FP)!; // fixed-adf
    const ctx = { source: "flatbed" as "adf" | "flatbed", duplex: false };
    applyEntrySourceOverride(ctx, entry);
    expect(ctx.source).toBe("adf");
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

  it("projects FF-680W paraProfile", () => {
    const entry = REGISTRY.get(FF680W_FP)!;
    const spec = makeParaSpec(entry, "adf-duplex", "jpg");
    expect(spec.profile).toBe("ff680w-adf");
  });
});

describe("assertSourceSupported", () => {
  it("rejects adf-duplex on a simplex-only ADF", () => {
    const entry = REGISTRY.get(ET4800_FP)!;
    expect(() => assertSourceSupported(entry, "adf-duplex")).toThrow(/no duplex ADF/);
  });

  it("names the model and the fix in the error", () => {
    const entry = REGISTRY.get(ET4800_FP)!;
    expect(() => assertSourceSupported(entry, "adf-duplex")).toThrow(/ET-4800/);
    expect(() => assertSourceSupported(entry, "adf-duplex")).toThrow(/SCAN_SIDES=simplex/);
  });

  it("allows adf-simplex on a simplex-only ADF", () => {
    const entry = REGISTRY.get(ET4800_FP)!;
    expect(() => assertSourceSupported(entry, "adf-simplex")).not.toThrow();
  });

  it("allows adf-duplex on duplex-capable hardware", () => {
    const entry = REGISTRY.get(ET4950_FP)!;
    expect(() => assertSourceSupported(entry, "adf-duplex")).not.toThrow();
  });

  // Regression: the ET-2810 is flatbed-only and SCAN_SIDES defaults to "duplex",
  // so every default-config host-triggered scan on it arrives here with
  // duplex=true. The source resolves to flatbed, so duplex is inert and the
  // guard must not fire. An earlier design rejected on `duplex` at entry
  // resolution and broke exactly this case.
  it("allows flatbed on a flatbed-only entry even though duplex was requested", () => {
    const entry = REGISTRY.get(ET2810_FP)!;
    expect(() => assertSourceSupported(entry, "flatbed")).not.toThrow();
  });
});
