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

  it("class names enumerate as a type", () => {
    const _names: GammaClassName[] = ["et4950-stock", "xp7100-jpg", "xp7100-pdf"];
    expect(_names).toHaveLength(3);
  });
});
