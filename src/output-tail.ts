import fs from "node:fs";
import { createLogger } from "./logger.js";
import { generateFilename, writeOutputFile, promoteTempPagesToOutput } from "./output.js";
import { composePdfFromJpegs } from "./pdf.js";
import { uploadAllToPaperless, type PaperlessUploadOptions } from "./paperless-upload.js";

const log = createLogger("output-tail");

export interface FinalizeSessionArgs {
  sessionTempDir: string;
  outputDir: string;
  sessionTs: Date;
  action: "jpg" | "pdf";
  backPageIndices: number[];
  paperless: PaperlessUploadOptions | undefined;
}

/**
 * Promote per-session temp JPGs to final output (JPG copy or composed PDF),
 * optionally upload to Paperless, then remove the temp dir.
 *
 * Caller is responsible for closing any open sockets BEFORE calling this —
 * see `scanner.ts:973-981` for the rationale (TLS close_notify must hit
 * the wire before the synchronous disk write or the printer RSTs).
 */
export async function finalizeSession(args: FinalizeSessionArgs): Promise<void> {
  const { sessionTempDir, outputDir, sessionTs, action, backPageIndices, paperless } = args;
  try {
    let savedPaths: string[];
    if (action === "jpg") {
      savedPaths = promoteTempPagesToOutput(sessionTempDir, outputDir, sessionTs, "jpg");
      log.info(`Scan complete — wrote ${savedPaths.length} JPG file(s); first: ${savedPaths[0]}`);
    } else {
      try {
        const pdfBuf = await composePdfFromJpegs(sessionTempDir, { backPages: backPageIndices });
        const pdfName = generateFilename(sessionTs, "pdf");
        const pdfPath = writeOutputFile(outputDir, pdfName, pdfBuf);
        log.info(`Scan complete — saved PDF to ${pdfPath}`);
        savedPaths = [pdfPath];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`PDF composition failed: ${msg}. Falling back to JPG output.`);
        savedPaths = promoteTempPagesToOutput(sessionTempDir, outputDir, sessionTs, "jpg");
        log.info(`Saved ${savedPaths.length} JPG file(s) as fallback`);
      }
    }
    if (paperless) {
      await uploadAllToPaperless(savedPaths, paperless);
    }
  } finally {
    fs.rmSync(sessionTempDir, { recursive: true, force: true });
  }
}
