import { describe, it, expect } from "vitest";
import { lookupDialect, DIALECTS, buildDiagnostic } from "./dialect-registry.js";
import { et4950FamilyDialect } from "./dialects/et-4950-family.js";
import { et2750Dialect } from "./dialects/et-2750.js";
import { UnsupportedDialectError } from "./dialect.js";
import { computeCapaFingerprint } from "./capa-fingerprint.js";

describe("dialect registry", () => {
  it("includes ET-4950 family and ET-2750", () => {
    expect(DIALECTS).toContain(et4950FamilyDialect);
    expect(DIALECTS).toContain(et2750Dialect);
  });

  it("looks up dialects by fingerprint", () => {
    expect(lookupDialect(et4950FamilyDialect.capaFingerprint)).toBe(et4950FamilyDialect);
    expect(lookupDialect(et2750Dialect.capaFingerprint)).toBe(et2750Dialect);
  });

  it("returns null for unknown fingerprints", () => {
    expect(lookupDialect("0".repeat(64))).toBeNull();
  });

  it("each registered dialect has a unique fingerprint", () => {
    const fingerprints = DIALECTS.map((d) => d.capaFingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});

describe("buildDiagnostic", () => {
  it("populates every spec-required field", () => {
    const info = Buffer.from(
      "#ADFAREAd850i0001400#FB AREAd850i0001170#PRDh010PID 1147        #VERh008FB  2.00",
      "ascii",
    );
    const capa = Buffer.from(
      "#GMMLISTUG10UG18#CMXLISTUNITUM08#QITLISTPREFON  OFF #ADFDPLX",
      "ascii",
    );
    const diagnostic = buildDiagnostic({
      capaBody: capa,
      infoBody: info,
      transport: "plain",
      fingerprint: "abc123",
    });
    expect(diagnostic).toContain("PID 1147");
    expect(diagnostic).toContain("FB  2.00");
    expect(diagnostic).toContain("esci2-plain");
    // Source caps line — derived from INFO + CAPA segment presence.
    expect(diagnostic).toMatch(/Source caps:.*flatbed: Y.*ADF: Y.*duplex: Y/);
    expect(diagnostic).toContain("d850i0001170"); // FB scan area
    expect(diagnostic).toContain("d850i0001400"); // ADF scan area
    expect(diagnostic).toContain("UG10UG18");
    expect(diagnostic).toContain("UNITUM08");
    expect(diagnostic).toContain("abc123");
  });

  it("marks ADF/duplex as N for a flatbed-only printer", () => {
    const info = Buffer.from("#FB AREAd850i0001170#PRDh010PID 112A", "ascii");
    const capa = Buffer.from("#GMMLISTUG10UG18", "ascii"); // no #ADFDPLX
    const diagnostic = buildDiagnostic({
      capaBody: capa,
      infoBody: info,
      transport: "plain",
      fingerprint: "def456",
    });
    expect(diagnostic).toMatch(/Source caps:.*flatbed: Y.*ADF: N.*duplex: N/);
    expect(diagnostic).toContain("(absent)"); // for the ADF scan-area row
  });

  it("throws an UnsupportedDialectError when explicitly raised", () => {
    expect(() => {
      throw new UnsupportedDialectError("xyz", "diagnostic body");
    }).toThrow(/xyz/);
  });
});

describe("unknown-dialect resolution", () => {
  it("yields UnsupportedDialectError when a foreign CAPA body's fingerprint isn't registered", () => {
    // A CAPA body that doesn't match any registered dialect's fingerprint.
    const foreignCapa = Buffer.from("#GMMLISTUG10#WHATEVER1234", "ascii");
    const foreignInfo = Buffer.from("#PRDh010PID FFFF        #VERh008XX  9.99", "ascii");
    const fingerprint = computeCapaFingerprint(foreignCapa);
    // Sanity-check: this fingerprint is genuinely unknown.
    expect(lookupDialect(fingerprint)).toBeNull();
    // Build the diagnostic the graph would build, wrap it in the error type
    // the graph would emit, assert the type and message contents.
    const diagnostic = buildDiagnostic({
      capaBody: foreignCapa,
      infoBody: foreignInfo,
      transport: "plain",
      fingerprint,
    });
    const err = new UnsupportedDialectError(fingerprint, diagnostic);
    expect(err).toBeInstanceOf(UnsupportedDialectError);
    expect(err.capaFingerprint).toBe(fingerprint);
    expect(err.message).toContain(fingerprint);
    expect(err.message).toContain("PID FFFF"); // diagnostic block embedded
  });
});
