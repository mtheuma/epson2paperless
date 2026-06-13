import { describe, it, expect } from "vitest";
import { fitTransform, mapRect, residualPx } from "./transform.js";
import { crosshairPoints, swatchRect } from "../../tools/test-page/layout.js";
import { buildTestPageRaster } from "./test-support/raster-draw.js";

describe("transform", () => {
  it("fits a scale+translate with a negative y-scale (PDF up vs raster down)", () => {
    const { expectedCrosshairsPx } = buildTestPageRaster({ scale: 2 });
    const t = fitTransform(crosshairPoints, expectedCrosshairsPx);
    expect(t.sx).toBeCloseTo(2, 1);
    expect(t.sy).toBeCloseTo(-2, 1);
    expect(residualPx(crosshairPoints, expectedCrosshairsPx, t)).toBeLessThan(0.5);
  });

  it("maps a swatch's point-rect into the expected pixel box", () => {
    const { expectedCrosshairsPx } = buildTestPageRaster({ scale: 2 });
    const t = fitTransform(crosshairPoints, expectedCrosshairsPx);
    const px = mapRect(t, swatchRect(0));
    expect(px.w).toBeCloseTo(120 * 2, 0);
    expect(px.h).toBeCloseTo(70 * 2, 0);
    expect(px.x).toBeGreaterThan(0);
    expect(px.y).toBeGreaterThan(0);
  });

  it("residualPx is large when one crosshair is displaced (the fit can't absorb it)", () => {
    const { expectedCrosshairsPx } = buildTestPageRaster({ scale: 2 });
    const perturbed = expectedCrosshairsPx.map((p, i) =>
      i === 0 ? { x: p.x + 25, y: p.y - 25 } : p,
    );
    const t = fitTransform(crosshairPoints, perturbed);
    expect(residualPx(crosshairPoints, perturbed, t)).toBeGreaterThan(10);
  });
});
