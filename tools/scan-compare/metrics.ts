import sharp from "sharp";
import {
  estimatePaperWhite,
  CLIP_BELOW_PAPER,
  KNEE_WIDTH,
} from "../../src/postprocess/document.js";
import { classifyJpeg } from "../../src/postprocess/auto-color.js";

export interface Metrics {
  width: number;
  height: number;
  dpi: number | undefined;
  channels: number | undefined;
  whitePct: number;
  paperWhite: [number, number, number];
  castSpread: number;
  atRiskPct: number;
  kneePct: number;
  chroma24: number;
  chroma64: number;
  grayscale: boolean;
}

/**
 * Measure one page. All pixel metrics describe `jpeg`; the chroma columns and
 * GREY/COLOUR verdict come from `verdictSource` when given. The pipeline runs
 * its greyscale verdict on clip-stage pixels BEFORE any tone curve (the curve
 * maps neutral mid-greys to chroma above the classifier's floor), so a toned
 * page must pass its clip-only counterpart here — classifying the toned
 * pixels would print a verdict the service never uses.
 */
export async function measurePage(jpeg: Buffer, verdictSource?: Buffer): Promise<Metrics> {
  const meta = await sharp(jpeg).metadata();
  const { data, info } = await sharp(jpeg)
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const paperWhite = estimatePaperWhite(data, info.channels);
  // Band boundaries use the green channel as representative; the three differ
  // only by the cast, which is reported separately.
  const clipPoint = Math.max(1, paperWhite[1] - CLIP_BELOW_PAPER);
  const kneeStart = Math.max(0, clipPoint - KNEE_WIDTH);

  let white = 0;
  let nonWhite = 0;
  let atRisk = 0;
  let knee = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    total++;
    if (r === 255 && g === 255 && b === 255) {
      white++;
      continue;
    }
    const luma = (r + g + b) / 3;
    if (luma >= 250) continue; // effectively background, not detail
    nonWhite++;
    if (luma >= clipPoint) atRisk++;
    else if (luma >= kneeStart) knee++;
  }

  const verdict = await classifyJpeg(verdictSource ?? jpeg);
  return {
    width: info.width,
    height: info.height,
    dpi: meta.density,
    channels: meta.channels,
    whitePct: (100 * white) / total,
    paperWhite,
    castSpread: Math.max(...paperWhite) - Math.min(...paperWhite),
    atRiskPct: nonWhite ? (100 * atRisk) / nonWhite : 0,
    kneePct: nonWhite ? (100 * knee) / nonWhite : 0,
    chroma24: 100 * verdict.colourfulFraction,
    chroma64: 100 * verdict.strongFraction,
    grayscale: verdict.grayscale,
  };
}
