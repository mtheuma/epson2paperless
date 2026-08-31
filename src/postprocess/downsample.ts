import sharp from "sharp";
import { setJfifDensity, readJpegOrientation, setJpegOrientation } from "../exif.js";

export interface Downsample {
  fromDpi: number;
  toDpi: number;
}

/**
 * Computes the resized width/height for a downsample ratio. Both dimensions
 * are rounded independently (`Math.round(px * ratio)` each) rather than
 * deriving one from the other's rounded value — at a non-half ratio
 * (e.g. 300→50 DPI, ratio 1/6) a width-derived height is off by a row: a
 * 2481x3506 page must become 414x584, not 414x585. Shared by downsampleJpeg,
 * document.ts's folded resize, and toGrayscaleJpeg's folded resize so all
 * three apply the identical rounding rule.
 *
 * Downsample only — throws if toDpi >= fromDpi. Upscaling would fabricate
 * pixels; the wire arm's DPI selection guarantees toDpi < fromDpi whenever it
 * produces a Downsample at all.
 */
export function scaledDimensions(
  width: number,
  height: number,
  ds: Downsample,
): { width: number; height: number } {
  if (ds.toDpi >= ds.fromDpi) {
    throw new Error(`downsample: toDpi=${ds.toDpi} must be < fromDpi=${ds.fromDpi}`);
  }
  const ratio = ds.toDpi / ds.fromDpi;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

/**
 * Host-side resolution fallback: scale a page down by toDpi/fromDpi and stamp
 * the target density so physical size survives for density-honouring
 * consumers. Downsample only — callers must never pass toDpi >= fromDpi
 * (upscaling fabricates pixels; the wire arm's selection guarantees this;
 * see scaledDimensions).
 *
 * The re-encode drops the source's EXIF, so the orientation tag (duplex back
 * pages carry Orientation=3 on the JPG path) is re-stamped after — density
 * first, then orientation, same ordering as toGrayscaleJpeg in auto-color.ts.
 */
export async function downsampleJpeg(
  jpeg: Buffer,
  ds: Downsample,
  jpegQuality: number,
): Promise<Buffer> {
  const orientation = readJpegOrientation(jpeg);
  const meta = await sharp(jpeg).metadata();
  const { width, height } = scaledDimensions(meta.width ?? 0, meta.height ?? 0, ds);
  // fit: "fill" absorbs the sub-pixel aspect difference between the two
  // independently-rounded dimensions; the default "cover" would crop instead.
  let out: Buffer = await sharp(jpeg)
    .resize({ width, height, fit: "fill" })
    .jpeg({ quality: jpegQuality })
    .toBuffer();
  out = setJfifDensity(out, ds.toDpi);
  if (orientation !== undefined && orientation !== 1) {
    out = setJpegOrientation(out, orientation);
  }
  return out;
}
