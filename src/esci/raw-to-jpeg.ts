import sharp from "sharp";
import { setJfifDensity } from "../exif.js";

/**
 * Encode a raw 24-bit GBR-interleaved pixel buffer (the wire layout the WF-3620
 * sends — bytes per pixel are [G, B, R], confirmed against the Maltris test-page
 * capture) to a JPEG. The buffer is permuted in place to RGB before encoding;
 * the caller must not reuse it afterwards.
 *
 * `dpi` is stamped into the JFIF header as the pixel density. Raw wire pixels
 * carry no physical size, and a density-less JPEG reads as 72 DPI everywhere
 * downstream — viewers, the `document` re-encode (which inherits the source
 * density), and the PDF page box (issue #221) — so the delivered DPI has to be
 * on the page from the moment it exists. Stamped as a lossless header patch
 * rather than via sharp's `.withMetadata({ density })`, which would add an
 * EXIF block that the duplex back-page orientation stamp then duplicates.
 * Omitted (the render tool's explicit-geometry path) means no density.
 */
export async function encodeRawGbrToJpeg(
  raw: Buffer,
  width: number,
  height: number,
  quality: number,
  dpi?: number,
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
  const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
  return dpi === undefined ? jpeg : setJfifDensity(jpeg, dpi);
}
