import { describe, it, expect } from "vitest";
import { blankRaster, fillRect, getPixel, buildTestPageRaster } from "./raster-draw.js";

describe("raster-draw", () => {
  it("creates a white raster of the requested size", () => {
    const r = blankRaster(4, 3);
    expect(r.width).toBe(4);
    expect(r.height).toBe(3);
    expect(r.channels).toBe(3);
    expect(getPixel(r, 0, 0)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("fills a rectangle with a colour", () => {
    const r = blankRaster(10, 10);
    fillRect(r, { x: 2, y: 2, w: 3, h: 3 }, { r: 10, g: 20, b: 30 });
    expect(getPixel(r, 3, 3)).toEqual({ r: 10, g: 20, b: 30 });
    expect(getPixel(r, 0, 0)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("builds a synthetic test page with black corner crosshairs", () => {
    const { raster } = buildTestPageRaster({ scale: 2 });
    let foundBlack = false;
    for (let y = 0; y < 120 && !foundBlack; y++) {
      for (let x = 0; x < 120 && !foundBlack; x++) {
        const p = getPixel(raster, x, y);
        if (p.r < 40 && p.g < 40 && p.b < 40) foundBlack = true;
      }
    }
    expect(foundBlack).toBe(true);
  });
});
