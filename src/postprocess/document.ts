import sharp from "sharp";
import { TONE_CURVES, type ToneCurveName } from "./tone-curves.js";
import { classifyRawPixels, type ChromaVerdict, type WhitePoint } from "./auto-color.js";
import { scaledDimensions, type Downsample } from "./downsample.js";
import { setJfifDensity } from "../exif.js";
import type { GrayscaleConversion } from "../config.js";

// Tunable constants — starting values; refined against the oracle (Task 7).
// clipPoint = paperWhite - CLIP_BELOW_PAPER (plateau to 255 above it);
// kneeStart = clipPoint - KNEE_WIDTH (identity below it). CLIP_BELOW_PAPER must
// exceed the paper's dip depth so column dips fall inside the plateau — with a
// 95th-pct paperWhite ~222 and dips ~180, 50 puts the clip point (~172) below
// the dips. If Task 7 finds fixed offsets can't both flatten real dips AND keep
// C0C0C0 (~155) below the knee, upgrade to deriving the clip point from the
// measured darkest-paper band (a low percentile among near-paper pixels).
const PAPER_PERCENTILE = 0.95; // per-channel paper white-point estimate
export const CLIP_BELOW_PAPER = 50; // plateau: values >= paperWhite - this map to 255
export const KNEE_WIDTH = 20; // soft-knee width below the clip point (identity below it)
const MIN_PAPER_WHITE = 170; // low-paper guard: skip if the paper is this dim
const MIN_NEAR_WHITE_FRACTION = 0.15; // skip if too little near-white paper is present
const STRIDE = 4; // sample every Nth pixel for the paper-white + near-white estimates

export interface CorrectionResult {
  data: Buffer; // corrected raw pixels (copy of input length)
  applied: boolean; // false when the low-paper guard skipped correction
}

/**
 * Exported alongside CLIP_BELOW_PAPER / KNEE_WIDTH so diagnostics can derive
 * the knee band from the real values rather than restating them (and
 * silently drifting when they are tuned). See clip-chroma.test.ts.
 */
export function estimatePaperWhite(pixels: Buffer, channels: number): [number, number, number] {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const step = channels * STRIDE;
  let total = 0;
  for (let i = 0; i < pixels.length; i += step) {
    hist[0][pixels[i]]++;
    hist[1][pixels[i + 1]]++;
    hist[2][pixels[i + 2]]++;
    total++;
  }
  const pct = (h: Uint32Array): number => {
    const target = total * PAPER_PERCENTILE;
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += h[v];
      if (cum >= target) return v;
    }
    return 255;
  };
  return [pct(hist[0]), pct(hist[1]), pct(hist[2])];
}

/** Clip LUT: identity below the knee, smoothstep up to a 255 plateau. */
export function buildLut(paperWhite: number): Uint8Array {
  const clipPoint = Math.max(1, paperWhite - CLIP_BELOW_PAPER);
  const kneeStart = Math.max(0, clipPoint - KNEE_WIDTH);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    if (v <= kneeStart) lut[v] = v;
    else if (v >= clipPoint) lut[v] = 255;
    else {
      const t = (v - kneeStart) / (clipPoint - kneeStart);
      const s = t * t * (3 - 2 * t); // smoothstep
      lut[v] = Math.round(v * (1 - s) + 255 * s);
    }
  }
  return lut;
}

/**
 * Stage-1 clip LUT anchored on the measured paper white-point's MIN channel,
 * or null when the low-paper guard trips (paper too dim, or too little
 * near-white present) — the tone curve's domain assumes a clipped input, so
 * nothing is applied without stage 1.
 *
 * One shared LUT rather than three per-channel ones: applyClip derives a
 * single lift per pixel from it and adds that lift to all three channels
 * equally, so a neutral pixel stays neutral through the knee and existing
 * small channel differences pass through unamplified. Per-channel LUTs used
 * to multiply near-white chroma noise by the knee's local slope (and, on a
 * paper cast, lift the three channels of a neutral grey unevenly), pushing
 * physically neutral pages over the auto-colour classifier's floor — the 9x
 * amplification recorded in issue #164's DS-575W baseline.
 */
function computeClipLut(pixels: Buffer, channels: number): Uint8Array | null {
  const paperWhite = estimatePaperWhite(pixels, channels);
  const minWhite = Math.min(paperWhite[0], paperWhite[1], paperWhite[2]);

  const nearThresh = minWhite - 15;
  let nearWhite = 0;
  let sampled = 0;
  const step = channels * STRIDE;
  for (let i = 0; i < pixels.length; i += step) {
    sampled++;
    if (pixels[i] >= nearThresh && pixels[i + 1] >= nearThresh && pixels[i + 2] >= nearThresh) {
      nearWhite++;
    }
  }
  if (minWhite < MIN_PAPER_WHITE || nearWhite / sampled < MIN_NEAR_WHITE_FRACTION) {
    return null;
  }
  return buildLut(minWhite);
}

/**
 * Apply the stage-1 clip: per pixel, look the MIN channel up in the shared
 * LUT and add the resulting lift to all three channels, clamped at 255.
 *
 * The min channel is the one scalar that keeps both halves of the old
 * per-channel behaviour. Flattening: at and above the clip point the LUT
 * plateaus at 255, so the lift is 255 - min and every channel saturates —
 * paper (cast included) still lands on pure white. Neutrality: the lift is
 * the same for all three channels, so equal inputs stay equal and existing
 * differences never grow (the clamp can only shrink them). A max- or
 * luma-derived lift would leave the lower channels short of 255 on cast
 * paper, losing the flattening. Anchoring the shared LUT on the min-channel
 * paper white keeps the plateau a superset of the old per-channel one, so no
 * previously-flattened paper pixel comes back.
 *
 * Below the knee the lift is zero and the pixel copies through untouched, so
 * the identity region stays as cheap as the old LUT path.
 */
function applyClip(pixels: Buffer, channels: number, lut: Uint8Array): Buffer {
  // allocUnsafe as in applyLuts: 3-channel pixels are fully overwritten, and
  // anything else falls back to a copy so extra channels survive.
  const out = channels === 3 ? Buffer.allocUnsafe(pixels.length) : Buffer.from(pixels);
  for (let i = 0; i < pixels.length; i += channels) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const lift = lut[min] - min;
    if (lift === 0) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    } else {
      out[i] = r + lift > 255 ? 255 : r + lift;
      out[i + 1] = g + lift > 255 ? 255 : g + lift;
      out[i + 2] = b + lift > 255 ? 255 : b + lift;
    }
  }
  return out;
}

/** Apply a per-channel LUT triplet (a pinned tone curve) to an RGB pixel buffer. */
function applyLuts(pixels: Buffer, channels: number, lut: readonly Uint8Array[]): Buffer {
  // allocUnsafe avoids copying pixels we're about to overwrite entirely; every
  // byte of the 3-channel loop below is written, so no stale memory leaks
  // through. Channels beyond RGB (shouldn't occur — caller normalizes to RGB
  // via toColourspace/removeAlpha) would otherwise be silently dropped, so
  // fall back to a full copy in that case to preserve them.
  const out = channels === 3 ? Buffer.allocUnsafe(pixels.length) : Buffer.from(pixels);
  for (let i = 0; i < pixels.length; i += channels) {
    out[i] = lut[0][pixels[i]];
    out[i + 1] = lut[1][pixels[i + 1]];
    out[i + 2] = lut[2][pixels[i + 2]];
  }
  return out;
}

/**
 * Stage 1 (all printers): near-white clip anchored on the measured paper
 * white-point — flattens the paper band (column dips + show-through +
 * device cast) to pure white via a shared per-pixel lift that keeps neutral
 * content neutral (#164), leaving below-knee content unchanged. Stage 2
 * (printers with a pinned curve): apply the perceptual tone curve to the
 * clipped pixels so content matches how the printed page actually looks.
 * Returns applied=false (pixels copied unchanged) when the low-paper guard
 * trips — the tone curve's domain assumes a clipped input, so it is not
 * applied without stage 1.
 */
export function correctDocumentPixels(
  pixels: Buffer,
  channels: number,
  toneCurve?: ToneCurveName,
): CorrectionResult {
  const clip = computeClipLut(pixels, channels);
  if (!clip) return { data: Buffer.from(pixels), applied: false };
  const clipped = applyClip(pixels, channels, clip);
  return {
    data: toneCurve ? applyLuts(clipped, channels, TONE_CURVES[toneCurve]) : clipped,
    applied: true,
  };
}

/**
 * Shared full-page transform behind correctDocumentImage and
 * correctDocumentImageAuto: decode → auto-orient → clip [→ classify] [→ tone]
 * → single re-encode (3-channel colour or 1-channel greyscale).
 *
 * With conversion "auto", the greyscale verdict runs on the CLIP-stage
 * pixels, after stage 1 but before the tone curve: the clip's plateau
 * neutralises the device cast for free (below-knee colour content passes
 * through untouched, and since #164 the knee adds no chroma of its own),
 * while a pinned perceptual tone curve maps neutral mid-greys to slightly
 * divergent RGB (chroma up to 30 on the et4950-family curve — above the
 * classifier's floor) and would keep every anti-aliased text page in colour.
 * When the guard trips, classification falls back to the decoded pixels. Conversion "force"
 * (SCAN_COLOR_MODE=grayscale without greyscale wire support) skips the
 * verdict entirely — every page encodes single-channel.
 */
async function transformDocumentImage(
  jpeg: Buffer,
  jpegQuality: number,
  toneCurve: ToneCurveName | undefined,
  conversion: GrayscaleConversion,
  whitePoint?: WhitePoint,
  downsample?: Downsample,
): Promise<{ jpeg: Buffer; grayscale: boolean; verdict?: ChromaVerdict }> {
  const [{ orientation, density, channels: sourceChannels }, { data, info }] = await Promise.all([
    sharp(jpeg).metadata(),
    sharp(jpeg)
      .rotate() // bake in EXIF orientation (duplex back pages carry Orientation=3)
      .toColourspace("srgb") // promote grayscale/CMYK sources to 3-channel RGB
      .removeAlpha() // strip any alpha channel .toColourspace() may have kept
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  const clip = computeClipLut(data, info.channels);
  const applied = clip !== null;

  // A source that is already single-channel (e.g. a DS-575W wire-greyscale
  // page under conversion "off") must re-encode single-channel — the srgb
  // promotion above exists for the per-channel LUT work, not the output.
  const sourceGrayscale = sourceChannels === 1;
  let grayscale = conversion === "force" || sourceGrayscale;
  let verdict: ChromaVerdict | undefined;
  const clipped = clip ? applyClip(data, info.channels, clip) : null;
  if (conversion === "auto") {
    // The clip's plateau saturates every channel of a paper pixel, which
    // neutralises the device cast as a side effect — so clipped pixels are
    // already balanced and applying PRINTER_WHITE_POINT on top would correct
    // twice, injecting chroma into neutral mid-tones (~0.123*v on a cast of
    // 28) and pushing plain pages back into colour. The white point is for
    // pixels that arrive as scanned, which here means only the case where the
    // clip guard declined to run.
    verdict = await classifyRawPixels(
      clipped ?? data,
      info.width,
      info.height,
      info.channels,
      clipped ? undefined : whitePoint,
    );
    grayscale = verdict.grayscale || sourceGrayscale;
  }
  const corrected = clipped
    ? toneCurve
      ? applyLuts(clipped, info.channels, TONE_CURVES[toneCurve])
      : clipped
    : data;

  // Skip the re-encode only when it would be a pure no-op: the LUT
  // correction didn't fire AND there's no EXIF orientation baked into the
  // pixels above by `.rotate()` — an orientation tag other than 1 means the
  // decode physically rotated the pixels, and that rotation must still reach
  // the output (e.g. a duplex back page) even when the paper-correction
  // guard trips — AND the page doesn't need its channel count collapsed
  // (an already-single-channel source needs no collapse, so a greyscale
  // outcome alone doesn't force a re-encode) — AND no host-side downsample is
  // pending, or a page that trips the low-paper guard (e.g. a dark photo)
  // would silently ignore SCAN_RESOLUTION under POST_PROCESS=document. Only
  // when none applies is the original buffer identical in substance to what a
  // re-encode would produce, so return it untouched and skip the
  // generational JPEG quality loss. `grayscale: false` on this path means
  // "not converted" — the page ships byte-identical, whatever its channel
  // count.
  const needsRotateBake = orientation !== undefined && orientation !== 1;
  const needsChannelCollapse = grayscale && !sourceGrayscale;
  if (!applied && !needsRotateBake && !needsChannelCollapse && !downsample)
    return { jpeg, grayscale: false, verdict };

  // Both dimensions are computed once, up front, and reused by whichever
  // encode branch runs below — same rounding rule as downsampleJpeg
  // (scaledDimensions), so a folded resize and a standalone one never drift.
  const resizeDims = downsample ? scaledDimensions(info.width, info.height, downsample) : null;
  // The downsample target density wins over the inherited source density —
  // physical size must reflect the OUTPUT resolution, not the input's.
  const outDensity = downsample ? downsample.toDpi : density;

  const rawInput = { raw: { width: info.width, height: info.height, channels: 3 as const } };
  if (grayscale) {
    // Single-channel encode. sharp's `.withMetadata({ density })` attaches an
    // sRGB ICC profile that forces the output back to three channels, so the
    // input's DPI is re-stamped into the fresh encode's JFIF APP0 instead.
    // Orientation is already baked into the pixels by `.rotate()` above, and
    // no EXIF is written, so the output reads as upright — correct.
    let grayPipeline = sharp(corrected, rawInput).toColourspace("b-w");
    if (resizeDims) grayPipeline = grayPipeline.resize({ ...resizeDims, fit: "fill" });
    let out: Buffer = await grayPipeline.jpeg({ quality: jpegQuality }).toBuffer();
    if (outDensity) out = setJfifDensity(out, outDensity);
    return { jpeg: out, grayscale: true, verdict };
  }

  // Preserve the input's DPI on the re-encode. The raw pixel buffer we're
  // encoding from carries no metadata of its own (it's a fresh `sharp()`
  // pipeline over a Buffer, not a decode), so `.withMetadata()` has nothing
  // to inherit — pulling `density` from the ORIGINAL jpeg's metadata (or the
  // downsample target, when one applies) and pinning `orientation: 1`
  // explicitly is required, not just belt-and-braces: the pixels above
  // already had EXIF orientation baked in via `.rotate()`, so writing
  // anything other than "upright" here would rotate the image a second time
  // in EXIF-aware viewers.
  let pipeline = sharp(corrected, rawInput);
  // fit: "fill" absorbs the sub-pixel aspect difference between the two
  // independently-rounded dimensions (see scaledDimensions); the default
  // "cover" would crop instead.
  if (resizeDims) pipeline = pipeline.resize({ ...resizeDims, fit: "fill" });
  if (outDensity) pipeline = pipeline.withMetadata({ density: outDensity, orientation: 1 });
  return {
    jpeg: await pipeline.jpeg({ quality: jpegQuality }).toBuffer(),
    grayscale: false,
    verdict,
  };
}

/**
 * Full page transform: decode → auto-orient → correct [→ resize] → re-encode.
 * `downsample`, when given, folds the finalize-time DPI fallback into this
 * same encode — one decode, one encode, no second compression generation.
 */
export async function correctDocumentImage(
  jpeg: Buffer,
  jpegQuality: number,
  toneCurve?: ToneCurveName,
  downsample?: Downsample,
): Promise<Buffer> {
  return (await transformDocumentImage(jpeg, jpegQuality, toneCurve, "off", undefined, downsample))
    .jpeg;
}

/**
 * Document transform with greyscale conversion integrated: one decode, ONE
 * encode — a converted page comes out as a single-channel greyscale JPEG
 * without the second compression generation (and second decode) that a
 * separate conversion pass would cost. "auto" (SCAN_COLOR_MODE=auto) runs the
 * chroma verdict on the clip-stage pixels; "force" (SCAN_COLOR_MODE=grayscale
 * without greyscale wire support) converts every page, no verdict.
 * `downsample`, when given, folds the finalize-time DPI fallback into the
 * same single encode.
 */
export async function correctDocumentImageAuto(
  jpeg: Buffer,
  jpegQuality: number,
  toneCurve?: ToneCurveName,
  conversion: Exclude<GrayscaleConversion, "off"> = "auto",
  whitePoint?: WhitePoint,
  downsample?: Downsample,
): Promise<{ jpeg: Buffer; grayscale: boolean; verdict?: ChromaVerdict }> {
  return transformDocumentImage(jpeg, jpegQuality, toneCurve, conversion, whitePoint, downsample);
}
