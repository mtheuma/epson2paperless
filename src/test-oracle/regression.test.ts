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
      // Pixel metrics are asserted on the FRONT page only (files[0]) — that's
      // where the swatch grid lives. Later pages are covered by the page-count
      // pin above, the per-page EXIF orientation loop below, and the PDF /Rotate
      // checks; per-page colour is a documented follow-up (multi-front-sheet /
      // WF-3620 path).
      const raster = await decodeToRaster(readFileSync(path.join(outputDir, files[0])));
      const report = assertAgainst(raster, baseline);
      expect(report.pass, JSON.stringify(report.checks, null, 2)).toBe(true);

      // Per-page EXIF orientation: a page is a back page iff its orientation is 3
      // (the ADF U-turn flip). Back pages MUST read 3; front pages MUST NOT be 3.
      // We assert front pages `!== 3` rather than `=== undefined` to stay symmetric
      // with the bake's back-page rule (readJpegOrientation === 3): a printer that
      // stamps a benign front-page tag (e.g. Orientation=1) should not false-fail
      // a correct capture, while an over-tagging regression (front stamped 3) and
      // an under-tagging one (back missing 3) are both still caught.
      for (let p = 1; p <= files.length; p++) {
        const orient = readJpegOrientation(readFileSync(path.join(outputDir, files[p - 1])));
        if (baseline.expectedBackPages.includes(p)) {
          expect(orient, `JPG back page ${p} EXIF orientation`).toBe(3);
        } else {
          expect(orient, `JPG front page ${p} EXIF orientation`).not.toBe(3);
        }
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
