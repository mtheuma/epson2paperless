import fs from "node:fs";
import path from "node:path";
import { correctDocumentImage } from "./document.js";
import { sortedPageFiles } from "../output.js";
import type { ToneCurveName } from "./tone-curves.js";

export type PostProcessProfile = "none" | "document";

export interface PostProcessOptions {
  /** JPEG quality for the re-encode (document profile). */
  jpegQuality: number;
  /**
   * Pinned per-dialect perceptual tone curve (stage 2 of `document`). Omitted
   * for printers without a captured curve — those get the white-point clip only.
   */
  toneCurve?: ToneCurveName;
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
}

/**
 * Apply the selected profile to every `page_NN.jpg` in the session temp dir,
 * in place, before promote/compose. Reads the original, transforms to a new
 * buffer, writes a sibling `.tmp`, and atomically renames it over the page —
 * so a failed re-encode never leaves a truncated page. On any per-page error,
 * the original is kept and the scan proceeds. No-op for `none`.
 */
export async function postProcessTempPages(
  tempDir: string,
  profile: PostProcessProfile,
  opts: PostProcessOptions,
  log: MinimalLog,
): Promise<void> {
  if (profile === "none") return;
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
      const processed = await applyPostProcess(profile, original, opts);
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
