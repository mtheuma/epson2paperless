import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { downsampleJpeg, scaledDimensions } from "./downsample.js";
import { setJpegOrientation, readJpegOrientation } from "../exif.js";

describe("scaledDimensions", () => {
  it("rounds both dimensions independently, not width-derived", () => {
    // 2481x3506 at 300→50: round(2481/6)=414, round(3506/6)=584.
    // Width-derived height would be 585 — the exact bug this pins.
    expect(scaledDimensions(2481, 3506, { fromDpi: 300, toDpi: 50 })).toEqual({
      width: 414,
      height: 584,
    });
  });

  it("throws when toDpi >= fromDpi (never upscale)", () => {
    expect(() => scaledDimensions(100, 100, { fromDpi: 150, toDpi: 300 })).toThrow(
      /toDpi=300 must be < fromDpi=150/,
    );
    expect(() => scaledDimensions(100, 100, { fromDpi: 150, toDpi: 150 })).toThrow();
  });
});

describe("downsampleJpeg", () => {
  it("resizes by the DPI ratio and stamps the target density", async () => {
    const src = await sharp({
      create: { width: 600, height: 300, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const out = await downsampleJpeg(src, { fromDpi: 300, toDpi: 150 }, 90);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(150);
    expect(meta.density).toBe(150);
  });

  it("non-half ratio: both dimensions round independently (not derived from width)", async () => {
    const src = await sharp({
      create: { width: 2481, height: 3506, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .jpeg()
      .toBuffer();
    const out = await downsampleJpeg(src, { fromDpi: 300, toDpi: 50 }, 90);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(414);
    expect(meta.height).toBe(584);
  });

  it("preserves the EXIF orientation tag through the re-encode", async () => {
    const base = await sharp({
      create: { width: 600, height: 300, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const oriented = setJpegOrientation(base, 3);
    const out = await downsampleJpeg(oriented, { fromDpi: 300, toDpi: 150 }, 90);
    expect(readJpegOrientation(out)).toBe(3);
  });

  it("does not stamp an orientation tag when the source has none", async () => {
    const src = await sharp({
      create: { width: 600, height: 300, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const out = await downsampleJpeg(src, { fromDpi: 300, toDpi: 150 }, 90);
    expect(readJpegOrientation(out)).toBeUndefined();
  });
});
