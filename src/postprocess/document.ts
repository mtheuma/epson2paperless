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

export interface CorrectionResult {
  data: Buffer; // corrected raw pixels (copy of input length)
  applied: boolean; // false when the low-paper guard skipped correction
}

function estimatePaperWhite(pixels: Buffer, channels: number): [number, number, number] {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < pixels.length; i += channels) {
    hist[0][pixels[i]]++;
    hist[1][pixels[i + 1]]++;
    hist[2][pixels[i + 2]]++;
  }
  const total = pixels.length / channels;
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
 * Per-channel near-white clip anchored on the measured paper white-point.
 * Neutralizes the paper cast and flattens the paper band (with its column dips
 * and show-through) to pure white, while leaving below-knee content unchanged.
 * Returns applied=false (pixels copied unchanged) when the low-paper guard trips.
 */
export function correctDocumentPixels(pixels: Buffer, channels: number): CorrectionResult {
  const paperWhite = estimatePaperWhite(pixels, channels);
  const minWhite = Math.min(paperWhite[0], paperWhite[1], paperWhite[2]);

  const nearThresh = minWhite - 15;
  let nearWhite = 0;
  const total = pixels.length / channels;
  for (let i = 0; i < pixels.length; i += channels) {
    if (pixels[i] >= nearThresh && pixels[i + 1] >= nearThresh && pixels[i + 2] >= nearThresh) {
      nearWhite++;
    }
  }
  if (minWhite < MIN_PAPER_WHITE || nearWhite / total < MIN_NEAR_WHITE_FRACTION) {
    return { data: Buffer.from(pixels), applied: false };
  }

  const lut = [buildLut(paperWhite[0]), buildLut(paperWhite[1]), buildLut(paperWhite[2])];
  const out = Buffer.from(pixels); // copy; preserves any channel beyond RGB
  for (let i = 0; i < pixels.length; i += channels) {
    out[i] = lut[0][pixels[i]];
    out[i + 1] = lut[1][pixels[i + 1]];
    out[i + 2] = lut[2][pixels[i + 2]];
  }
  return { data: out, applied: true };
}
