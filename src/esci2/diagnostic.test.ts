import { describe, it, expect } from "vitest";
import { buildDiagnostic, UnsupportedDialectError } from "./diagnostic.js";

describe("buildDiagnostic", () => {
  it("populates every spec-required field", () => {
    const info = Buffer.from(
      "#ADFAREAd850i0001400#FB AREAd850i0001170#PRDh010PID 1147        #VERh008FB  2.00",
      "ascii",
    );
    const capa = Buffer.from(
      "#GMMLISTUG10UG18#CMXLISTUNITUM08#QITLISTPREFON  OFF #CCTLISTCOL MONOPREF#ADFDPLX",
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
    expect(diagnostic).toContain("COL MONOPREF"); // CCT list surfaced
    expect(diagnostic).toContain("abc123");
  });

  it("marks ADF/duplex as N for a flatbed-only printer", () => {
    const info = Buffer.from("#FB AREAd850i0001170#PRDh010PID 112A", "ascii");
    const capa = Buffer.from("#GMMLISTUG10UG18", "ascii"); // no #ADFDPLX, no #CCTLIST
    const diagnostic = buildDiagnostic({
      capaBody: capa,
      infoBody: info,
      transport: "plain",
      fingerprint: "def456",
    });
    expect(diagnostic).toMatch(/Source caps:.*flatbed: Y.*ADF: N.*duplex: N/);
    expect(diagnostic).toContain("(absent)"); // for the ADF scan-area row
    expect(diagnostic).toMatch(/CCT list:\s+\(absent\)/); // CCT absence is meaningful, not just blank
  });

  it("renders a bare #CCTLIST (segment present, value empty) as (absent), not blank", () => {
    // A bare LIST segment followed immediately by another # or end-of-body
    // parses to an empty string, not null. The diagnostic must still mark
    // it as (absent) so a maintainer can tell at a glance — the
    // present-vs-absent distinction drives PARA-variant selection.
    const info = Buffer.from("#FB AREAd850i0001170#PRDh010PID 9999", "ascii");
    const capa = Buffer.from("#GMMLISTUG10UG18#CCTLIST#ADFDPLX", "ascii");
    const diagnostic = buildDiagnostic({
      capaBody: capa,
      infoBody: info,
      transport: "plain",
      fingerprint: "empty1",
    });
    expect(diagnostic).toMatch(/CCT list:\s+\(absent\)/);
  });

  it("renders a bare #GMMLIST (segment present, value empty) as (absent), not blank", () => {
    // Same disambiguation must apply consistently across all LIST rows,
    // not just CCT — the whole point of the diagnostic block is at-a-glance reading.
    const info = Buffer.from("#FB AREAd850i0001170#PRDh010PID 9999", "ascii");
    const capa = Buffer.from("#GMMLIST#CMXLISTUNITUM08", "ascii");
    const diagnostic = buildDiagnostic({
      capaBody: capa,
      infoBody: info,
      transport: "plain",
      fingerprint: "empty2",
    });
    expect(diagnostic).toMatch(/GMM list:\s+\(absent\)/);
    // Sanity-check: the non-empty CMX value still renders normally.
    expect(diagnostic).toContain("UNITUM08");
  });

  it("throws an UnsupportedDialectError when explicitly raised", () => {
    expect(() => {
      throw new UnsupportedDialectError("xyz", "diagnostic body");
    }).toThrow(/xyz/);
  });
});
