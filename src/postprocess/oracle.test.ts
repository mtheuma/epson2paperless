import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { correctDocumentImage } from "./document.js";

// Local-only: the raw ET-4956 test-page JPEG lives under gitignored .reference/.
// Extract it once from the Frida capture (see .reference/notes/2026-07-08-adf-lines-capture-plan.md).
const RAW = path.resolve(".reference/scan-quality-oracle/testpage_raw_front.jpeg");
const run = fs.existsSync(RAW) ? describe : describe.skip;

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
