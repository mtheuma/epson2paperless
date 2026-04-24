import { PDFDocument, degrees } from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";
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
  const buffers = await Promise.all(entries.map((entry) => fs.readFile(path.join(tempDir, entry))));

  for (let i = 0; i < entries.length; i++) {
    const buf = buffers[i];
    const img = await doc.embedJpg(buf);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    if (backSet.has(i + 1)) {
      page.setRotation(degrees(180));
    }
    log.debug(`embedded page ${i + 1}/${entries.length} (${buf.length} B)`);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
