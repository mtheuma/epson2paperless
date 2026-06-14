import { describe, it, expect } from "vitest";
import { detectCrosshairs } from "./crosshairs.js";
import { buildTestPageRaster } from "./test-support/raster-draw.js";

describe("detectCrosshairs", () => {
  it("finds all 4 crosshair centres near their expected positions", () => {
    const { raster, expectedCrosshairsPx } = buildTestPageRaster({ scale: 2 });
    const found = detectCrosshairs(raster);
    expect(found).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(found[i].x - expectedCrosshairsPx[i].x)).toBeLessThan(3);
      expect(Math.abs(found[i].y - expectedCrosshairsPx[i].y)).toBeLessThan(3);
    }
  });

  it("ignores a dark-but-single-channel-bright marker next to the TL crosshair", () => {
    // {0,0,150} has an average channel value of 50 (< NEAR_BLACK 60), so a naive
    // average/luminance-based filter WOULD count it and bias the TL centroid. The
    // all-channel filter correctly excludes it because b=150 is not < 60, so this
    // test passes only because the implementation uses the all-channel filter.
    const { raster, expectedCrosshairsPx } = buildTestPageRaster({
      scale: 2,
      marker: { r: 0, g: 0, b: 150 },
    });
    const found = detectCrosshairs(raster);
    expect(Math.abs(found[0].x - expectedCrosshairsPx[0].x)).toBeLessThan(3);
    expect(Math.abs(found[0].y - expectedCrosshairsPx[0].y)).toBeLessThan(3);
  });
});
