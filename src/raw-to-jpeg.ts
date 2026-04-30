import sharp from "sharp";

export async function encodeRawRgbToJpeg(
  raw: Buffer,
  width: number,
  height: number,
  quality: number,
): Promise<Buffer> {
  const expected = width * height * 3;
  if (raw.length !== expected) {
    throw new Error(
      `raw-to-jpeg: buffer length ${raw.length} does not match width(${width}) × height(${height}) × 3 = ${expected}`,
    );
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
}
