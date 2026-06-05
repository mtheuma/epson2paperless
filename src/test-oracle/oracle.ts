import type { CheckResult, OracleReport, Raster, Rgb } from "./types.js";
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

/** Shrink a rect inward by `inset` px on every side to avoid edge bleed. */
function inset(rect: { x: number; y: number; w: number; h: number }, by: number) {
  return { x: rect.x + by, y: rect.y + by, w: rect.w - 2 * by, h: rect.h - 2 * by };
}

export interface Measurement {
  crosshairResidualPx: number;
  swatches: { label: string; rgb: [number, number, number] }[];
  greySpreads: { label: string; spread: number }[];
  stripeVarianceMax: number;
}

/** Sample all metrics from a raster (no baseline) — used to bake baselines. */
export function measure(raster: Raster): Measurement {
  const pxCrosshairs = detectCrosshairs(raster);
  const t = fitTransform(crosshairPoints, pxCrosshairs);
  const crosshairResidualPx = residualPx(crosshairPoints, pxCrosshairs, t);

  const swatches = SWATCHES.map((s, i) => {
    const m = meanRgb(raster, inset(mapRect(t, swatchRect(i)), 6));
    return {
      label: s.label,
      rgb: [round(m.r), round(m.g), round(m.b)] as [number, number, number],
    };
  });

  const greySpreads = greySwatchIndices.map((i) => {
    const m = meanRgb(raster, inset(mapRect(t, swatchRect(i)), 6));
    return { label: SWATCHES[i].label, spread: round(channelSpread(m)) };
  });

  const stripeVarianceMax = Math.max(
    ...greySwatchIndices.map((i) => perRowVariance(raster, inset(mapRect(t, swatchRect(i)), 6))),
    perRowVariance(raster, inset(mapRect(t, ruleLineBand), 2)),
  );

  return {
    crosshairResidualPx: round2(crosshairResidualPx),
    swatches,
    greySpreads,
    stripeVarianceMax: round2(stripeVarianceMax),
  };
}

/** Run all checks against a committed baseline. */
export function assertAgainst(raster: Raster, baseline: Baseline): OracleReport {
  const m = measure(raster);
  const checks: CheckResult[] = [];

  checks.push({
    name: "geometry:page-size",
    pass: raster.width === baseline.page.width && raster.height === baseline.page.height,
    measured: raster.width,
    baseline: baseline.page.width,
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
        measured: NaN,
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
      measured: got?.spread ?? NaN,
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
