import fs from "node:fs";
import path from "node:path";
import { correctDocumentImage, correctDocumentImageAuto } from "./document.js";
import { classifyJpeg, describeVerdict, toGrayscaleJpeg, type WhitePoint } from "./auto-color.js";
import { downsampleJpeg, type Downsample } from "./downsample.js";
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
  /**
   * How this scanner renders white paper (PRINTER_WHITE_POINT). When set, the
   * auto-colour verdict divides the device's cast out before measuring, so a
   * cast scanner's blank pages are not all judged colour. Omitted means no
   * correction. Never inferred from the page — see auto-color.ts.
   */
  whitePoint?: WhitePoint;
  /**
   * Finalize-time host-side DPI downsample — the fallback arm for a
   * SCAN_RESOLUTION the wire couldn't reach. Folded into the document /
   * grayscale re-encode below when either also runs (single decode-encode);
   * otherwise applied as its own standalone pass. Never upscales — see
   * downsample.ts.
   */
  downsample?: Downsample;
}

/**
 * Apply the named post-process profile to a single JPEG page. `none` returns
 * the input untouched (no decode) — downsample folding for that path happens
 * in postProcessTempPages, since `applyPostProcess` alone has no way to know
 * a caller wants a resize without a document transform. Transform errors are
 * the caller's to handle (see finalizeSession fallback).
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
      return correctDocumentImage(jpeg, opts.jpegQuality, opts.toneCurve, opts.downsample);
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
  if (profile === "none" && conversion === "off" && opts.downsample === undefined) return;
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
      // Tracks whether opts.downsample (if any) has already been folded into
      // a decode/encode pass that ran below, so the standalone downsampleJpeg
      // call at the end never chains a second re-encode on top.
      let downsampleFolded = false;
      if (profile === "document" && conversion !== "off") {
        // Integrated path: single decode/encode, greyscale verdict (or the
        // forced conversion) between the white-point clip and the tone curve,
        // plus the DPI downsample when one is pending. A failure here means
        // the document transform itself failed, so the outer catch keeping
        // the original page is the right fallback — there is no
        // succeeded-then-reverted intermediate stage to lose.
        const r = await correctDocumentImageAuto(
          original,
          opts.jpegQuality,
          opts.toneCurve,
          conversion,
          opts.whitePoint,
          opts.downsample,
        );
        processed = r.jpeg;
        grayscaled = r.grayscale;
        downsampleFolded = true;
        if (r.verdict) log.debug?.(`auto colour mode: ${name} ${describeVerdict(r.verdict)}`);
      } else {
        processed = await applyPostProcess(profile, original, opts);
        if (profile === "document") downsampleFolded = true; // correctDocumentImage folded it
        if (conversion === "force") {
          processed = await toGrayscaleJpeg(processed, opts.jpegQuality, opts.downsample);
          grayscaled = true;
          downsampleFolded = true;
        } else if (conversion === "auto") {
          const verdict = await classifyJpeg(processed, opts.whitePoint);
          log.debug?.(`auto colour mode: ${name} ${describeVerdict(verdict)}`);
          if (verdict.grayscale) {
            processed = await toGrayscaleJpeg(processed, opts.jpegQuality, opts.downsample);
            grayscaled = true;
            downsampleFolded = true;
          }
        }
      }
      // Neither the document transform nor a grayscale conversion ran (or
      // "auto" ran but kept the page in colour) — apply the DPI fallback as
      // its own standalone pass instead of silently dropping it.
      if (opts.downsample && !downsampleFolded) {
        processed = await downsampleJpeg(processed, opts.downsample, opts.jpegQuality);
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
      // Under "force" the kept original is a COLOUR page shipping against an
      // explicit SCAN_COLOR_MODE=grayscale — the one signal the user gets.
      const kept =
        conversion === "force"
          ? "keeping original in colour despite SCAN_COLOR_MODE=grayscale"
          : "keeping original";
      log.error(`post-process failed for ${name}, ${kept}: ${msg}`);
      try {
        await fs.promises.unlink(tmp);
      } catch {
        /* no partial tmp to clean */
      }
    }
  }
}
