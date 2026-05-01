import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { encodeRawGbrToJpeg } from "./raw-to-jpeg.js";

describe("raw-to-jpeg", () => {
  it("encodes a 4×4 GBR raster representing solid red to a valid JPEG", async () => {
    const width = 4;
    const height = 4;
    const raw = Buffer.alloc(width * height * 3);
    // GBR-interleaved: each pixel is [G, B, R]. Solid red = (R=0xff, G=0, B=0).
    for (let i = 0; i < raw.length; i += 3) {
      raw[i] = 0x00;
      raw[i + 1] = 0x00;
      raw[i + 2] = 0xff;
    }

    const jpeg = await encodeRawGbrToJpeg(raw, width, height, 90);

    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    const meta = await sharp(jpeg).metadata();
    expect(meta.width).toBe(width);
    expect(meta.height).toBe(height);
    expect(meta.format).toBe("jpeg");
  });

  // Regression for issue #24 / WF-3620 colour swap: bytes from the WF-3620 are
  // GBR-interleaved per pixel. A direct sharp encode treats them as RGB and
  // produces channel-swapped output (red→blue etc.). This test feeds a known
  // GBR pattern and asserts the decoded JPEG actually has the right colours.
  // Uses 16-px-wide patches so the JPEG MCU and chroma subsampling don't
  // bleed neighbouring colours into the sampled centre pixel.
  it("permutes GBR pixel order to RGB so each colour decodes correctly", async () => {
    const patchPx = 16;
    const colours = [
      [0xff, 0x00, 0x00], // red
      [0x00, 0xff, 0x00], // green
      [0x00, 0x00, 0xff], // blue
      [0xff, 0xff, 0xff], // white
    ];
    const width = patchPx * colours.length;
    const height = patchPx;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let p = 0; p < colours.length; p++) {
        const [r, g, b] = colours[p];
        for (let dx = 0; dx < patchPx; dx++) {
          const x = p * patchPx + dx;
          const off = (y * width + x) * 3;
          // Wire bytes are [G, B, R] per pixel.
          raw[off] = g;
          raw[off + 1] = b;
          raw[off + 2] = r;
        }
      }
    }

    const jpeg = await encodeRawGbrToJpeg(raw, width, height, 95);
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(width);
    expect(info.height).toBe(height);
    expect(info.channels).toBe(3);

    const tol = 6; // JPEG quantisation slack at q=95, sampled at patch centre
    const cy = Math.floor(height / 2);
    for (let p = 0; p < colours.length; p++) {
      const cx = p * patchPx + Math.floor(patchPx / 2);
      const off = (cy * width + cx) * 3;
      const [er, eg, eb] = colours[p];
      expect(Math.abs(data[off] - er)).toBeLessThanOrEqual(tol);
      expect(Math.abs(data[off + 1] - eg)).toBeLessThanOrEqual(tol);
      expect(Math.abs(data[off + 2] - eb)).toBeLessThanOrEqual(tol);
    }
  });

  it("throws if buffer length doesn't match width × height × 3", async () => {
    const raw = Buffer.alloc(10);
    await expect(encodeRawGbrToJpeg(raw, 4, 4, 90)).rejects.toThrow(/buffer length/i);
  });
});
