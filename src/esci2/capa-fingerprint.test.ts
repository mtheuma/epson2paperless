import { describe, it, expect } from "vitest";
import { computeCapaFingerprint } from "./capa-fingerprint.js";

describe("computeCapaFingerprint", () => {
  it("returns a 64-char hex sha256", () => {
    const body = Buffer.from("#FB AREAd850i0001170#GMMLISTUG10", "ascii");
    const fp = computeCapaFingerprint(body);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input gives same hash", () => {
    const body = Buffer.from("#FB AREAd850i0001170#GMMLISTUG10", "ascii");
    expect(computeCapaFingerprint(body)).toBe(computeCapaFingerprint(body));
  });

  it("drops volatile-prefix segments (#ADFSCNT and #FB CNT)", () => {
    const stable = Buffer.from("#FB AREAd850i0001170#GMMLISTUG10", "ascii");
    const withCounters = Buffer.from(
      "#FB AREAd850i0001170#GMMLISTUG10#ADFSCNT123456#FB CNT789#ADFJAM0#ADFDCNT42",
      "ascii",
    );
    expect(computeCapaFingerprint(withCounters)).toBe(computeCapaFingerprint(stable));
  });

  it("is order-independent (segments sorted before hashing)", () => {
    const a = Buffer.from("#FB AREAd850i0001170#GMMLISTUG10", "ascii");
    const b = Buffer.from("#GMMLISTUG10#FB AREAd850i0001170", "ascii");
    expect(computeCapaFingerprint(a)).toBe(computeCapaFingerprint(b));
  });

  it("trims trailing whitespace per segment", () => {
    const padded = Buffer.from("#FB AREAd850i0001170   #GMMLISTUG10  ", "ascii");
    const unpadded = Buffer.from("#FB AREAd850i0001170#GMMLISTUG10", "ascii");
    expect(computeCapaFingerprint(padded)).toBe(computeCapaFingerprint(unpadded));
  });

  it("produces different fingerprints for materially different CAPA", () => {
    const a = Buffer.from("#GMMLISTUG10", "ascii");
    const b = Buffer.from("#GMMLISTUG18", "ascii");
    expect(computeCapaFingerprint(a)).not.toBe(computeCapaFingerprint(b));
  });
});
