import { describe, it, expect } from "vitest";
import { lookupDialect, DIALECTS, buildDiagnostic } from "./dialect-registry.js";
import { et4950FamilyDialect } from "./dialects/et-4950-family.js";
import { et2750Dialect } from "./dialects/et-2750.js";
import { et2950Dialect } from "./dialects/et-2950.js";
import { xp7100Dialect } from "./dialects/xp-7100.js";
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

  it("includes XP-7100 in the registry", () => {
    expect(DIALECTS).toContain(xp7100Dialect);
    expect(lookupDialect(xp7100Dialect.capaFingerprint)).toBe(xp7100Dialect);
  });

  it("includes ET-2950 in the registry", () => {
    expect(DIALECTS).toContain(et2950Dialect);
    expect(lookupDialect(et2950Dialect.capaFingerprint)).toBe(et2950Dialect);
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
