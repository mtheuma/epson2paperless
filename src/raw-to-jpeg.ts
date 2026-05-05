import sharp from "sharp";

/**
 * Encode a raw 24-bit GBR-interleaved pixel buffer (the wire layout the WF-3620
 * sends — bytes per pixel are [G, B, R], confirmed against the Maltris test-page
 * capture) to a JPEG. The buffer is permuted in place to RGB before encoding;
 * the caller must not reuse it afterwards.
 */
export async function encodeRawGbrToJpeg(
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
  for (let i = 0; i < raw.length; i += 3) {
    const g = raw[i];
    const b = raw[i + 1];
    const r = raw[i + 2];
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
}
