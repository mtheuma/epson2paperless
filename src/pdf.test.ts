import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("sizes each page to the embedded JPEG's native dimensions", async () => {
    writePage(1);
    const buf = await composePdfFromJpegs(tempDir, { backPages: [] });
    const doc = await PDFDocument.load(buf);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(100);
  });
});
