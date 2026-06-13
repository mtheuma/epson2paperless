import { describe, it, expect } from "vitest";
import { deltaE, channelSpread } from "./color.js";

describe("color", () => {
  it("returns ~0 deltaE for identical colours", () => {
    expect(deltaE({ r: 100, g: 120, b: 140 }, { r: 100, g: 120, b: 140 })).toBeLessThan(0.001);
  });

  it("returns a larger deltaE for distinct colours", () => {
    expect(deltaE({ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 })).toBeGreaterThan(50);
  });

  it("computes channel spread", () => {
    expect(channelSpread({ r: 100, g: 110, b: 90 })).toBe(20);
  });
});
