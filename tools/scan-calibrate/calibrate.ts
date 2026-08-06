/**
 * Measure how a scanner renders plain white paper, for PRINTER_WHITE_POINT.
 *
 *   npm run scan:calibrate -- <scan-of-a-blank-white-sheet.jpg|pdf>
 *
 * Why this exists: SCAN_COLOR_MODE=auto decides colour vs greyscale from how
 * far each pixel is from neutral, and a scanner with a colour cast renders
 * white paper as something other than neutral — enough, on some models, to put
 * a whole blank page over the threshold and stop auto mode ever converting
 * (issue #159).
 *
 * The correction cannot be derived from the page being classified. In a single
 * image a device's cast and a sheet's own tint are the same signal, so a
 * per-page estimate would divide out genuine paper colour and convert coloured
 * stock to greyscale. Measuring the device once, from a sheet known to be
 * white, removes that ambiguity: the resulting correction is a property of the
 * scanner and is applied identically to every page.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { estimatePaperWhite } from "../../src/postprocess/document.js";
import { MAX_DEVICE_CAST } from "../../src/config.js";

/** Pull every embedded JPEG out of a PDF, as tools/scan-compare does. */
function extractJpegs(buf: Buffer): Buffer[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) starts.push(i);
  }
  const out: Buffer[] = [];
  for (let s = 0; s < starts.length; s++) {
    const limit = s + 1 < starts.length ? starts[s + 1] : buf.length;
    let end = -1;
    for (let i = limit - 2; i > starts[s]; i--) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
        end = i + 2;
        break;
      }
    }
    if (end > 0) out.push(buf.subarray(starts[s], end));
  }
  return out;
}

function pagesOf(file: string): Buffer[] {
  const buf = fs.readFileSync(file);
  if (path.extname(file).toLowerCase() === ".pdf") return extractJpegs(buf);
  return [buf];
}

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: npm run scan:calibrate -- <scan-of-a-blank-white-sheet.jpg|pdf>");
    console.error("");
    console.error("Scan one sheet of ordinary white paper with SCAN_COLOR_MODE unset and");
    console.error("POST_PROCESS=none, so the file holds the scanner's own output.");
    process.exitCode = 1;
    return;
  }

  const pages = pagesOf(file);
  if (pages.length === 0) {
    console.error(`No image found in ${file}`);
    process.exitCode = 1;
    return;
  }

  const { data, info } = await sharp(pages[0])
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels < 3) {
    console.error(
      "That scan is single-channel greyscale, so it carries no colour cast to measure.\n" +
        "Re-scan in colour (SCAN_COLOR_MODE unset or 'color').",
    );
    process.exitCode = 1;
    return;
  }

  const paperWhite = estimatePaperWhite(data, info.channels);
  const cast = Math.max(...paperWhite) - Math.min(...paperWhite);

  // A blank sheet should be overwhelmingly paper. Anything else means content,
  // heavy shadow, or a lid left open — all of which bias the estimate.
  const near = paperWhite.map((v) => v - 25);
  let paperish = 0;
  let sampled = 0;
  for (let i = 0; i < data.length; i += info.channels * 4) {
    sampled++;
    if (data[i] >= near[0] && data[i + 1] >= near[1] && data[i + 2] >= near[2]) paperish++;
  }
  const paperFraction = paperish / sampled;

  console.log("");
  console.log(`  measured paper white   ${paperWhite.join(" / ")}`);
  console.log(`  colour cast            ${cast}`);
  console.log(`  page that is paper     ${(paperFraction * 100).toFixed(1)}%`);
  console.log("");

  if (paperFraction < 0.8) {
    console.log("  ⚠  Less than 80% of this page reads as paper, so the measurement is");
    console.log("     probably picking up content or shadow. Re-scan a genuinely blank");
    console.log("     white sheet, flat on the glass or squarely through the feeder.");
    console.log("");
    process.exitCode = 1;
    return;
  }

  if (cast > MAX_DEVICE_CAST) {
    console.log(`  ⚠  A channel spread of ${cast} is far larger than any scanner's own cast`);
    console.log(
      `     (${MAX_DEVICE_CAST} is the accepted ceiling). This sheet is almost certainly`,
    );
    console.log("     tinted — cream or coloured stock rather than plain white. Using it");
    console.log("     would over-correct every later scan and push genuinely coloured");
    console.log("     pages toward greyscale. Re-scan a plain WHITE sheet.");
    console.log("");
    process.exitCode = 1;
    return;
  }

  if (cast <= 4) {
    console.log("  This scanner is already close to neutral, so PRINTER_WHITE_POINT would");
    console.log("  change very little. Leaving it unset is fine.");
    console.log("");
    return;
  }

  console.log("  Add to your environment:");
  console.log("");
  console.log(`      PRINTER_WHITE_POINT=${paperWhite.join(":")}`);
  console.log("");
  console.log("  It only affects SCAN_COLOR_MODE=auto, and only the colour-vs-greyscale");
  console.log("  decision — the pixels written to disk are unchanged.");
  console.log("");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
