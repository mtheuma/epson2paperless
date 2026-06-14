import sharp from "sharp";
import type { Raster } from "./types.js";

export interface DecodeOpts {
  /** Bake EXIF orientation into pixels via sharp.rotate() (default false). */
  applyOrientation?: boolean;
}

/**
 * Decode a JPEG buffer to a tightly-packed RGB raster (top-left origin).
 * Never accepts PDF — sharp/libvips cannot rasterize PDF in this build.
 */
export async function decodeToRaster(jpeg: Buffer, opts: DecodeOpts = {}): Promise<Raster> {
  let pipeline = sharp(jpeg);
  if (opts.applyOrientation) pipeline = pipeline.rotate(); // auto-orient from EXIF
  const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}
