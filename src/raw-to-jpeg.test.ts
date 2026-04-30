import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { encodeRawRgbToJpeg } from "./raw-to-jpeg.js";

describe("raw-to-jpeg", () => {
  it("encodes a 4×4 solid red RGB raster to a valid JPEG", async () => {
    const width = 4;
    const height = 4;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 3) {
      raw[i] = 0xff; // R
      raw[i + 1] = 0x00; // G
      raw[i + 2] = 0x00; // B
    }

    const jpeg = await encodeRawRgbToJpeg(raw, width, height, 90);

    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8); // JPEG SOI
    const meta = await sharp(jpeg).metadata();
    expect(meta.width).toBe(width);
    expect(meta.height).toBe(height);
    expect(meta.format).toBe("jpeg");
  });

  it("throws if buffer length doesn't match width × height × 3", async () => {
    const raw = Buffer.alloc(10);
    await expect(encodeRawRgbToJpeg(raw, 4, 4, 90)).rejects.toThrow(/buffer length/i);
  });
});
