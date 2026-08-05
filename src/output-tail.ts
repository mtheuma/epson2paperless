import fs from "node:fs";
import { createLogger } from "./logger.js";
import { generateFilename, writeOutputFile, promoteTempPagesToOutput } from "./output.js";
import { composePdfFromJpegs } from "./pdf.js";
import { uploadAllToPaperless, type PaperlessUploadOptions } from "./paperless-upload.js";
import { postProcessTempPages, type PostProcessProfile } from "./postprocess/index.js";
import type { ToneCurveName } from "./postprocess/tone-curves.js";
import type { PaperWhite } from "./postprocess/auto-color.js";
import { DEFAULT_JPEG_QUALITY, type GrayscaleConversion } from "./config.js";

const log = createLogger("output-tail");

export interface FinalizeSessionArgs {
  sessionTempDir: string;
  outputDir: string;
  sessionTs: Date;
  action: "jpg" | "pdf";
  /**
   * 1-based indices of back pages needing the 180° /Rotate compensation on
   * the PDF path. Not "all back pages": dialects whose hardware delivers back
   * sides upright (duplexBackRotated: false) record none here.
   */
  backPageIndices: number[];
  paperless: PaperlessUploadOptions | undefined;
  postProcess?: PostProcessProfile;
  jpegQuality?: number;
  /**
   * Greyscale pass before promote/compose (default "off"): "auto" converts
   * colourless pages, "force" converts every page (SCAN_COLOR_MODE=grayscale
   * on a model without greyscale wire support).
   */
  grayscaleConversion?: GrayscaleConversion;
  /** Pinned per-dialect tone curve for the `document` profile; omit for none. */
  toneCurve?: ToneCurveName;
  /** SCAN_PAPER_WHITE — device cast reference for the auto-colour verdict. */
  paperWhite?: PaperWhite;
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
  const {
    sessionTempDir,
    outputDir,
    sessionTs,
    action,
    backPageIndices,
    paperless,
    postProcess = "none",
    jpegQuality = DEFAULT_JPEG_QUALITY,
    grayscaleConversion = "off",
    toneCurve,
    paperWhite,
  } = args;
  try {
    await postProcessTempPages(
      sessionTempDir,
      postProcess,
      { jpegQuality, toneCurve, grayscaleConversion, paperWhite },
      log,
    );
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
      // Defense-in-depth: `uploadAllToPaperless` is engineered to never
      // reject (per-file errors are .catch-wrapped inside the module), but
      // a future refactor or a bug above the per-file catch would otherwise
      // turn a completed local scan into a failed scan from one-shot's
      // perspective (it maps any rejection here to exit code 1). Wrap the
      // boundary so the local file is treated as authoritative.
      try {
        await uploadAllToPaperless(savedPaths, paperless);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `Paperless upload threw — local scan preserved at ${savedPaths.join(", ")}: ${msg}`,
        );
      }
    }
  } finally {
    fs.rmSync(sessionTempDir, { recursive: true, force: true });
  }
}
