import sharp from "sharp";
import { TONE_CURVES, type ToneCurveName } from "./tone-curves.js";
import { classifyRawPixels, type ChromaVerdict } from "./auto-color.js";
import { setJfifDensity } from "../exif.js";

// Tunable constants — starting values; refined against the oracle (Task 7).
// clipPoint = paperWhite - CLIP_BELOW_PAPER (plateau to 255 above it);
// kneeStart = clipPoint - KNEE_WIDTH (identity below it). CLIP_BELOW_PAPER must
// exceed the paper's dip depth so column dips fall inside the plateau — with a
// 95th-pct paperWhite ~222 and dips ~180, 50 puts the clip point (~172) below
// the dips. If Task 7 finds fixed offsets can't both flatten real dips AND keep
// C0C0C0 (~155) below the knee, upgrade to deriving the clip point from the
// measured darkest-paper band (a low percentile among near-paper pixels).
const PAPER_PERCENTILE = 0.95; // per-channel paper white-point estimate
const CLIP_BELOW_PAPER = 50; // plateau: values >= paperWhite - this map to 255
const KNEE_WIDTH = 20; // soft-knee width below the clip point (identity below it)
const MIN_PAPER_WHITE = 170; // low-paper guard: skip if the paper is this dim
const MIN_NEAR_WHITE_FRACTION = 0.15; // skip if too little near-white paper is present
const STRIDE = 4; // sample every Nth pixel for the paper-white + near-white estimates

export interface CorrectionResult {
  data: Buffer; // corrected raw pixels (copy of input length)
  applied: boolean; // false when the low-paper guard skipped correction
}

function estimatePaperWhite(pixels: Buffer, channels: number): [number, number, number] {
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

/** Per-channel LUT: identity below the knee, smoothstep up to a 255 plateau. */
function buildLut(paperWhite: number): Uint8Array {
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
 * Stage-1 clip LUTs anchored on the measured paper white-point, or null when
 * the low-paper guard trips (paper too dim, or too little near-white present)
 * — the tone curve's domain assumes a clipped input, so nothing is applied
 * without stage 1.
 */
function computeClipLuts(
  pixels: Buffer,
  channels: number,
): [Uint8Array, Uint8Array, Uint8Array] | null {
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
  return [buildLut(paperWhite[0]), buildLut(paperWhite[1]), buildLut(paperWhite[2])];
}

/** Compose a pinned tone curve onto the adaptive clip LUT: final = tone∘clip. */
function composeToneCurve(
  clip: [Uint8Array, Uint8Array, Uint8Array],
  toneCurve: ToneCurveName,
): [Uint8Array, Uint8Array, Uint8Array] {
  const tone = TONE_CURVES[toneCurve];
  const out: Uint8Array[] = [];
  for (let c = 0; c < 3; c++) {
    const composed = new Uint8Array(256);
    for (let v = 0; v < 256; v++) composed[v] = tone[c][clip[c][v]];
    out.push(composed);
  }
  return [out[0], out[1], out[2]];
}

/** Apply a per-channel LUT triplet to an RGB pixel buffer. */
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
 * Stage 1 (all printers): per-channel near-white clip anchored on the measured
 * paper white-point — neutralizes the paper cast and flattens the paper band
 * (column dips + show-through) to pure white, leaving below-knee content
 * unchanged. Stage 2 (printers with a pinned curve): compose the perceptual
 * tone curve onto the clip so content matches how the printed page actually
 * looks. Returns applied=false (pixels copied unchanged) when the low-paper
 * guard trips — the tone curve's domain assumes a clipped input, so it is not
 * applied without stage 1.
 */
export function correctDocumentPixels(
  pixels: Buffer,
  channels: number,
  toneCurve?: ToneCurveName,
): CorrectionResult {
  const clip = computeClipLuts(pixels, channels);
  if (!clip) return { data: Buffer.from(pixels), applied: false };
  const lut = toneCurve ? composeToneCurve(clip, toneCurve) : clip;
  return { data: applyLuts(pixels, channels, lut), applied: true };
}

/**
 * Shared full-page transform behind correctDocumentImage and
 * correctDocumentImageAuto: decode → auto-orient → clip [→ classify] [→ tone]
 * → single re-encode (3-channel colour or 1-channel greyscale).
 *
 * With autoColor, the greyscale verdict runs on the CLIP-stage pixels, after
 * stage 1 but before the tone curve: the clip amplifies real colour content
 * (small saturated marks survive), while a pinned perceptual tone curve maps
 * neutral mid-greys to slightly divergent RGB (chroma up to 30 on the
 * et4950-family curve — above the classifier's floor) and would keep every
 * anti-aliased text page in colour. When the guard trips, classification
 * falls back to the decoded pixels.
 */
async function transformDocumentImage(
  jpeg: Buffer,
  jpegQuality: number,
  toneCurve: ToneCurveName | undefined,
  autoColor: boolean,
): Promise<{ jpeg: Buffer; grayscale: boolean; verdict?: ChromaVerdict }> {
  const [{ orientation, density }, { data, info }] = await Promise.all([
    sharp(jpeg).metadata(),
    sharp(jpeg)
      .rotate() // bake in EXIF orientation (duplex back pages carry Orientation=3)
      .toColourspace("srgb") // promote grayscale/CMYK sources to 3-channel RGB
      .removeAlpha() // strip any alpha channel .toColourspace() may have kept
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  const clip = computeClipLuts(data, info.channels);
  const applied = clip !== null;

  let grayscale = false;
  let verdict: ChromaVerdict | undefined;
  let corrected: Buffer;
  if (autoColor) {
    const clipped = clip ? applyLuts(data, info.channels, clip) : null;
    verdict = await classifyRawPixels(clipped ?? data, info.width, info.height, info.channels);
    grayscale = verdict.grayscale;
    // tone∘clip applied in two passes equals the composed LUT of the
    // non-auto path — the clip-stage buffer had to exist for classification.
    corrected = clipped
      ? toneCurve
        ? applyLuts(clipped, info.channels, TONE_CURVES[toneCurve])
        : clipped
      : data;
  } else {
    corrected = clip
      ? applyLuts(data, info.channels, toneCurve ? composeToneCurve(clip, toneCurve) : clip)
      : data;
  }

  // Skip the re-encode only when it would be a pure no-op: the LUT
  // correction didn't fire AND there's no EXIF orientation baked into the
  // pixels above by `.rotate()` — an orientation tag other than 1 means the
  // decode physically rotated the pixels, and that rotation must still reach
  // the output (e.g. a duplex back page) even when the paper-correction
  // guard trips — AND the page isn't being converted to greyscale. Only when
  // none applies is the original buffer identical in substance to what a
  // re-encode would produce, so return it untouched and skip the
  // generational JPEG quality loss.
  const needsRotateBake = orientation !== undefined && orientation !== 1;
  if (!applied && !needsRotateBake && !grayscale) return { jpeg, grayscale: false, verdict };

  const rawInput = { raw: { width: info.width, height: info.height, channels: 3 as const } };
  if (grayscale) {
    // Single-channel encode. sharp's `.withMetadata({ density })` attaches an
    // sRGB ICC profile that forces the output back to three channels, so the
    // input's DPI is re-stamped into the fresh encode's JFIF APP0 instead.
    // Orientation is already baked into the pixels by `.rotate()` above, and
    // no EXIF is written, so the output reads as upright — correct.
    let out = await sharp(corrected, rawInput)
      .toColourspace("b-w")
      .jpeg({ quality: jpegQuality })
      .toBuffer();
    if (density) out = setJfifDensity(out, density);
    return { jpeg: out, grayscale: true, verdict };
  }

  // Preserve the input's DPI on the re-encode. The raw pixel buffer we're
  // encoding from carries no metadata of its own (it's a fresh `sharp()`
  // pipeline over a Buffer, not a decode), so `.withMetadata()` has nothing
  // to inherit — pulling `density` from the ORIGINAL jpeg's metadata and
  // pinning `orientation: 1` explicitly is required, not just belt-and-
  // braces: the pixels above already had EXIF orientation baked in via
  // `.rotate()`, so writing anything other than "upright" here would rotate
  // the image a second time in EXIF-aware viewers.
  let pipeline = sharp(corrected, rawInput);
  if (density) pipeline = pipeline.withMetadata({ density, orientation: 1 });
  return {
    jpeg: await pipeline.jpeg({ quality: jpegQuality }).toBuffer(),
    grayscale: false,
    verdict,
  };
}

/** Full page transform: decode → auto-orient → correct → re-encode. */
export async function correctDocumentImage(
  jpeg: Buffer,
  jpegQuality: number,
  toneCurve?: ToneCurveName,
): Promise<Buffer> {
  return (await transformDocumentImage(jpeg, jpegQuality, toneCurve, false)).jpeg;
}

/**
 * Document transform with SCAN_COLOR_MODE=auto integrated: one decode, the
 * greyscale verdict on the clip-stage pixels, and ONE encode — a neutral page
 * comes out as a single-channel greyscale JPEG without the second compression
 * generation (and second decode) that a separate conversion pass would cost.
 */
export async function correctDocumentImageAuto(
  jpeg: Buffer,
  jpegQuality: number,
  toneCurve?: ToneCurveName,
): Promise<{ jpeg: Buffer; grayscale: boolean; verdict?: ChromaVerdict }> {
  return transformDocumentImage(jpeg, jpegQuality, toneCurve, true);
}
