import type { Raster, Rect, Rgb } from "../types.js";
import {
  LAYOUT,
  SWATCHES,
  swatchRect,
  crosshairPoints,
  markerRegion,
} from "../../../tools/test-page/layout.js";

export function blankRaster(width: number, height: number): Raster {
  const data = Buffer.alloc(width * height * 3, 255); // white
  return { data, width, height, channels: 3 };
}

export function getPixel(r: Raster, x: number, y: number): Rgb {
  const i = (y * r.width + x) * r.channels;
  return { r: r.data[i], g: r.data[i + 1], b: r.data[i + 2] };
}

export function fillRect(r: Raster, rect: Rect, c: Rgb): void {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(r.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(r.height, Math.round(rect.y + rect.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * r.width + x) * r.channels;
      r.data[i] = c.r;
      r.data[i + 1] = c.g;
      r.data[i + 2] = c.b;
    }
  }
}

export interface BuildPageOpts {
  scale?: number; // pixels per PDF point
  swatchColors?: Rgb[]; // override the 12 swatch fills (defaults to declared hex)
  marker?: Rgb; // colour of the asymmetric corner marker (default red "F")
}

/**
 * Render the layout into a raster (top-left origin), converting PDF point
 * space (bottom-left) via px = pt*scale for x and (pageHeight - pt)*scale for y.
 * Returns the raster plus the expected pixel-space crosshair centres so tests
 * can assert detection without re-deriving the conversion.
 */
export function buildTestPageRaster(opts: BuildPageOpts = {}): {
  raster: Raster;
  expectedCrosshairsPx: { x: number; y: number }[];
} {
  const scale = opts.scale ?? 2;
  const width = Math.round(LAYOUT.pageWidth * scale);
  const height = Math.round(LAYOUT.pageHeight * scale);
  const raster = blankRaster(width, height);

  const toPx = (x: number) => x * scale;
  const toPy = (y: number) => (LAYOUT.pageHeight - y) * scale;
  const ptRectToPx = (pr: { x: number; y: number; w: number; h: number }): Rect => {
    const top = toPy(pr.y + pr.h);
    const left = toPx(pr.x);
    return { x: left, y: top, w: pr.w * scale, h: pr.h * scale };
  };

  // Swatches.
  for (let i = 0; i < SWATCHES.length; i++) {
    const c = opts.swatchColors?.[i] ?? {
      r: SWATCHES[i].r,
      g: SWATCHES[i].g,
      b: SWATCHES[i].b,
    };
    fillRect(raster, ptRectToPx(swatchRect(i)), c);
  }

  // Crosshairs: a small black plus at each corner.
  const arm = Math.round(12 * scale);
  const thick = Math.max(1, Math.round(1 * scale));
  const expectedCrosshairsPx = crosshairPoints.map((p) => ({ x: toPx(p.x), y: toPy(p.y) }));
  for (const cp of expectedCrosshairsPx) {
    fillRect(
      raster,
      { x: cp.x - arm, y: cp.y - thick, w: 2 * arm, h: 2 * thick },
      { r: 0, g: 0, b: 0 },
    );
    fillRect(
      raster,
      { x: cp.x - thick, y: cp.y - arm, w: 2 * thick, h: 2 * arm },
      { r: 0, g: 0, b: 0 },
    );
  }

  // Asymmetric marker near the TL crosshair (default saturated red, like "F").
  fillRect(raster, ptRectToPx(markerRegion), opts.marker ?? { r: 255, g: 0, b: 0 });

  return { raster, expectedCrosshairsPx };
}
