import fs from "node:fs";
import path from "node:path";
import { correctDocumentImage, correctDocumentImageAuto } from "./document.js";
import { classifyJpeg, describeVerdict, toGrayscaleJpeg } from "./auto-color.js";
import { sortedPageFiles } from "../output.js";
import type { ToneCurveName } from "./tone-curves.js";
import type { GrayscaleConversion } from "../config.js";

export type PostProcessProfile = "none" | "document";

export interface PostProcessOptions {
  /** JPEG quality for the re-encode (document profile). */
  jpegQuality: number;
  /**
   * Pinned per-dialect perceptual tone curve (stage 2 of `document`). Omitted
   * for printers without a captured curve — those get the white-point clip only.
   */
  toneCurve?: ToneCurveName;
  /**
   * Finalize-time greyscale pass (default "off"). "auto"
   * (SCAN_COLOR_MODE=auto): pages with no meaningful colour content are
   * re-encoded as single-channel greyscale. "force" (SCAN_COLOR_MODE=grayscale
   * on a model without greyscale wire support): every page converts, no chroma
   * verdict. Under the `document` profile either mode is integrated into that
   * transform (one decode, one encode, with classification on the clip-stage
   * pixels); under `none` it runs as its own conversion pass.
   */
  grayscaleConversion?: GrayscaleConversion;
}

/**
 * Apply the named post-process profile to a single JPEG page. `none` returns
 * the input untouched (no decode). Transform errors are the caller's to handle
 * (see finalizeSession fallback).
 */
export async function applyPostProcess(
  profile: PostProcessProfile,
  jpeg: Buffer,
  opts: PostProcessOptions,
): Promise<Buffer> {
  switch (profile) {
    case "none":
      return jpeg;
    case "document":
      return correctDocumentImage(jpeg, opts.jpegQuality, opts.toneCurve);
  }
}

interface MinimalLog {
  info: (m: string) => void;
  error: (m: string) => void;
  /** Optional — per-page chroma measurements under auto colour mode. */
  debug?: (m: string) => void;
}

/**
 * Apply the selected profile to every `page_NN.jpg` in the session temp dir,
 * in place, before promote/compose. Reads the original, transforms to a new
 * buffer, writes a sibling `.tmp`, and atomically renames it over the page —
 * so a failed re-encode never leaves a truncated page. On any per-page error,
 * the original is kept and the scan proceeds. No-op for `none` unless
 * a greyscale conversion is on.
 */
export async function postProcessTempPages(
  tempDir: string,
  profile: PostProcessProfile,
  opts: PostProcessOptions,
  log: MinimalLog,
): Promise<void> {
  const conversion = opts.grayscaleConversion ?? "off";
  if (profile === "none" && conversion === "off") return;
  let pages: ReturnType<typeof sortedPageFiles>;
  try {
    pages = sortedPageFiles(fs.readdirSync(tempDir), "jpg");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`post-process skipped, could not read temp dir ${tempDir}: ${msg}`);
    return;
  }
  for (const { name } of pages) {
    const full = path.join(tempDir, name);
    const tmp = `${full}.tmp`;
    try {
      const original = await fs.promises.readFile(full);
      let processed: Buffer;
      let grayscaled = false;
      if (profile === "document" && conversion !== "off") {
        // Integrated path: single decode/encode, greyscale verdict (or the
        // forced conversion) between the white-point clip and the tone curve.
        // A failure here means the document transform itself failed, so the
        // outer catch keeping the original page is the right fallback — there
        // is no succeeded-then-reverted intermediate stage to lose.
        const r = await correctDocumentImageAuto(
          original,
          opts.jpegQuality,
          opts.toneCurve,
          conversion,
        );
        processed = r.jpeg;
        grayscaled = r.grayscale;
        if (r.verdict) log.debug?.(`auto colour mode: ${name} ${describeVerdict(r.verdict)}`);
      } else {
        processed = await applyPostProcess(profile, original, opts);
        if (conversion === "force") {
          processed = await toGrayscaleJpeg(processed, opts.jpegQuality);
          grayscaled = true;
        } else if (conversion === "auto") {
          const verdict = await classifyJpeg(processed);
          log.debug?.(`auto colour mode: ${name} ${describeVerdict(verdict)}`);
          if (verdict.grayscale) {
            processed = await toGrayscaleJpeg(processed, opts.jpegQuality);
            grayscaled = true;
          }
        }
      }
      // "force" converts every page by design — announcing each one would be
      // noise; the scanner layer logs the fallback once per session instead.
      if (grayscaled && conversion === "auto") {
        log.info(`auto colour mode: ${name} has no colour content — saved as greyscale`);
      }
      if (processed === original) continue; // pure no-op — keep the printer's bytes untouched
      await fs.promises.writeFile(tmp, processed);
      await fs.promises.rename(tmp, full); // atomic on the same filesystem
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`post-process failed for ${name}, keeping original: ${msg}`);
      try {
        await fs.promises.unlink(tmp);
      } catch {
        /* no partial tmp to clean */
      }
    }
  }
}
