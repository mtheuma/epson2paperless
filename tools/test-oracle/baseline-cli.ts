import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decodeToRaster } from "../../src/test-oracle/decode.js";
import { measureWithGeometry, swatchSampleBoxes } from "../../src/test-oracle/oracle.js";
import { readJpegOrientation } from "../../src/exif.js";
import { SWATCHES } from "../test-page/layout.js";
import { saveBaseline, type Baseline } from "../../src/test-oracle/baseline.js";
import { renderOverlay } from "./overlay.js";
import {
  readJsonl,
  trimStatCycles,
  replayCapture,
  REPLAY_PRINTER_IP,
  REPLAY_DEST_ID,
} from "../../src/esci2/test-support/frida-replay.js";

const VALID_SOURCES: BaselineMeta["source"][] = ["flatbed", "adf-simplex", "adf-duplex"];
const USAGE =
  "usage: npm run oracle:baseline -- <fixture.jsonl> [--source flatbed|adf-simplex|adf-duplex] [--trim-stat-cycles N]";
/** The dir regression.test.ts scans for committed baselines. */
const DISCOVERY_ROOT = path.join("tools", "frida-capture", "captures");

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
  const pageBuffers = jpgs.map((f) => readFileSync(path.join(outputDir, f)));
  // Pixel metrics (swatch colour, grey neutrality, stripe variance, crosshair
  // geometry) are sampled from the FRONT page only — page 1 is where the
  // compatibility PDF's swatch grid lives. Later pages (e.g. a duplex back side,
  // which carries text rather than the grid) are covered by expectedPageCount and
  // per-page EXIF orientation, not pixel metrics. Full per-page colour checks are
  // a follow-up gated on a multi-front-sheet fixture / the WF-3620 host-decode
  // path, where per-page pixel bugs are actually reachable.
  const jpeg = pageBuffers[0];
  const raster = await decodeToRaster(jpeg);
  // Single fit: the geometry that produced the measurement also drives the
  // overlay, so the overlay boxes are exactly the regions the baseline sampled.
  const { measurement: m, geometry } = measureWithGeometry(raster);

  // Record the back pages from the replay OUTPUT — the pages the scanner
  // actually tagged with EXIF Orientation=3 — rather than assuming an even-page
  // parity rule, so the baseline matches whatever the replay produces.
  const expectedBackPages = pageBuffers
    .map((buf, i) => (readJpegOrientation(buf) === 3 ? i + 1 : 0))
    .filter((p) => p > 0);

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
    expectedPageCount: jpgs.length,
    expectedBackPages,
    tolerances: {
      swatchDeltaE: 5,
      crosshairPx: Math.max(3, Math.ceil(m.crosshairResidualPx) + 2),
      greySpread: Math.max(8, Math.ceil(Math.max(...m.greySpreads.map((g) => g.spread))) + 4),
      stripeVariance: Math.ceil(m.stripeVarianceMax) + 30,
    },
  };

  const boxes = swatchSampleBoxes(geometry.transform).map((r, i) => ({
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    label: SWATCHES[i].label,
  }));
  const overlayPng = await renderOverlay(jpeg, { crosshairs: geometry.pxCrosshairs, boxes });
  return { baseline, overlayPng };
}

async function main(): Promise<void> {
  // parseArgs rejects unknown flags and a flag whose value is missing (e.g.
  // `--trim-stat-cycles` as the last token), so those fail clearly rather than
  // silently defaulting; the outer catch prints the message.
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: "string", default: "flatbed" },
      "trim-stat-cycles": { type: "string", default: "3" },
    },
  });

  const fixturePath = positionals[0];
  if (!fixturePath) {
    console.error(USAGE);
    process.exit(1);
  }
  // Refuse a path that doesn't end in .jsonl: the output paths are derived by
  // replacing the .jsonl suffix, so a non-matching path would make the baseline
  // / overlay paths equal the fixture path and overwrite the capture itself.
  if (!fixturePath.endsWith(".jsonl")) {
    console.error(`fixture must be a .jsonl file (got: ${fixturePath})`);
    process.exit(1);
  }

  const source = values.source ?? "flatbed";
  if (!VALID_SOURCES.includes(source as BaselineMeta["source"])) {
    console.error(`--source must be one of: ${VALID_SOURCES.join(" | ")} (got: ${source})`);
    process.exit(1);
  }
  const duplex = source === "adf-duplex";

  const trimStr = (values["trim-stat-cycles"] ?? "3").trim();
  // Decimal digits only: Number() would otherwise silently accept hex (0x3) and
  // exponent (1e1) forms that Number.isInteger passes.
  if (!/^\d+$/.test(trimStr)) {
    console.error(
      `--trim-stat-cycles must be a non-negative integer (got: ${JSON.stringify(values["trim-stat-cycles"])})`,
    );
    process.exit(1);
  }
  const trim = Number(trimStr);

  const outputDir = mkdtempSync(path.join(os.tmpdir(), "oracle-baseline-"));
  try {
    const records = readJsonl(fixturePath);
    const trimmed = trimStatCycles(records, trim);
    const { sessionPromise } = await replayCapture(trimmed, outputDir, duplex, "jpg", {
      printerIp: REPLAY_PRINTER_IP,
      destId: REPLAY_DEST_ID,
    });
    await sessionPromise;

    const { baseline, overlayPng } = await buildBaselineFromOutputDir(outputDir, {
      fixturePath,
      source: source as BaselineMeta["source"],
      duplex,
      trimStatCycles: trim,
      printerIp: REPLAY_PRINTER_IP,
      destId: REPLAY_DEST_ID,
      approvedAt: new Date().toISOString().slice(0, 10),
    });
    const baselinePath = fixturePath.replace(/\.jsonl$/, ".baseline.json");
    const overlayPath = fixturePath.replace(/\.jsonl$/, ".baseline.overlay.png");
    saveBaseline(baselinePath, baseline);
    writeFileSync(overlayPath, overlayPng);
    console.log(`Wrote ${baselinePath}`);
    console.log(`Wrote ${overlayPath} (gitignored — eyeball this, then commit the .json)`);
    if (!path.resolve(baselinePath).startsWith(path.resolve(DISCOVERY_ROOT) + path.sep)) {
      console.warn(
        `WARNING: ${baselinePath} is outside ${DISCOVERY_ROOT}; the regression suite ` +
          `only discovers baselines under that directory and will NOT run this one.`,
      );
    }
    console.table(
      baseline.swatches.map((s) => ({ swatch: s.label, R: s.rgb[0], G: s.rgb[1], B: s.rgb[2] })),
    );
    console.log(`crosshair residual: ${baseline.crosshairResidualPx}px`);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
