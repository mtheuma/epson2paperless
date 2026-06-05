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

  it("ignores a saturated coloured marker next to the TL crosshair", () => {
    const { raster, expectedCrosshairsPx } = buildTestPageRaster({
      scale: 2,
      marker: { r: 255, g: 0, b: 0 },
    });
    const found = detectCrosshairs(raster);
    expect(Math.abs(found[0].x - expectedCrosshairsPx[0].x)).toBeLessThan(3);
    expect(Math.abs(found[0].y - expectedCrosshairsPx[0].y)).toBeLessThan(3);
  });
});
