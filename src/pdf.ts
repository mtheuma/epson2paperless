import { PDFDocument, degrees } from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createLogger } from "./logger.js";
import { sortedPageFiles } from "./output.js";

const log = createLogger("pdf");

export interface PdfComposeOptions {
  /**
   * 1-based page indices to rotate 180°. Out-of-range indices are silently
   * ignored — back-side detection is a best-effort hint from the scanner.
   */
  backPages: number[];
}

/**
 * Composes a PDF from `page_NN.jpg` files in `tempDir`, ordered numerically.
 * Pages whose 1-based index appears in `options.backPages` get PDF
 * `/Rotate = 180` (the ADF U-turn path produces physically flipped
 * back-side JPEGs).
 * Throws if `tempDir` has no page files.
 */
export async function composePdfFromJpegs(
  tempDir: string,
  options: PdfComposeOptions,
): Promise<Buffer> {
  const entries = sortedPageFiles(await fs.readdir(tempDir), "jpg");

  if (entries.length === 0) {
    throw new Error(`composePdfFromJpegs: no page files in ${tempDir}`);
  }

  const doc = await PDFDocument.create();
  const backSet = new Set(options.backPages);

  // File reads are independent; embedJpg mutates `doc` so that stays sequential.
  const buffers = await Promise.all(
    entries.map((entry) => fs.readFile(path.join(tempDir, entry.name))),
  );

  for (let i = 0; i < entries.length; i++) {
    const buf = buffers[i];
    const img = await doc.embedJpg(buf);

    // JPEG pixels ≠ PDF points.  Read the JFIF/EXIF density so the page
    // box matches the physical page size (e.g. 595 × 841 pt for A4 at
    // 300 DPI).  When density metadata is absent or invalid, fall back to
    // 72 DPI (pixel = point), which preserves the previous behaviour.
    const meta = await sharp(buf).metadata();
    const dpi =
      meta.density !== undefined && Number.isFinite(meta.density) && meta.density > 0
        ? meta.density
        : 72;
    const ptW = (img.width * 72) / dpi;
    const ptH = (img.height * 72) / dpi;

    const page = doc.addPage([ptW, ptH]);
    page.drawImage(img, { x: 0, y: 0, width: ptW, height: ptH });
    if (backSet.has(i + 1)) {
      page.setRotation(degrees(180));
    }
    log.debug(
      `embedded page ${i + 1}/${entries.length} (${buf.length} B, ${dpi} DPI → ${ptW.toFixed(1)} × ${ptH.toFixed(1)} pt)`,
    );
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
