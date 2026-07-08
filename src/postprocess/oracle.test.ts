import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { correctDocumentImage } from "./document.js";

// Local-only: the raw ET-4956 test-page JPEG lives under gitignored .reference/.
// Extract it once from the Frida capture (see .reference/notes/2026-07-08-adf-lines-capture-plan.md).
const RAW = path.resolve(".reference/scan-quality-oracle/testpage_raw_front.jpeg");
const EPSON = path.resolve(".reference/scan-quality-oracle/testpage_epson_enhanced_1.jpg");
const run = fs.existsSync(RAW) ? describe : describe.skip;
const runPair = fs.existsSync(RAW) && fs.existsSync(EPSON) ? describe : describe.skip;

async function swatchMean(jpeg: Buffer, cx: number, cy: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let y = cy - 30; y < cy + 30; y++)
    for (let x = cx - 50; x < cx + 50; x++) {
      const i = (y * W + x) * 3;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  return [r / n, g / n, b / n];
}

run("oracle: ET-4956 test-page front", () => {
  it("neutralizes the paper background and drops the column-line residual", async () => {
    const out = await correctDocumentImage(fs.readFileSync(RAW), 90);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    // top margin band (blank paper), rows 20..90
    let rSum = 0,
      bSum = 0,
      n = 0;
    const colLum: number[] = new Array(W).fill(0);
    for (let y = 20; y < 90; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        rSum += data[i];
        bSum += data[i + 2];
        n++;
        colLum[x] += (data[i] + data[i + 1] + data[i + 2]) / 3;
      }
    const rMean = rSum / n,
      bMean = bSum / n;
    expect(rMean).toBeGreaterThan(250); // background ~white
    expect(Math.abs(bMean - rMean)).toBeLessThan(4); // cast neutralized
    // per-column line residual in the paper is near-flat
    const cols = colLum.map((s) => s / 70);
    const mean = cols.reduce((a, b) => a + b, 0) / W;
    const std = Math.sqrt(cols.reduce((a, b) => a + (b - mean) ** 2, 0) / W);
    expect(std).toBeLessThan(2); // raw was ~7.5
  });

  it("preserves the C0C0C0 grey swatch (does not clip light content to white)", async () => {
    const out = await correctDocumentImage(fs.readFileSync(RAW), 90);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    // C0C0C0 swatch (index 6) centre on the uncropped 2481x3506 raster
    // (test-page geometry: gridLeft≈87.6pt, row 2 → ~x615, y1561 px @ ~4.17 px/pt).
    const cx = 615,
      cy = 1561;
    let sum = 0,
      n = 0;
    for (let y = cy - 30; y < cy + 30; y++)
      for (let x = cx - 50; x < cx + 50; x++) {
        const i = (y * W + x) * 3;
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
        n++;
      }
    const mean = sum / n;
    expect(mean).toBeGreaterThan(120); // not crushed dark
    expect(mean).toBeLessThan(235); // survived — NOT clipped up to paper white
  });
});

// Stage 2: the pinned et4950-family tone curve should bring the white-point-
// corrected scan close to how the page actually looks (Epson's rendering).
runPair("oracle: ET-4956 tone curve vs Epson", () => {
  const C0 = { cx: 615, cy: 1561 }; // C0C0C0 swatch centre

  it("lifts the C0C0C0 grey toward the Epson/printed-page value", async () => {
    const raw = fs.readFileSync(RAW);
    const noCurve = await correctDocumentImage(raw, 90);
    const withCurve = await correctDocumentImage(raw, 90, "et4950-family");
    const nc = await swatchMean(noCurve, C0.cx, C0.cy);
    const wc = await swatchMean(withCurve, C0.cx, C0.cy);
    const ep = await swatchMean(fs.readFileSync(EPSON), C0.cx, C0.cy);
    // white-point-only leaves it dark (~166); the tone curve lifts it (~234),
    // landing near Epson's ~230 and well above the untoned value.
    expect(wc[0]).toBeGreaterThan(nc[0] + 40);
    expect(Math.abs(wc[0] - ep[0])).toBeLessThan(20);
  });

  it("brings whole-page brightness in line with Epson", async () => {
    const withCurve = await correctDocumentImage(fs.readFileSync(RAW), 90, "et4950-family");
    const a = await sharp(withCurve).raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(fs.readFileSync(EPSON)).raw().toBuffer({ resolveWithObject: true });
    const luma = (buf: Buffer) => buf.reduce((s, v) => s + v, 0) / buf.length;
    expect(Math.abs(luma(a.data) - luma(b.data))).toBeLessThan(8); // was ~32 apart untoned
  });
});
