import { describe, it, expect } from "vitest";
import { meanRgb, perRowVariance } from "./metrics.js";
import { blankRaster, fillRect } from "./test-support/raster-draw.js";

describe("metrics", () => {
  it("computes the mean RGB of a region", () => {
    const r = blankRaster(20, 20);
    fillRect(r, { x: 5, y: 5, w: 10, h: 10 }, { r: 40, g: 80, b: 120 });
    expect(meanRgb(r, { x: 5, y: 5, w: 10, h: 10 })).toEqual({ r: 40, g: 80, b: 120 });
  });

  it("reports ~0 row variance for a flat fill", () => {
    const r = blankRaster(20, 20);
    fillRect(r, { x: 0, y: 0, w: 20, h: 20 }, { r: 128, g: 128, b: 128 });
    expect(perRowVariance(r, { x: 0, y: 0, w: 20, h: 20 })).toBeLessThan(0.001);
  });

  it("reports high row variance for horizontal banding", () => {
    const r = blankRaster(20, 20);
    for (let y = 0; y < 20; y++) {
      const v = y % 2 === 0 ? 0 : 255;
      fillRect(r, { x: 0, y, w: 20, h: 1 }, { r: v, g: v, b: v });
    }
    expect(perRowVariance(r, { x: 0, y: 0, w: 20, h: 20 })).toBeGreaterThan(1000);
  });
});
