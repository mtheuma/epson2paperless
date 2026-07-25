import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  correctDocumentImage,
  estimatePaperWhite,
  buildLut,
  CLIP_BELOW_PAPER,
  KNEE_WIDTH,
} from "./document.js";
import { classifyRawPixels, describeVerdict } from "./auto-color.js";
import { decodeToRaster } from "../test-oracle/decode.js";
import { measure } from "../test-oracle/oracle.js";

// Local-only diagnostic for issue #146 (auto colour mode declining to convert
// under POST_PROCESS=document).
//
// The hypothesis: the document profile's stage-1 clip builds an INDEPENDENT
// knee per channel, each anchored on that channel's own paper white. When the
// paper carries a cast the three knees sit at different positions, so NEUTRAL
// greys inside the knee band come out with chroma injected — which the
// auto-colour classifier (which since #143 runs on exactly these clip-stage
// pixels) reads as "this page has colour" and declines to convert.
//
// Point it at any scan:
//   CLIP_DIAG_IMAGE=/path/to/scan.jpg npx vitest run src/postprocess/clip-chroma
// It defaults to the gitignored raw ET-4956 test-page scan that oracle.test.ts
// uses. NOTE that the test page is a WEAK probe for this defect: its twelve
// large saturated swatches inflate the 95th-percentile white-point estimate,
// lifting the knee band above where the grey swatches sit. An ordinary
// black-and-white text page is the case that reproduces — paper dominates the
// histogram, and anti-aliased text edges sweep the knee band.
//
// The ramp probe below is page-independent: it applies the real LUTs built from
// whatever white point this scan yields, so it quantifies the injection for
// this hardware even when the page itself doesn't trip it.
const DEFAULT_IMAGE = ".reference/scan-quality-oracle/testpage_raw_front.jpeg";
const IMAGE = path.resolve(process.env.CLIP_DIAG_IMAGE ?? DEFAULT_IMAGE);
const run = fs.existsSync(IMAGE) ? describe : describe.skip;

/** Injected chroma across a neutral 0..255 ramp, for the given paper white. */
function rampInjection(paperWhite: [number, number, number]): {
  peak: number;
  peakAt: number;
  overFloor: number[];
} {
  const luts = paperWhite.map((p) => buildLut(p));
  let peak = 0;
  let peakAt = -1;
  const overFloor: number[] = [];
  for (let v = 0; v < 256; v++) {
    const out = luts.map((l) => l[v]);
    const chroma = Math.max(...out) - Math.min(...out);
    if (chroma > peak) {
      peak = chroma;
      peakAt = v;
    }
    if (chroma > 24) overFloor.push(v); // 24 = the classifier's CHROMA_FLOOR
  }
  return { peak, peakAt, overFloor };
}

run("clip-induced chroma on neutral greys (#146 diagnostic)", () => {
  it("reports paper white, knee band, ramp injection and classifier verdicts", async () => {
    const raw = fs.readFileSync(IMAGE);

    const rasterRaw = await decodeToRaster(raw);
    // Clip only, no tone curve — this is the buffer the classifier sees, and
    // matches what a no-tone-curve dialect (DS-575W) produces end to end.
    const rasterClipped = await decodeToRaster(await correctDocumentImage(raw, 90));

    const paperWhite = estimatePaperWhite(rasterRaw.data, rasterRaw.channels);
    const band = paperWhite.map((p) => {
      const clipPoint = Math.max(1, p - CLIP_BELOW_PAPER);
      return { clipPoint, kneeStart: Math.max(0, clipPoint - KNEE_WIDTH) };
    });

    const out: string[] = [];
    out.push(`image             ${path.relative(process.cwd(), IMAGE)}`);
    out.push(`raster            ${rasterRaw.width}x${rasterRaw.height}`);
    out.push(
      `paper white       R=${paperWhite[0]} G=${paperWhite[1]} B=${paperWhite[2]}` +
        `  (cast spread ${Math.max(...paperWhite) - Math.min(...paperWhite)})`,
    );
    out.push(
      `knee bands        R ${band[0].kneeStart}..${band[0].clipPoint}` +
        `   G ${band[1].kneeStart}..${band[1].clipPoint}` +
        `   B ${band[2].kneeStart}..${band[2].clipPoint}`,
    );

    // 1. Page-independent probe: what the clip does to neutral input, for this
    //    hardware's white point. This is the defect itself, isolated.
    const ramp = rampInjection(paperWhite);
    out.push("");
    out.push("neutral-ramp probe (what the clip does to perfectly neutral greys):");
    out.push(
      `  peak injected chroma   ${ramp.peak}${ramp.peakAt >= 0 ? ` at input ${ramp.peakAt}` : ""}`,
    );
    out.push(
      `  inputs over floor(24)  ${
        ramp.overFloor.length
          ? `${ramp.overFloor[0]}..${ramp.overFloor[ramp.overFloor.length - 1]} (${ramp.overFloor.length} levels)`
          : "none — no injection on this white point"
      }`,
    );

    // 2. Test-page swatches, when the scan is of the compatibility page. The
    //    crosshair fit throws on any other document, which is expected.
    try {
      const mRaw = measure(rasterRaw);
      const mClipped = measure(rasterClipped);
      out.push("");
      out.push("neutral grey swatches (spread = max-min channel = injected chroma):");
      for (const { label } of mRaw.greySpreads) {
        const before = mRaw.greySpreads.find((s) => s.label === label)!.spread;
        const after = mClipped.greySpreads.find((s) => s.label === label)!.spread;
        const rgb = mRaw.swatches.find((s) => s.label === label)!.rgb;
        const luma = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
        const inBand = luma >= band[1].kneeStart && luma <= band[1].clipPoint;
        out.push(
          `  ${label}  raw luma ${String(luma).padStart(3)} ${inBand ? "IN knee band " : "outside band"}` +
            `  spread ${String(before).padStart(3)} -> ${String(after).padStart(3)}` +
            `  ${after > before ? `(+${after - before} injected)` : "(no injection)"}`,
        );
      }
    } catch {
      out.push("");
      out.push("grey swatches      skipped (not a compatibility test-page scan)");
    }

    // 3. The actual production question: what does auto colour mode decide?
    const verdictRaw = await classifyRawPixels(
      rasterRaw.data,
      rasterRaw.width,
      rasterRaw.height,
      rasterRaw.channels,
    );
    const verdictClipped = await classifyRawPixels(
      rasterClipped.data,
      rasterClipped.width,
      rasterClipped.height,
      rasterClipped.channels,
    );
    out.push("");
    out.push("auto-colour classifier on the whole page:");
    out.push(`  pre-clip   ${describeVerdict(verdictRaw)}`);
    out.push(`  clipped    ${describeVerdict(verdictClipped)}   <- what production classifies`);
    console.log("\n" + out.join("\n") + "\n");

    // Sanity only — the numbers above are the deliverable. A scan of white
    // paper must yield a plausible white point, or the sample (or the decode)
    // is wrong and everything above it is noise.
    expect(Math.min(...paperWhite)).toBeGreaterThan(170);
  }, 60_000);
});
