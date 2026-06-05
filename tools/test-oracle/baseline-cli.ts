import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { decodeToRaster } from "../../src/test-oracle/decode.js";
import { measure } from "../../src/test-oracle/oracle.js";
import { detectCrosshairs } from "../../src/test-oracle/crosshairs.js";
import { fitTransform, mapRect } from "../../src/test-oracle/transform.js";
import { crosshairPoints, swatchRect, SWATCHES } from "../test-page/layout.js";
import { saveBaseline, type Baseline } from "../../src/test-oracle/baseline.js";
import { renderOverlay } from "./overlay.js";
import {
  readJsonl,
  trimStatCycles,
  replayCapture,
} from "../../src/esci2/test-support/frida-replay.js";

export interface BaselineMeta {
  fixturePath: string;
  source: "flatbed" | "adf-simplex" | "adf-duplex";
  duplex: boolean;
  trimStatCycles: number;
  printerIp: string;
  destId: number;
  approvedAt: string;
  note?: string;
}

/** Sample the lone JPG in `outputDir`, returning a baseline + overlay PNG. */
export async function buildBaselineFromOutputDir(
  outputDir: string,
  meta: BaselineMeta,
): Promise<{ baseline: Baseline; overlayPng: Buffer }> {
  const jpgs = readdirSync(outputDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort();
  if (jpgs.length === 0) throw new Error(`no .jpg in ${outputDir}`);
  const jpeg = readFileSync(path.join(outputDir, jpgs[0]));
  const raster = await decodeToRaster(jpeg);
  const m = measure(raster);

  const baseline: Baseline = {
    approvedAt: meta.approvedAt,
    note: meta.note,
    replay: {
      fixturePath: meta.fixturePath,
      source: meta.source,
      duplex: meta.duplex,
      trimStatCycles: meta.trimStatCycles,
      printerIp: meta.printerIp,
      destId: meta.destId,
    },
    page: { width: raster.width, height: raster.height },
    crosshairResidualPx: m.crosshairResidualPx,
    swatches: m.swatches,
    greySpreads: m.greySpreads,
    stripeVarianceMax: m.stripeVarianceMax,
    expectedBackPages: [],
    tolerances: {
      swatchDeltaE: 5,
      crosshairPx: Math.max(3, Math.ceil(m.crosshairResidualPx) + 2),
      greySpread: Math.max(8, Math.ceil(Math.max(...m.greySpreads.map((g) => g.spread))) + 4),
      stripeVariance: Math.ceil(m.stripeVarianceMax) + 30,
    },
  };

  const pxCrosshairs = detectCrosshairs(raster);
  const t = fitTransform(crosshairPoints, pxCrosshairs);
  const boxes = SWATCHES.map((s, i) => {
    const r = mapRect(t, swatchRect(i));
    return { x: r.x, y: r.y, w: r.w, h: r.h, label: s.label };
  });
  const overlayPng = await renderOverlay(jpeg, { crosshairs: pxCrosshairs, boxes });
  return { baseline, overlayPng };
}

async function main(): Promise<void> {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error(
      "usage: npm run oracle:baseline -- <fixture.jsonl> [--source flatbed|adf-simplex|adf-duplex]",
    );
    process.exit(1);
  }
  const sourceArg = argValue("--source") ?? "flatbed";
  const duplex = sourceArg === "adf-duplex";
  const outputDir = mkdtempSync(path.join(os.tmpdir(), "oracle-baseline-"));
  try {
    const records = readJsonl(fixturePath);
    const trimmed = trimStatCycles(records, 3);
    const { sessionPromise } = await replayCapture(trimmed, outputDir, duplex, "jpg");
    await sessionPromise;

    const { baseline, overlayPng } = await buildBaselineFromOutputDir(outputDir, {
      fixturePath,
      source: sourceArg as BaselineMeta["source"],
      duplex,
      trimStatCycles: 3,
      printerIp: "192.0.2.58",
      destId: 0x02,
      approvedAt: new Date().toISOString().slice(0, 10),
    });
    const baselinePath = fixturePath.replace(/\.jsonl$/, ".baseline.json");
    const overlayPath = fixturePath.replace(/\.jsonl$/, ".baseline.overlay.png");
    saveBaseline(baselinePath, baseline);
    writeFileSync(overlayPath, overlayPng);
    console.log(`Wrote ${baselinePath}`);
    console.log(`Wrote ${overlayPath} (gitignored — eyeball this, then commit the .json)`);
    console.table(
      baseline.swatches.map((s) => ({ swatch: s.label, R: s.rgb[0], G: s.rgb[1], B: s.rgb[2] })),
    );
    console.log(`crosshair residual: ${baseline.crosshairResidualPx}px`);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
