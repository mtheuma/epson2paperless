import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { decodeToRaster } from "./decode.js";
import { setJpegOrientation } from "../exif.js";

async function solidJpeg(w: number, h: number, c: { r: number; g: number; b: number }) {
  return sharp({ create: { width: w, height: h, channels: 3, background: c } })
    .jpeg({ quality: 100 })
    .toBuffer();
}

describe("decodeToRaster", () => {
  it("decodes a JPEG to a 3-channel raster of the right size", async () => {
    const jpeg = await solidJpeg(16, 8, { r: 200, g: 100, b: 50 });
    const r = await decodeToRaster(jpeg);
    expect(r.width).toBe(16);
    expect(r.height).toBe(8);
    expect(r.channels).toBe(3);
    const i = (4 * 16 + 8) * 3;
    expect(r.data[i]).toBeGreaterThan(190);
    expect(r.data[i]).toBeLessThan(210);
  });

  it("applies EXIF orientation when asked (180° swaps top/bottom rows)", async () => {
    const top = await sharp({
      create: { width: 8, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const bottom = await sharp({
      create: { width: 8, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();
    const composed = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        { input: top, top: 0, left: 0 },
        { input: bottom, top: 4, left: 0 },
      ])
      .jpeg({ quality: 100 })
      .toBuffer();
    const tagged = setJpegOrientation(composed, 3);

    const off = await decodeToRaster(tagged, { applyOrientation: false });
    const on = await decodeToRaster(tagged, { applyOrientation: true });
    const topPx = (r: typeof off) => r.data[(1 * 8 + 4) * 3];
    expect(topPx(off)).toBeGreaterThan(200);
    expect(topPx(on)).toBeLessThan(60);
  });
});
