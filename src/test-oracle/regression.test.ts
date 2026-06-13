import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { loadBaseline } from "./baseline.js";
import { decodeToRaster } from "./decode.js";
import { assertAgainst } from "./oracle.js";
import { readJsonl, trimStatCycles, replayCapture } from "../esci2/test-support/frida-replay.js";
import { readJpegOrientation } from "../exif.js";

// Discover committed baselines anywhere under the Frida capture dir (recursive,
// so a baseline committed in a per-model subfolder is still picked up).
function findBaselines(): string[] {
  const root = "tools/frida-capture/captures";
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map((f) => f.toString())
    .filter((f) => f.endsWith(".baseline.json"))
    .map((f) => path.join(root, f));
}

const baselines = findBaselines();

describe("scan-output oracle regression", () => {
  if (baselines.length === 0) {
    it.skip("no committed baselines yet — capture an ET-4956 compatibility scan (Phase 0/3)", () => {});
    return;
  }

  it.each(baselines)("matches baseline %s", async (baselinePath) => {
    const baseline = loadBaseline(baselinePath);
    const replayOpts = {
      printerIp: baseline.replay.printerIp,
      destId: baseline.replay.destId,
    };
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "oracle-reg-"));
    try {
      const records = trimStatCycles(
        readJsonl(baseline.replay.fixturePath),
        baseline.replay.trimStatCycles,
      );

      // JPG sampling replay.
      const jpg = await replayCapture(
        records,
        outputDir,
        baseline.replay.duplex,
        "jpg",
        replayOpts,
      );
      await jpg.sessionPromise;
      const files = readdirSync(outputDir)
        .filter((f) => f.endsWith(".jpg"))
        .sort();
      // Pin the absolute page count so a dropped/extra-page regression (the
      // PR #79 class) fails here rather than slipping through the page-0-only
      // pixel sampling below.
      expect(files.length, `expected ${baseline.expectedPageCount} JPG page(s)`).toBe(
        baseline.expectedPageCount,
      );
      const raster = await decodeToRaster(readFileSync(path.join(outputDir, files[0])));
      const report = assertAgainst(raster, baseline);
      expect(report.pass, JSON.stringify(report.checks, null, 2)).toBe(true);

      // Per-page EXIF orientation: back pages carry Orientation=3, front pages
      // carry NO tag. Asserting the complement catches an over-tagging regression
      // (every page stamped) that the pixel checks can't see.
      for (let p = 1; p <= files.length; p++) {
        const orient = readJpegOrientation(readFileSync(path.join(outputDir, files[p - 1])));
        const expectedOrient = baseline.expectedBackPages.includes(p) ? 3 : undefined;
        expect(orient, `JPG page ${p} EXIF orientation`).toBe(expectedOrient);
      }

      // PDF replay for EVERY baseline (not just duplex): page count + per-page
      // /Rotate (back pages 180, front pages 0). This exercises the PDF compose
      // path for flatbed/simplex baselines too, where a dropped page or a
      // compose fallback would otherwise go unchecked.
      const pdfDir = mkdtempSync(path.join(os.tmpdir(), "oracle-reg-pdf-"));
      try {
        const pdf = await replayCapture(records, pdfDir, baseline.replay.duplex, "pdf", replayOpts);
        await pdf.sessionPromise;
        const pdfFile = readdirSync(pdfDir).find((f) => f.endsWith(".pdf"));
        expect(pdfFile, "expected a composed PDF in the PDF replay output").toBeDefined();
        const doc = await PDFDocument.load(readFileSync(path.join(pdfDir, pdfFile!)));
        expect(doc.getPageCount(), "PDF page count").toBe(baseline.expectedPageCount);
        for (let i = 0; i < doc.getPageCount(); i++) {
          const expectedRotation = baseline.expectedBackPages.includes(i + 1) ? 180 : 0;
          expect(doc.getPage(i).getRotation().angle, `PDF page ${i + 1}`).toBe(expectedRotation);
        }
      } finally {
        rmSync(pdfDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
