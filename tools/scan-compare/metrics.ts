import sharp from "sharp";
import {
  estimatePaperWhite,
  CLIP_BELOW_PAPER,
  KNEE_WIDTH,
} from "../../src/postprocess/document.js";
import { classifyJpeg, type ChromaVerdict } from "../../src/postprocess/auto-color.js";

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
 * GREY/COLOUR verdict come from `verdict` when given. The pipeline runs its
 * greyscale verdict on clip-stage RAW pixels — before any tone curve and
 * before any re-encode — so a + document row passes the verdict returned by
 * correctDocumentImageAuto instead of letting this function classify the
 * processed JPEG: re-classifying a re-encoded buffer attenuates near-floor
 * chroma and can flip the verdict on a near-threshold page.
 */
export async function measurePage(jpeg: Buffer, verdict?: ChromaVerdict): Promise<Metrics> {
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

  const v = verdict ?? (await classifyJpeg(jpeg));
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
    chroma24: 100 * v.colourfulFraction,
    chroma64: 100 * v.strongFraction,
    grayscale: v.grayscale,
  };
}
