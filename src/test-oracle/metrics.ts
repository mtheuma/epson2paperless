import type { Raster, Rect, Rgb } from "./types.js";

function clampRect(r: Raster, rect: Rect): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.max(0, Math.round(rect.x)),
    y0: Math.max(0, Math.round(rect.y)),
    x1: Math.min(r.width, Math.round(rect.x + rect.w)),
    y1: Math.min(r.height, Math.round(rect.y + rect.h)),
  };
}

export function meanRgb(r: Raster, rect: Rect): Rgb {
  const { x0, y0, x1, y1 } = clampRect(r, rect);
  let sr = 0,
    sg = 0,
    sb = 0,
    n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * r.width + x) * r.channels;
      sr += r.data[i];
      sg += r.data[i + 1];
      sb += r.data[i + 2];
      n++;
    }
  }
  if (n === 0) throw new Error("meanRgb: empty region");
  return { r: sr / n, g: sg / n, b: sb / n };
}

/** Variance across per-row luma means — high under horizontal banding. */
export function perRowVariance(r: Raster, rect: Rect): number {
  const { x0, y0, x1, y1 } = clampRect(r, rect);
  const rowMeans: number[] = [];
  for (let y = y0; y < y1; y++) {
    let s = 0,
      n = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * r.width + x) * r.channels;
      s += (r.data[i] + r.data[i + 1] + r.data[i + 2]) / 3;
      n++;
    }
    if (n > 0) rowMeans.push(s / n);
  }
  if (rowMeans.length === 0) throw new Error("perRowVariance: empty region");
  const mean = rowMeans.reduce((a, b) => a + b, 0) / rowMeans.length;
  return rowMeans.reduce((a, b) => a + (b - mean) ** 2, 0) / rowMeans.length;
}
