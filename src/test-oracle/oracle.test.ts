import { describe, it, expect } from "vitest";
import { measure, assertAgainst } from "./oracle.js";
import { buildTestPageRaster } from "./test-support/raster-draw.js";
import type { Baseline } from "./baseline.js";

function baselineFrom(raster: ReturnType<typeof buildTestPageRaster>["raster"]): Baseline {
  const m = measure(raster);
  return {
    approvedAt: "2026-06-05",
    replay: {
      fixturePath: "x",
      source: "flatbed",
      duplex: false,
      trimStatCycles: 3,
      printerIp: "192.0.2.58",
      destId: 2,
    },
    page: { width: raster.width, height: raster.height },
    crosshairResidualPx: m.crosshairResidualPx,
    swatches: m.swatches,
    greySpreads: m.greySpreads,
    stripeVarianceMax: m.stripeVarianceMax,
    expectedPageCount: 1,
    expectedBackPages: [],
    tolerances: {
      swatchDeltaE: 4,
      crosshairPx: 6,
      greySpread: 12,
      stripeVariance: m.stripeVarianceMax + 20,
    },
  };
}

describe("oracle", () => {
  it("passes a synthetic page against a baseline measured from itself", () => {
    const { raster } = buildTestPageRaster({ scale: 2 });
    const baseline = baselineFrom(raster);
    const report = assertAgainst(raster, baseline);
    expect(report.pass).toBe(true);
  });

  it("fails when a swatch colour is shifted beyond tolerance", () => {
    const { raster: good } = buildTestPageRaster({ scale: 2 });
    const baseline = baselineFrom(good);
    const colors = baseline.swatches.map((s) => ({ r: s.rgb[0], g: s.rgb[1], b: s.rgb[2] }));
    colors[0] = { r: 0, g: 255, b: 0 }; // red → green
    const { raster: bad } = buildTestPageRaster({ scale: 2, swatchColors: colors });
    const report = assertAgainst(bad, baseline);
    expect(report.pass).toBe(false);
    expect(report.checks.find((c) => c.name === "swatch:FF0000")?.pass).toBe(false);
  });

  it("fails when output dimensions don't match the baseline page size", () => {
    const { raster } = buildTestPageRaster({ scale: 2 });
    const baseline = baselineFrom(raster); // page size recorded at scale 2
    const { raster: scaled } = buildTestPageRaster({ scale: 3 });
    const report = assertAgainst(scaled, baseline);
    expect(report.pass).toBe(false);
    expect(report.checks.find((c) => c.name === "geometry:page-size")?.pass).toBe(false);
  });
});
