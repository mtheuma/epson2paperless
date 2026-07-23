import { describe, it, expect } from "vitest";
import { GAMMA_CLASSES, type GammaClassName } from "./gamma-classes.js";

describe("gamma-classes", () => {
  it("exposes et4950-stock with the expected size", () => {
    expect(GAMMA_CLASSES["et4950-stock"].length).toBe(804); // 3 × 268
  });

  it("et4950-stock starts with #GMTGRN h100 header", () => {
    expect(GAMMA_CLASSES["et4950-stock"].subarray(0, 12).toString("ascii")).toBe("#GMTGRN h100");
  });

  it("et4950-stock has #GMTRED h100 at offset 268", () => {
    expect(GAMMA_CLASSES["et4950-stock"].subarray(268, 280).toString("ascii")).toBe("#GMTRED h100");
  });

  it("et4950-stock has #GMTBLU h100 at offset 536", () => {
    expect(GAMMA_CLASSES["et4950-stock"].subarray(536, 548).toString("ascii")).toBe("#GMTBLU h100");
  });

  it("et4950-stock RED channel is NOT a strict [0..255] identity (skips 0x14)", () => {
    // RED LUT bytes start at offset 268 + 12 = 280. Sequential identity would
    // place 0x14 at offset 280+20 = 300, but the captured bytes skip it. This
    // test pins the documented anomaly so a future regenerated identity LUT
    // doesn't silently break replay parity.
    const red = GAMMA_CLASSES["et4950-stock"].subarray(280, 280 + 256);
    expect(red[19]).toBe(0x13);
    expect(red[20]).toBe(0x15); // the 0x14 skip
  });

  it("xp7100-jpg has the same size as et4950-stock", () => {
    expect(GAMMA_CLASSES["xp7100-jpg"].length).toBe(804);
  });

  it("xp7100-jpg and xp7100-pdf differ", () => {
    expect(GAMMA_CLASSES["xp7100-jpg"].equals(GAMMA_CLASSES["xp7100-pdf"])).toBe(false);
  });

  it("exposes et4800-stock with the expected size", () => {
    expect(GAMMA_CLASSES["et4800-stock"].length).toBe(804); // 3 × 268
  });

  it("et4800-stock carries the GRN/RED/BLU h100 segment headers", () => {
    const g = GAMMA_CLASSES["et4800-stock"];
    expect(g.subarray(0, 12).toString("ascii")).toBe("#GMTGRN h100");
    expect(g.subarray(268, 280).toString("ascii")).toBe("#GMTRED h100");
    expect(g.subarray(536, 548).toString("ascii")).toBe("#GMTBLU h100");
  });

  it("et4800-stock has a non-identity LUT (zero floor at low end)", () => {
    // The ET-4800 driver ships a contrast-boosting curve with a ~38-byte zero
    // floor at the start of each channel LUT (input 0..~0x26 → output 0). Pin
    // this anomaly so a future regenerated identity LUT doesn't silently
    // mismatch the captured wire bytes.
    const grnLut = GAMMA_CLASSES["et4800-stock"].subarray(12, 268);
    for (let i = 0; i < 30; i++) {
      expect(grnLut[i]).toBe(0);
    }
    // Saturates to 0xff at the top — distinct from ET-2750's identity curve.
    expect(grnLut[grnLut.length - 1]).toBe(0xff);
  });

  it("exposes ff680w-adf with the expected size and segment order", () => {
    const g = GAMMA_CLASSES["ff680w-adf"];
    expect(g.length).toBe(804);
    expect(g.subarray(0, 12).toString("ascii")).toBe("#GMTRED h100");
    expect(g.subarray(268, 280).toString("ascii")).toBe("#GMTBLU h100");
    expect(g.subarray(536, 548).toString("ascii")).toBe("#GMTGRN h100");
  });

  it("exposes ds575w-mono as a single 268-byte #GMTMONO segment", () => {
    const g = GAMMA_CLASSES["ds575w-mono"];
    expect(g.length).toBe(268);
    expect(g.subarray(0, 12).toString("ascii")).toBe("#GMTMONOh100");
    // Near-identity LUT with two captured anomalies pinned verbatim: 0x34 is
    // duplicated and 0x8e is skipped. The 12-byte header precedes the 256-byte
    // LUT, so LUT index i lives at byte 12 + i.
    const lut = g.subarray(12);
    expect(lut.length).toBe(256);
    expect(lut[0x34]).toBe(0x34);
    expect(lut[0x35]).toBe(0x34); // 0x34 duplicated
    expect(lut.includes(0x8e)).toBe(false); // 0x8e skipped
  });

  it("class names enumerate as a type", () => {
    const _names: GammaClassName[] = [
      "et4950-stock",
      "xp7100-jpg",
      "xp7100-pdf",
      "et4800-stock",
      "ff680w-adf",
      "ds575w-mono",
    ];
    expect(_names).toHaveLength(6);
  });
});
