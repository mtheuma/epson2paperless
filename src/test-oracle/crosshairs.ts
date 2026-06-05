import type { Point, Raster } from "./types.js";
import { LAYOUT, crosshairPoints } from "../../tools/test-page/layout.js";

const NEAR_BLACK = 60; // all channels must be below this to count as crosshair ink
const WINDOW_FRACTION = 0.18; // search window edge length as a fraction of the page

/**
 * Detect the 4 registration crosshairs, returned in layout order [TL,TR,BL,BR]
 * as pixel centroids. For each crosshair we search a window centred on its
 * EXPECTED pixel position (derived from the layout's corner fractions × image
 * size — coarse is fine, the page is near-aligned) and take the centroid of
 * NEAR-BLACK-IN-ALL-CHANNELS pixels. The all-channel threshold is what keeps
 * the saturated red "F" / blue "B" markers (which sit near the TL crosshair)
 * from biasing the centroid — they're bright in one channel.
 */
export function detectCrosshairs(r: Raster): Point[] {
  const half = Math.round((Math.min(r.width, r.height) * WINDOW_FRACTION) / 2);
  return crosshairPoints.map((cp) => {
    const fx = cp.x / LAYOUT.pageWidth;
    const fy = 1 - cp.y / LAYOUT.pageHeight;
    const cx = Math.round(fx * r.width);
    const cy = Math.round(fy * r.height);
    const x0 = Math.max(0, cx - half);
    const y0 = Math.max(0, cy - half);
    const x1 = Math.min(r.width, cx + half);
    const y1 = Math.min(r.height, cy + half);

    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * r.width + x) * r.channels;
        if (r.data[i] < NEAR_BLACK && r.data[i + 1] < NEAR_BLACK && r.data[i + 2] < NEAR_BLACK) {
          sx += x;
          sy += y;
          n++;
        }
      }
    }
    if (n === 0) {
      throw new Error(`detectCrosshairs: no near-black pixels in window around (${cx},${cy})`);
    }
    return { x: sx / n, y: sy / n };
  });
}
