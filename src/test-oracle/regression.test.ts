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

// Discover committed baselines under the Frida capture dir.
function findBaselines(): string[] {
  const root = "tools/frida-capture/captures";
  if (!existsSync(root)) return [];
  return readdirSync(root)
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
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "oracle-reg-"));
    try {
      const records = trimStatCycles(
        readJsonl(baseline.replay.fixturePath),
        baseline.replay.trimStatCycles,
      );

      // JPG sampling replay.
      const jpg = await replayCapture(records, outputDir, baseline.replay.duplex, "jpg");
      await jpg.sessionPromise;
      const files = readdirSync(outputDir)
        .filter((f) => f.endsWith(".jpg"))
        .sort();
      // Guard before indexing so a dropped-page regression fails with a clear
      // message rather than an opaque path.join(dir, undefined) TypeError.
      expect(files.length, `expected at least one JPG page, got ${files.length}`).toBeGreaterThan(
        0,
      );
      const raster = await decodeToRaster(readFileSync(path.join(outputDir, files[0])));
      const report = assertAgainst(raster, baseline);
      expect(report.pass, JSON.stringify(report.checks, null, 2)).toBe(true);

      // Duplex: back pages carry EXIF Orientation=3 (JPG) and /Rotate=180 (PDF);
      // front pages carry neither. Driven by baseline.expectedBackPages.
      if (baseline.replay.duplex) {
        for (const p of baseline.expectedBackPages) {
          expect(
            files.length,
            `baseline expects back page ${p} but only ${files.length} page(s) were produced`,
          ).toBeGreaterThanOrEqual(p);
          const orient = readJpegOrientation(readFileSync(path.join(outputDir, files[p - 1])));
          expect(orient, `JPG back page ${p}`).toBe(3);
        }

        const pdfDir = mkdtempSync(path.join(os.tmpdir(), "oracle-reg-pdf-"));
        try {
          const pdf = await replayCapture(records, pdfDir, true, "pdf");
          await pdf.sessionPromise;
          const pdfFile = readdirSync(pdfDir).find((f) => f.endsWith(".pdf"));
          expect(pdfFile, "expected a composed PDF in the PDF replay output").toBeDefined();
          const doc = await PDFDocument.load(readFileSync(path.join(pdfDir, pdfFile!)));
          expect(doc.getPageCount(), "PDF page count").toBe(files.length);
          for (let i = 0; i < doc.getPageCount(); i++) {
            const expected = baseline.expectedBackPages.includes(i + 1) ? 180 : 0;
            expect(doc.getPage(i).getRotation().angle, `PDF page ${i + 1}`).toBe(expected);
          }
        } finally {
          rmSync(pdfDir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
