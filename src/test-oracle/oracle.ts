import type { CheckResult, OracleReport, Point, Raster, Rect, Rgb, Transform } from "./types.js";
import type { Baseline } from "./baseline.js";
import { detectCrosshairs } from "./crosshairs.js";
import { fitTransform, mapRect, residualPx } from "./transform.js";
import { meanRgb, perRowVariance } from "./metrics.js";
import { deltaE, channelSpread } from "./color.js";
import {
  crosshairPoints,
  swatchRect,
  greySwatchIndices,
  ruleLineBand,
  SWATCHES,
} from "../../tools/test-page/layout.js";

/** Inset applied to each swatch's mapped rect before sampling, to avoid edge bleed. */
const SWATCH_INSET_PX = 6;

/** Shrink a rect inward by `by` px on every side. */
function inset(rect: Rect, by: number): Rect {
  return { x: rect.x + by, y: rect.y + by, w: rect.w - 2 * by, h: rect.h - 2 * by };
}

export interface Geometry {
  transform: Transform;
  pxCrosshairs: Point[];
  crosshairResidualPx: number;
}

/**
 * Detect the crosshairs and fit the point→pixel transform for a raster.
 *
 * The fit makes all downstream sampling translation- and scale-invariant by
 * design: a page that lands shifted or scaled on the bed/ADF is followed via
 * its registration marks, so a *uniform* placement shift intentionally passes
 * every check (it is benign scan positioning, not a regression — see the
 * "accepts a uniformly shifted page" test). What the geometry checks catch is
 * *non-affine* distortion: skew and stride drift raise the crosshair residual
 * (the fit cannot absorb them), and a wrong output size fails geometry:page-size.
 */
function fitRaster(raster: Raster): Geometry {
  const pxCrosshairs = detectCrosshairs(raster);
  const transform = fitTransform(crosshairPoints, pxCrosshairs);
  return {
    transform,
    pxCrosshairs,
    crosshairResidualPx: round2(residualPx(crosshairPoints, pxCrosshairs, transform)),
  };
}

/** The inset pixel sample box for each of the 12 swatches under a transform.
 *  Exported so the baseline CLI's overlay draws the exact regions sampled. */
export function swatchSampleBoxes(t: Transform): Rect[] {
  return SWATCHES.map((_, i) => inset(mapRect(t, swatchRect(i)), SWATCH_INSET_PX));
}

export interface Measurement {
  crosshairResidualPx: number;
  swatches: { label: string; rgb: [number, number, number] }[];
  greySpreads: { label: string; spread: number }[];
  stripeVarianceMax: number;
}

/** Sample all metrics from a raster AND return the fitted geometry, so callers
 *  (e.g. the baseline CLI) can draw an overlay of the exact sampled regions
 *  without re-detecting the crosshairs. */
export function measureWithGeometry(raster: Raster): {
  measurement: Measurement;
  geometry: Geometry;
} {
  const geometry = fitRaster(raster);
  const boxes = swatchSampleBoxes(geometry.transform);
  // One mean per swatch; grey spreads reuse those means rather than re-scanning.
  const means = boxes.map((b) => meanRgb(raster, b));

  const swatches = SWATCHES.map((s, i) => ({
    label: s.label,
    rgb: [round(means[i].r), round(means[i].g), round(means[i].b)] as [number, number, number],
  }));

  const greySpreads = greySwatchIndices.map((i) => ({
    label: SWATCHES[i].label,
    spread: round(channelSpread(means[i])),
  }));

  const stripeVarianceMax = Math.max(
    ...greySwatchIndices.map((i) => perRowVariance(raster, boxes[i])),
    perRowVariance(raster, inset(mapRect(geometry.transform, ruleLineBand), 2)),
  );

  return {
    measurement: {
      crosshairResidualPx: geometry.crosshairResidualPx,
      swatches,
      greySpreads,
      stripeVarianceMax: round2(stripeVarianceMax),
    },
    geometry,
  };
}

/** Sample all metrics from a raster (no baseline) — used to bake baselines. */
export function measure(raster: Raster): Measurement {
  return measureWithGeometry(raster).measurement;
}

/** Run all checks against a committed baseline. */
export function assertAgainst(raster: Raster, baseline: Baseline): OracleReport {
  const m = measure(raster);
  const checks: CheckResult[] = [];

  checks.push({
    name: "geometry:page-size",
    pass: raster.width === baseline.page.width && raster.height === baseline.page.height,
    measured: null,
    detail: `${raster.width}x${raster.height} vs baseline ${baseline.page.width}x${baseline.page.height}`,
  });

  checks.push({
    name: "geometry:crosshair-residual",
    pass: m.crosshairResidualPx <= baseline.tolerances.crosshairPx,
    measured: m.crosshairResidualPx,
    tolerance: baseline.tolerances.crosshairPx,
  });

  for (const bs of baseline.swatches) {
    const got = m.swatches.find((s) => s.label === bs.label);
    if (!got) {
      checks.push({
        name: `swatch:${bs.label}`,
        pass: false,
        measured: null,
        detail: "missing in measurement",
      });
      continue;
    }
    const d = deltaE(rgb(got.rgb), rgb(bs.rgb));
    checks.push({
      name: `swatch:${bs.label}`,
      pass: d <= baseline.tolerances.swatchDeltaE,
      measured: round2(d),
      tolerance: baseline.tolerances.swatchDeltaE,
    });
  }

  for (const bg of baseline.greySpreads) {
    const got = m.greySpreads.find((g) => g.label === bg.label);
    checks.push({
      name: `grey:${bg.label}`,
      pass: !!got && got.spread <= baseline.tolerances.greySpread,
      measured: got?.spread ?? null,
      tolerance: baseline.tolerances.greySpread,
    });
  }

  checks.push({
    name: "stripe:max-row-variance",
    pass: m.stripeVarianceMax <= baseline.tolerances.stripeVariance,
    measured: m.stripeVarianceMax,
    tolerance: baseline.tolerances.stripeVariance,
  });

  return {
    pass: checks.every((c) => c.pass),
    crosshairResidualPx: m.crosshairResidualPx,
    checks,
  };
}

function rgb(t: [number, number, number]): Rgb {
  return { r: t[0], g: t[1], b: t[2] };
}
function round(n: number): number {
  return Math.round(n);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
