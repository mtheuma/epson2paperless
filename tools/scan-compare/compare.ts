/**
 * Scan-quality comparison harness.
 *
 * Measures one or more scans (PDF or image) with a single consistent metric set,
 * so outputs from different sources are directly comparable: our pipeline with
 * and without POST_PROCESS=document, a vendor reference (Epson Scan 2), and the
 * same page re-scanned on different hardware later.
 *
 * The metrics are chosen to discriminate the failure modes seen in issue #146
 * and the PR #143 field reports:
 *
 *   - `white%`      how hard the background is flattened to pure 255.
 *   - `at-risk%`    non-white detail sitting within CLIP_BELOW_PAPER of the
 *                   measured paper white — i.e. detail our document profile
 *                   would force to pure white (torn edges, soft shadows, the
 *                   faint fibres around spiral-binding tabs).
 *   - `knee%`       non-white detail inside the clip's soft-knee band, where the
 *                   three independent per-channel curves lift unevenly and
 *                   inject chroma into neutral greys.
 *   - `chroma`      the auto-colour classifier's own measurements and verdict.
 *
 * Usage:
 *   npm run scan:compare -- <file...> [--document] [--tone-curve <name>]
 *
 * `--document` additionally runs each page through the document profile and
 * prints the after-metrics beneath the before, which is the before/after view
 * for judging a change to the clip. `--tone-curve <name>` (implies
 * `--document`) also applies that pinned tone curve, so the `+ document` row
 * shows what the pipeline actually delivers for a dialect that has one —
 * without it the row is clip-only, which is how issue #158 went unnoticed.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  correctDocumentImage,
  CLIP_BELOW_PAPER,
  KNEE_WIDTH,
} from "../../src/postprocess/document.js";
import { parseCliArgs, type CliArgs } from "./cli-args.js";
import { measurePage, type Metrics } from "./metrics.js";

/**
 * Pull every embedded JPEG out of a PDF (pdf-lib and Epson Scan 2 both embed
 * DCTDecode streams). Each candidate is validated by decoding it, so a stray
 * marker sequence inside metadata can't produce a bogus page.
 */
async function extractJpegs(buf: Buffer): Promise<Buffer[]> {
  const starts: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) starts.push(i);
  }
  const out: Buffer[] = [];
  for (let s = 0; s < starts.length; s++) {
    const limit = s + 1 < starts.length ? starts[s + 1] : buf.length;
    // Last EOI before the next SOI is the end of this image.
    let end = -1;
    for (let i = limit - 2; i > starts[s]; i--) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
        end = i + 2;
        break;
      }
    }
    if (end < 0) continue;
    const candidate = buf.subarray(starts[s], end);
    try {
      const m = await sharp(candidate).metadata();
      // Skip EXIF thumbnails and other incidental tiny images.
      if ((m.width ?? 0) >= 200 && (m.height ?? 0) >= 200) out.push(candidate);
    } catch {
      /* not a decodable image — skip */
    }
  }
  return out;
}

async function pagesOf(file: string): Promise<Buffer[]> {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4).toString("latin1") === "%PDF") return extractJpegs(buf);
  return [buf];
}

function row(label: string, m: Metrics): string {
  const f = (v: number, w = 6, d = 2) => v.toFixed(d).padStart(w);
  return (
    `  ${label.padEnd(26)}` +
    `${String(m.width).padStart(5)}x${String(m.height).padEnd(5)}` +
    `${String(m.dpi ?? "?").padStart(4)}dpi ` +
    `${String(m.channels ?? "?")}ch  ` +
    `white ${f(m.whitePct, 5, 1)}%  ` +
    `paper ${m.paperWhite.join("/").padEnd(11)} cast ${String(m.castSpread).padStart(2)}  ` +
    `at-risk ${f(m.atRiskPct, 5, 1)}%  knee ${f(m.kneePct, 5, 1)}%  ` +
    `chroma>24 ${f(m.chroma24, 6, 3)}% >64 ${f(m.chroma64, 6, 3)}%  ` +
    `=> ${m.grayscale ? "GREY " : "COLOUR"}`
  );
}

async function main(): Promise<void> {
  const usage = "usage: npm run scan:compare -- <file...> [--document] [--tone-curve <name>]";
  let parsed: CliArgs;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  const { files, withDocument, toneCurve } = parsed;
  if (files.length === 0) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nclip config: CLIP_BELOW_PAPER=${CLIP_BELOW_PAPER} KNEE_WIDTH=${KNEE_WIDTH}` +
      (toneCurve ? ` TONE_CURVE=${toneCurve}` : "") +
      `   (at-risk = detail our clip forces to pure white; knee = detail the clip tints)\n`,
  );

  for (const file of files) {
    const stat = fs.statSync(file);
    const pages = await pagesOf(file);
    console.log(
      `${path.basename(file)}  (${(stat.size / 1024).toFixed(0)} KB, ${pages.length} page(s))`,
    );
    for (let i = 0; i < pages.length; i++) {
      const label = pages.length > 1 ? `page ${i + 1}` : "page";
      console.log(row(label, await measurePage(pages[i])));
      if (withDocument) {
        // The applied tone curve is named once in the header line — repeating
        // it per row would push the metrics out of column alignment. The
        // chroma/verdict columns of a toned row come from the clip-only
        // output, because the pipeline classifies clip-stage pixels before
        // the tone curve (see measurePage).
        const clipped = await correctDocumentImage(pages[i], 90);
        const processed = toneCurve ? await correctDocumentImage(pages[i], 90, toneCurve) : clipped;
        console.log(
          row(`${label} + document`, await measurePage(processed, toneCurve ? clipped : undefined)),
        );
      }
    }
    console.log("");
  }
}

// Other tools in this directory are CommonJS-transpiled by tsx, so avoid
// top-level await and drive main() from a promise chain instead.
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
