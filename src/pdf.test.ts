import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { composePdfFromJpegs } from "./pdf.js";

const SAMPLE_JPEG_PATH = "test-fixtures/sample-page.jpg";

describe("composePdfFromJpegs", () => {
  let tempDir: string;
  let sampleJpeg: Buffer;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
    sampleJpeg = fs.readFileSync(SAMPLE_JPEG_PATH);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writePage(n: number, data: Buffer = sampleJpeg): void {
    const name = `page_${String(n).padStart(2, "0")}.jpg`;
    fs.writeFileSync(path.join(tempDir, name), data);
  }

  it("throws when tempDir has no page files", async () => {
    await expect(composePdfFromJpegs(tempDir, { backPages: [] })).rejects.toThrow(/no page files/i);
  });

  it("produces a valid single-page PDF", async () => {
    writePage(1);
    const buf = await composePdfFromJpegs(tempDir, { backPages: [] });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
  });

  it("produces a three-page PDF with /Rotate=180 on page 2", async () => {
    writePage(1);
    writePage(2);
    writePage(3);
    const buf = await composePdfFromJpegs(tempDir, { backPages: [2] });
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    expect(doc.getPage(1).getRotation().angle).toBe(180);
    expect(doc.getPage(2).getRotation().angle).toBe(0);
  });

  it("silently skips out-of-range indices in backPages", async () => {
    writePage(1);
    const buf = await composePdfFromJpegs(tempDir, { backPages: [5, 99] });
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
  });

  it("reads pages in numeric order (page_10 after page_02)", async () => {
    writePage(1);
    writePage(2);
    writePage(10);
    // Mark "back" pages by sequential position (1-based in the sorted order):
    // pos 1 = page_01, pos 2 = page_02, pos 3 = page_10. Rotate pos 3.
    const buf = await composePdfFromJpegs(tempDir, { backPages: [3] });
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    expect(doc.getPage(1).getRotation().angle).toBe(0);
    expect(doc.getPage(2).getRotation().angle).toBe(180);
  });

  it("sizes page to A4 points for a 300-DPI sample JPEG", async () => {
    writePage(1);
    const buf = await composePdfFromJpegs(tempDir, { backPages: [] });
    const doc = await PDFDocument.load(buf);
    const { width, height } = doc.getPage(0).getSize();
    // sample-page.jpg is 2481 × 3506 px at 300 DPI → 595.44 × 841.44 pt
    expect(width).toBeCloseTo(595.44, 1);
    expect(height).toBeCloseTo(841.44, 1);
  });

  it("converts a 300-DPI fixture to correct point dimensions", async () => {
    // Generate a 600 × 300 px JPEG at 300 DPI programmatically.
    const fixture = await sharp({
      create: { width: 600, height: 300, channels: 3, background: "#808080" },
    })
      .jpeg({ quality: 80 })
      .withMetadata({ density: 300 })
      .toBuffer();

    writePage(1, fixture);
    const buf = await composePdfFromJpegs(tempDir, { backPages: [] });
    const doc = await PDFDocument.load(buf);
    const { width, height } = doc.getPage(0).getSize();
    // 600 × 72 / 300 = 144 pt,  300 × 72 / 300 = 72 pt
    expect(width).toBeCloseTo(144, 1);
    expect(height).toBeCloseTo(72, 1);
  });

  it("falls back to pixel-as-point when JPEG has no density metadata", async () => {
    // Generate a 200 × 100 px JPEG without density metadata.
    const fixture = await sharp({
      create: { width: 200, height: 100, channels: 3, background: "#c0c0c0" },
    })
      .jpeg({ quality: 80 })
      .withMetadata({})
      .toBuffer();

    writePage(1, fixture);
    const buf = await composePdfFromJpegs(tempDir, { backPages: [] });
    const doc = await PDFDocument.load(buf);
    const { width, height } = doc.getPage(0).getSize();
    // No density → 72-DPI fallback → pixel = point
    expect(width).toBeCloseTo(200, 1);
    expect(height).toBeCloseTo(100, 1);
  });
});
