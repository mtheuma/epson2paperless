import sharp from "sharp";
import { readJpegOrientation, setJpegOrientation, setJfifDensity } from "../exif.js";

// SCAN_COLOR_MODE=auto: the scan itself always runs in colour (the DS-575W's
// own "Auto" does the same — Epson's software decides colour vs greyscale
// after capture), and pages with no meaningful colour content are re-encoded
// as single-channel greyscale JPEGs here.
//
// Classification measures per-pixel chroma (max(R,G,B) - min(R,G,B)) on a
// downsampled copy. Downsampling first is load-bearing: single-pixel colour
// fringing on sharp text edges (chroma subsampling + sensor registration)
// averages away, while real colour content survives. One trigger marks a page
// as colour: the fraction of pixels whose chroma clears CHROMA_FLOOR.
// Misclassification is asymmetric: calling a neutral page "colour" just keeps
// bytes, calling a colour page "neutral" loses data — the threshold errs toward
// keeping colour.
//
// There used to be a second "strong" trigger at chroma>64 for small-but-
// saturated marks that covered too little area for the broad one. It is gone
// because it became unreachable, not because the case stopped mattering: every
// chroma>64 pixel also clears 24, so strongFraction <= colourfulFraction always
// holds, and once COLOR_FRACTION dropped to 0.0003 no page could satisfy
// "broad under 0.0003 but strong over 0.0005". Nothing is lost — a page the old
// strong trigger caught had broad >= strong >= 0.0005 > 0.0003, so the broad
// trigger alone now catches everything it did and more. strongFraction is still
// measured and logged: it distinguishes saturated content from a wide, weak
// tint, which is what separated the cream page from the pen mark below.
//
// COLOR_FRACTION was 0.004 until a six-page ET-4956 corpus showed that far too
// high: a small pen mark measured 0.062% of pixels and was silently converted,
// losing its colour (issue #146). Post-clip measurements from that corpus, which
// the test below pins:
//
//   plain black-and-white text  0.005%  -> neutral
//   small text                  0.013%  -> neutral   (the binding noise floor)
//   pen mark                    0.062%  -> colour    (the reported failure)
//   page with a colour logo     0.480%  -> colour
//   cream stock, black content  1.015%  -> colour
//   ordinary colour page       59.767%  -> colour
//
// 0.0003 sits between the 0.013% floor and the 0.062% mark with roughly 2.3x
// either side. That margin is narrower than it looks safe for, and it is what
// the evidence supports rather than a comfortable choice.
//
// Cream stock is deliberately on the "colour" side: its paper tint reads
// 1.015% after the clip, well above any workable cut point, and Epson's own
// software preserves that tint rather than neutralising it. Treating such
// pages as colour is the intended behaviour, not a miss.
//
// Under POST_PROCESS=document the classification runs INSIDE the document
// transform, on the white-point-clipped pixels but BEFORE any pinned tone
// curve composes in (see document.ts): the clip amplifies real colour, while
// a perceptual tone curve maps neutral mid-greys to slightly divergent RGB
// (et4950-family peaks at chroma 30 for neutral inputs 128–148) and would
// push every anti-aliased text edge over the floor.
//
// A scanner with a colour cast renders plain white paper as something other
// than neutral — an ET-4956 reads it as roughly 227/232/255 — and that alone
// puts most of a blank page over the chroma floor, which makes auto colour
// mode useless there (#159). When PRINTER_WHITE_POINT names how the device
// renders white, the cast is divided out before measuring.
//
// The reference has to come from configuration, not from the page. In one
// image a device's cast and a sheet's own tint are indistinguishable: both are
// a uniform chromatic background with darker content on it. Estimating the
// white point from the page under test therefore maps a coloured sheet to
// white and collapses its chroma, converting it to greyscale and destroying
// the colour — see the regression cases in the test file. A fixed per-device
// reference has no such failure, because it does not depend on what is on the
// page: white paper corrects to neutral and converts, while cream stock stays
// chromatic and is kept.
const CLASSIFY_LONG_EDGE = 360; // downsample bound before measuring
const CHROMA_FLOOR = 24; // per-pixel chroma above JPEG noise on neutral scans
export const COLOR_FRACTION = 0.0003; // broad trigger: fraction of pixels over CHROMA_FLOOR
const STRONG_CHROMA_FLOOR = 64; // diagnostic only — saturated vs weak-and-wide

/**
 * The verdict rule, split out so the measured-corpus test can pin the rule and
 * not just the constant.
 */
export function isNeutralVerdict(colourfulFraction: number): boolean {
  return colourfulFraction < COLOR_FRACTION;
}

/**
 * Classification outcome plus the measured fractions behind it — surfaced in
 * the debug log so a field report ("this page should have stayed colour")
 * carries the exact numbers needed to tune the thresholds, without the
 * reporter re-running anything.
 */
export interface ChromaVerdict {
  grayscale: boolean;
  /** Fraction of downsampled pixels with chroma above CHROMA_FLOOR. */
  colourfulFraction: number;
  /**
   * Fraction of downsampled pixels with chroma above STRONG_CHROMA_FLOOR.
   * Diagnostic only — it does not enter the verdict. Useful in a field report
   * because it separates genuinely saturated content from a wide, weak tint.
   */
  strongFraction: number;
}

/** Render a verdict's measurements for the debug log. */
export function describeVerdict(v: ChromaVerdict): string {
  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
  return (
    `chroma>${CHROMA_FLOOR}: ${pct(v.colourfulFraction)} (colour at ${pct(COLOR_FRACTION)}), ` +
    `chroma>${STRONG_CHROMA_FLOOR}: ${pct(v.strongFraction)} (diagnostic) ` +
    `→ ${v.grayscale ? "greyscale" : "colour"}`
  );
}

/**
 * What this scanner outputs when it looks at something white, as measured by
 * `npm run scan:calibrate`. A property of the DEVICE, not of any page — do not
 * confuse it with document.ts's per-page paper-white estimate, which drives the
 * output clip and is a different thing entirely. Undefined disables correction.
 */
export type WhitePoint = readonly [number, number, number];

/**
 * Per-channel LUTs undoing a known device cast: each channel is scaled so the
 * measured white maps to 255. Channels already at 255 are left alone, and the
 * result clamps rather than wraps.
 */
export function buildCastCorrection(whitePoint: WhitePoint): Uint8Array[] {
  return whitePoint.map((white) => {
    const lut = new Uint8Array(256);
    const gain = 255 / Math.max(1, white);
    for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.round(v * gain));
    return lut;
  });
}

/** The chroma verdict over an already-downsampled raw buffer. */
function verdictFromRaw(
  data: Buffer,
  info: { width: number; height: number; channels: number },
  whitePoint?: WhitePoint,
): ChromaVerdict {
  if (info.channels < 3) return { grayscale: true, colourfulFraction: 0, strongFraction: 0 };
  const total = info.width * info.height;
  // Correcting in the measurement pass avoids materialising a second buffer —
  // the corrected pixels are never needed downstream, only their chroma.
  const lut = whitePoint ? buildCastCorrection(whitePoint) : undefined;
  let colourful = 0;
  let stronglyColourful = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = lut ? lut[0][data[i]] : data[i];
    const g = lut ? lut[1][data[i + 1]] : data[i + 1];
    const b = lut ? lut[2][data[i + 2]] : data[i + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > CHROMA_FLOOR) colourful++;
    if (chroma > STRONG_CHROMA_FLOOR) stronglyColourful++;
  }
  const colourfulFraction = colourful / total;
  const strongFraction = stronglyColourful / total;
  return {
    grayscale: isNeutralVerdict(colourfulFraction),
    colourfulFraction,
    strongFraction,
  };
}

/**
 * Classify a JPEG page: no meaningful colour content means a greyscale
 * re-encode would lose nothing. Already-single-channel inputs are trivially
 * greyscale.
 */
export async function classifyJpeg(jpeg: Buffer, whitePoint?: WhitePoint): Promise<ChromaVerdict> {
  const { data, info } = await sharp(jpeg)
    .resize(CLASSIFY_LONG_EDGE, CLASSIFY_LONG_EDGE, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return verdictFromRaw(data, info, whitePoint);
}

/** Boolean shorthand over classifyJpeg. */
export async function isEffectivelyGrayscale(
  jpeg: Buffer,
  whitePoint?: WhitePoint,
): Promise<boolean> {
  return (await classifyJpeg(jpeg, whitePoint)).grayscale;
}

/**
 * Same classification over an in-memory raw pixel buffer. Used by the
 * document+auto path (document.ts), which holds decoded pixels mid-transform
 * — classifying there skips a JPEG decode and, more importantly, lets the
 * verdict run on the clip-stage pixels before the tone curve distorts chroma.
 */
export async function classifyRawPixels(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
  whitePoint?: WhitePoint,
): Promise<ChromaVerdict> {
  if (channels < 3) return { grayscale: true, colourfulFraction: 0, strongFraction: 0 };
  const rawChannels = channels === 4 ? 4 : 3;
  const { data, info } = await sharp(pixels, { raw: { width, height, channels: rawChannels } })
    .resize(CLASSIFY_LONG_EDGE, CLASSIFY_LONG_EDGE, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return verdictFromRaw(data, info, whitePoint);
}

/**
 * Re-encode a neutral page as a single-channel greyscale JPEG, preserving the
 * source's DPI and EXIF orientation.
 *
 * `.toColourspace("b-w")` is what actually yields one channel — sharp's
 * `.withMetadata()` would attach an sRGB ICC profile and silently force the
 * encode back to three, so the source density is re-stamped into the fresh
 * encode's JFIF APP0 instead (setJfifDensity), and the EXIF orientation tag
 * (duplex back pages hold Orientation=3 at this point; pixels never rotate,
 * so the tag stays correct) is re-stamped after it — density first, because
 * the EXIF prepend shifts the JFIF segment.
 */
export async function toGrayscaleJpeg(jpeg: Buffer, jpegQuality: number): Promise<Buffer> {
  const orientation = readJpegOrientation(jpeg);
  const { density } = await sharp(jpeg).metadata();
  let out: Buffer = await sharp(jpeg)
    .toColourspace("b-w")
    .jpeg({ quality: jpegQuality })
    .toBuffer();
  if (density) out = setJfifDensity(out, density);
  if (orientation !== undefined && orientation !== 1) out = setJpegOrientation(out, orientation);
  return out;
}
