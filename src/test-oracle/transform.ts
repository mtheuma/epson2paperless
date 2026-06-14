import type { Point, Rect, Transform } from "./types.js";

/** 1-D least squares: out ≈ scale*in + offset. */
function fitAxis(pairs: { in: number; out: number }[]): { scale: number; offset: number } {
  const n = pairs.length;
  const sx = pairs.reduce((a, p) => a + p.in, 0);
  const sy = pairs.reduce((a, p) => a + p.out, 0);
  const sxx = pairs.reduce((a, p) => a + p.in * p.in, 0);
  const sxy = pairs.reduce((a, p) => a + p.in * p.out, 0);
  const denom = n * sxx - sx * sx;
  const scale = (n * sxy - sx * sy) / denom;
  const offset = (sy - scale * sx) / n;
  return { scale, offset };
}

/** Fit pt→px from corresponding crosshair points (same order in both arrays). */
export function fitTransform(ptPoints: Point[], pxPoints: Point[]): Transform {
  const xAxis = fitAxis(ptPoints.map((p, i) => ({ in: p.x, out: pxPoints[i].x })));
  const yAxis = fitAxis(ptPoints.map((p, i) => ({ in: p.y, out: pxPoints[i].y })));
  return { sx: xAxis.scale, ox: xAxis.offset, sy: yAxis.scale, oy: yAxis.offset };
}

function apply(t: Transform, p: Point): Point {
  return { x: t.sx * p.x + t.ox, y: t.sy * p.y + t.oy };
}

/** Max per-crosshair Euclidean residual between measured and predicted. */
export function residualPx(ptPoints: Point[], pxPoints: Point[], t: Transform): number {
  let max = 0;
  for (let i = 0; i < ptPoints.length; i++) {
    const pred = apply(t, ptPoints[i]);
    const d = Math.hypot(pred.x - pxPoints[i].x, pred.y - pxPoints[i].y);
    if (d > max) max = d;
  }
  return max;
}

/** Map a PDF-point rect (bottom-left origin) to a pixel rect (top-left). */
export function mapRect(t: Transform, ptRect: Rect): Rect {
  const c1 = apply(t, { x: ptRect.x, y: ptRect.y });
  const c2 = apply(t, { x: ptRect.x + ptRect.w, y: ptRect.y + ptRect.h });
  const x = Math.min(c1.x, c2.x);
  const y = Math.min(c1.y, c2.y);
  return { x, y, w: Math.abs(c2.x - c1.x), h: Math.abs(c2.y - c1.y) };
}
