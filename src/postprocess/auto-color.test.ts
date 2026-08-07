import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  isEffectivelyGrayscale,
  toGrayscaleJpeg,
  isNeutralVerdict,
  COLOR_FRACTION,
} from "./auto-color.js";
import { correctDocumentImage, correctDocumentImageAuto } from "./document.js";
import { postProcessTempPages } from "./index.js";
import { setJpegOrientation, readJpegOrientation } from "../exif.js";

const W = 400;
const H = 520;

/** Neutral text-like page: white paper, grey "lines", mild neutral noise. */
function neutralPagePixels(textValue = 40): Buffer {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const isText = y % 20 < 2 && x > 40 && x < W - 40;
      // Deterministic per-pixel jitter stands in for scanner noise; equal on
      // all channels, so the page stays truly neutral.
      const jitter = ((x * 31 + y * 17) % 7) - 3;
      const v = (isText ? textValue : 245) + jitter;
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
    }
  }
  return buf;
}

/** Same page with mild per-channel chroma noise (below the classifier floor). */
function neutralPageWithChromaNoise(): Buffer {
  const buf = neutralPagePixels();
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = Math.min(255, buf[i] + ((i / 3) % 9)); // up to +8 red — under the 24 floor
  }
  return buf;
}

function paintRect(
  buf: Buffer,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 3;
      buf[i] = rgb[0];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[2];
    }
  }
}

/**
 * The canonical colour page: neutral text page plus a photo-sized colour
 * rectangle (~4.4% of the page). The rectangle's size and chroma are what
 * keep the page above the classifier thresholds — every test that needs "a
 * page the classifier calls colour" must use this one definition so a
 * threshold retune only has one fixture to revisit.
 */
function colourPagePixels(): Buffer {
  const buf = neutralPagePixels();
  paintRect(buf, 100, 100, 120, 80, [180, 120, 60]);
  return buf;
}

async function encode(pixels: Buffer, density?: number): Promise<Buffer> {
  let pipeline = sharp(pixels, { raw: { width: W, height: H, channels: 3 } });
  if (density) pipeline = pipeline.withMetadata({ density });
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

describe("isEffectivelyGrayscale", () => {
  it("classifies a neutral text page as greyscale", async () => {
    expect(await isEffectivelyGrayscale(await encode(neutralPagePixels()))).toBe(true);
  });

  it("tolerates sub-floor chroma noise", async () => {
    expect(await isEffectivelyGrayscale(await encode(neutralPageWithChromaNoise()))).toBe(true);
  });

  it("classifies a page with a colour photo region as colour", async () => {
    expect(await isEffectivelyGrayscale(await encode(colourPagePixels()))).toBe(false);
  });

  it("catches a small saturated mark", async () => {
    const buf = neutralPagePixels();
    // A highlighter-sized swipe covering ~0.35% of the page. This used to need
    // the strong (chroma>64) trigger, since it fell under the old 0.4% broad
    // fraction; at 0.03% the broad trigger catches it directly.
    paintRect(buf, 60, 250, 90, 8, [250, 235, 60]);
    expect(await isEffectivelyGrayscale(await encode(buf))).toBe(false);
  });

  it("treats an already-single-channel JPEG as greyscale", async () => {
    const oneChannel = await sharp(await encode(neutralPagePixels()))
      .grayscale()
      .jpeg()
      .toBuffer();
    expect(await isEffectivelyGrayscale(oneChannel)).toBe(true);
  });
});

/**
 * Page-wide colour must survive the AS-SCANNED classifier — the route taken
 * under POST_PROCESS=none, where the delivered pixels still carry the tint, so
 * converting to greyscale would destroy it.
 *
 * Deliberately scoped to that route. Under POST_PROCESS=document these same
 * pages legitimately convert, because the clip has already flattened their
 * paper to pure white (verified: 255/255/255, chroma 0) before classification
 * runs. The tint is gone from the output by then, so converting costs nothing
 * — the per-mode split #146 settled when it decided cream stock stays colour.
 * The test below pins that difference so it reads as a decision.
 *
 * These pass today, and exist to keep it that way. An abandoned attempt to
 * white-balance the classifier's input (issue #159) converted most of them,
 * because a normalisation that estimates the paper white FROM THE PAGE maps a
 * page-wide tint to white and collapses its chroma to zero. Its final revision
 * did spare the saturated sheet, via a channel-spread guard — but that guard
 * could not tell a 30-spread pastel from a 28-spread scanner cast, which is
 * the whole difficulty.
 *
 * The lesson worth keeping: scanner cast and paper tint are the same signal in
 * a single image — a uniform chromatic background with darker content on it —
 * so no per-page statistic separates them. Removing a cast requires knowing the
 * DEVICE's cast independently of the page. Anything that infers it per page
 * will fail these cases.
 */
describe("page-wide colour survives the as-scanned classifier", () => {
  function uniformPage(rgb: [number, number, number]): Buffer {
    const buf = Buffer.alloc(W * H * 3);
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = rgb[0];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[2];
    }
    return buf;
  }

  /** Tinted stock with ordinary black text — the realistic form of the trap. */
  function tintedPageWithText(rgb: [number, number, number]): Buffer {
    const buf = uniformPage(rgb);
    for (let y = 0; y < H; y++) {
      if (y % 20 >= 2) continue;
      for (let x = 40; x < W - 40; x++) {
        const i = (y * W + x) * 3;
        buf[i] = 30;
        buf[i + 1] = 30;
        buf[i + 2] = 30;
      }
    }
    return buf;
  }

  const CASES: [string, Buffer][] = [
    ["saturated red sheet", uniformPage([200, 40, 40])],
    ["dark red sheet (spread 40)", uniformPage([60, 20, 20])],
    ["pastel sheet (spread 30)", uniformPage([220, 200, 190])],
    ["pastel stock with text", tintedPageWithText([220, 200, 190])],
    ["cream card with text", tintedPageWithText([245, 232, 205])],
  ];

  for (const [label, pixels] of CASES) {
    it(`keeps a ${label} in colour`, async () => {
      expect(await isEffectivelyGrayscale(await encode(pixels))).toBe(false);
    });
  }

  it("converts tinted stock under the document profile, by design", async () => {
    // The counterpart to the cases above, pinned so the difference between the
    // two profiles is a recorded decision rather than a surprise. Under
    // `document` the clip flattens the paper to pure white BEFORE the verdict,
    // so the tint is already absent from the delivered pixels and converting
    // loses nothing. Under `none` the same page must stay colour, because
    // there the tint survives into the output.
    const page = await encode(tintedPageWithText([220, 200, 190]));

    const cleaned = await correctDocumentImage(page, 90);
    const { data } = await sharp(cleaned).raw().toBuffer({ resolveWithObject: true });
    const paper = (10 * W + 200) * 3; // a paper pixel, clear of the text rows
    expect(Math.max(data[paper], data[paper + 1], data[paper + 2])).toBe(255);
    expect(Math.max(data[paper], data[paper + 1], data[paper + 2])).toBe(
      Math.min(data[paper], data[paper + 1], data[paper + 2]),
    ); // the clip left no tint behind

    expect((await correctDocumentImageAuto(page, 90, undefined, "auto")).grayscale).toBe(true);
    expect(await isEffectivelyGrayscale(page)).toBe(false); // but not as-scanned
  });
});

describe("thresholds against the measured ET-4956 corpus (#146)", () => {
  // Chroma fractions measured on real hardware after the document clip, with
  // `npm run scan:compare`. Source scans are private, so the measurements are
  // pinned here instead: they are what the thresholds were chosen against, and
  // a change that reclassifies any of these rows needs fresh evidence.
  const CORPUS: { page: string; broad: number; strong: number; neutral: boolean }[] = [
    { page: "plain black-and-white text", broad: 0.00005, strong: 0.00002, neutral: true },
    { page: "small text (binding noise floor)", broad: 0.00013, strong: 0, neutral: true },
    { page: "small coloured pen mark", broad: 0.00062, strong: 0.00001, neutral: false },
    { page: "mostly-neutral page, colour logo", broad: 0.0048, strong: 0, neutral: false },
    { page: "cream stock, black content", broad: 0.01015, strong: 0.00609, neutral: false },
    { page: "ordinary colour page", broad: 0.59767, strong: 0.36077, neutral: false },
  ];

  for (const { page, broad, strong, neutral } of CORPUS) {
    it(`classifies "${page}" as ${neutral ? "neutral" : "colour"}`, () => {
      expect(isNeutralVerdict(broad)).toBe(neutral);
      // Sanity-check the corpus itself: chroma>64 implies chroma>24, so a row
      // with strong above broad would be a transcription error, not a page.
      expect(strong).toBeLessThanOrEqual(broad);
    });
  }

  it("keeps the cut point clear of both the noise floor and the faintest real mark", () => {
    const floor = 0.00013; // highest broad reading among genuinely neutral pages
    const faintest = 0.00062; // pen mark — the page #146 was reported for
    expect(COLOR_FRACTION).toBeGreaterThan(floor);
    expect(COLOR_FRACTION).toBeLessThan(faintest);
  });

  it("subsumes the retired strong trigger", () => {
    // The old rule also called a page colour at strongFraction >= 0.0005.
    // Because strongFraction <= colourfulFraction always holds, any such page
    // has broad >= 0.0005, which the broad trigger now catches on its own —
    // so dropping the strong trigger removed no coverage. Guard the ordering
    // that makes that argument true.
    const retiredStrongThreshold = 0.0005;
    expect(COLOR_FRACTION).toBeLessThan(retiredStrongThreshold);
    expect(isNeutralVerdict(retiredStrongThreshold)).toBe(false);
  });
});

describe("toGrayscaleJpeg", () => {
  it("produces a single-channel JPEG", async () => {
    const out = await toGrayscaleJpeg(await encode(neutralPagePixels()), 90);
    const meta = await sharp(out).metadata();
    expect(meta.channels).toBe(1);
    expect(meta.format).toBe("jpeg");
  });

  it("preserves the source DPI while staying single-channel", async () => {
    const src = await encode(neutralPagePixels(), 400);
    expect((await sharp(src).metadata()).density).toBe(400);
    const out = await toGrayscaleJpeg(src, 90);
    const meta = await sharp(out).metadata();
    expect(meta.channels).toBe(1); // withMetadata({density}) would force 3 — must stay 1
    expect(meta.density).toBe(400);
  });

  it("preserves the EXIF orientation of a duplex back page", async () => {
    const stamped = setJpegOrientation(await encode(neutralPagePixels()), 3);
    const out = await toGrayscaleJpeg(stamped, 90);
    expect(readJpegOrientation(out)).toBe(3);
  });
});

describe("correctDocumentImageAuto", () => {
  it("converts a neutral mid-grey page under a pinned tone curve (classifies pre-curve)", async () => {
    // Text in the 128–148 band: the et4950-family tone curve maps those
    // neutral inputs to chroma 25–30 — above the classifier's floor of 24 —
    // so classifying AFTER the curve would keep every such page in colour.
    // The verdict must run on the clip-stage pixels instead.
    const src = await encode(neutralPagePixels(138), 300);
    const { jpeg, grayscale } = await correctDocumentImageAuto(src, 90, "et4950-family");
    expect(grayscale).toBe(true);
    const meta = await sharp(jpeg).metadata();
    expect(meta.channels).toBe(1);
    expect(meta.density).toBe(300); // document+auto single encode keeps DPI too
  });

  it("keeps a colour page three-channel with the tone curve applied", async () => {
    const src = await encode(colourPagePixels(), 300);
    const { jpeg, grayscale } = await correctDocumentImageAuto(src, 90, "et4950-family");
    expect(grayscale).toBe(false);
    const meta = await sharp(jpeg).metadata();
    expect(meta.channels).toBe(3);
    expect(meta.density).toBe(300);
  });

  it("still converts when the low-paper guard trips (classifies the decoded pixels)", async () => {
    // Full-bleed dark neutral page: guard trips (no near-white paper), but the
    // page is still colourless — auto must classify the raw decode and convert.
    const dark = Buffer.alloc(W * H * 3, 60);
    const src = await sharp(dark, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const { jpeg, grayscale } = await correctDocumentImageAuto(src, 90, undefined);
    expect(grayscale).toBe(true);
    expect((await sharp(jpeg).metadata()).channels).toBe(1);
  });
});

describe("correctDocumentImage with a single-channel source", () => {
  it("keeps a 1-channel greyscale JPEG single-channel through the transform", async () => {
    // DS-575W wire-greyscale pages arrive as 1-channel JPEGs; the document
    // profile (with no conversion pass — resolveGrayscaleConversion returned
    // "off" because the wire already honoured grayscale) must not promote
    // them back to a 3-channel colour encode.
    const src = await sharp(await encode(neutralPagePixels()))
      .toColourspace("b-w")
      .jpeg({ quality: 90 })
      .toBuffer();
    expect((await sharp(src).metadata()).channels).toBe(1);
    const out = await correctDocumentImage(src, 90);
    expect((await sharp(out).metadata()).channels).toBe(1);
    // The white-point clip still ran (paper lifted to pure white).
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(250);
  });
});

const noopLog = { info: () => {}, error: () => {} };

describe("postProcessTempPages with grayscaleConversion=auto", () => {
  it("converts a neutral page and keeps a colour page byte-identical under profile none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-auto-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(neutralPagePixels()));
    fs.writeFileSync(path.join(dir, "page_01.jpg"), await encode(colourPagePixels()));
    const colourBefore = fs.readFileSync(path.join(dir, "page_01.jpg"));

    await postProcessTempPages(
      dir,
      "none",
      { jpegQuality: 90, grayscaleConversion: "auto" },
      noopLog,
    );

    const neutralMeta = await sharp(path.join(dir, "page_00.jpg")).metadata();
    expect(neutralMeta.channels).toBe(1);
    expect(fs.readFileSync(path.join(dir, "page_01.jpg")).equals(colourBefore)).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("composes with the document profile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-auto-doc-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(neutralPagePixels()));
    await postProcessTempPages(
      dir,
      "document",
      { jpegQuality: 90, grayscaleConversion: "auto" },
      noopLog,
    );
    // metadata() reports the stored channel count; .raw() would re-expand a
    // 1-channel JPEG to 3 on decode and mask the conversion.
    expect((await sharp(path.join(dir, "page_00.jpg")).metadata()).channels).toBe(1);
    const { data } = await sharp(path.join(dir, "page_00.jpg"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(250); // white-point clip still applied first
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("conversion off leaves everything untouched under profile none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-auto-off-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(neutralPagePixels()));
    const before = fs.readFileSync(path.join(dir, "page_00.jpg"));
    await postProcessTempPages(dir, "none", { jpegQuality: 90 }, noopLog);
    expect(fs.readFileSync(path.join(dir, "page_00.jpg")).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("postProcessTempPages with grayscaleConversion=force", () => {
  // SCAN_COLOR_MODE=grayscale on a model without greyscale wire support:
  // the scan ran in colour and EVERY page converts — the chroma verdict is
  // bypassed, so even a page with real colour content comes out greyscale.
  it("converts a colour page unconditionally under profile none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-force-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(colourPagePixels()));

    await postProcessTempPages(
      dir,
      "none",
      { jpegQuality: 90, grayscaleConversion: "force" },
      noopLog,
    );

    expect((await sharp(path.join(dir, "page_00.jpg")).metadata()).channels).toBe(1);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("composes with the document profile (clip applied, single encode to one channel)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-force-doc-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(colourPagePixels()));

    await postProcessTempPages(
      dir,
      "document",
      { jpegQuality: 90, grayscaleConversion: "force" },
      noopLog,
    );

    expect((await sharp(path.join(dir, "page_00.jpg")).metadata()).channels).toBe(1);
    const { data } = await sharp(path.join(dir, "page_00.jpg"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(250); // white-point clip still applied first
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names the colour fallback when a page fails to convert", async () => {
    // A page sharp can't decode is kept as-is (keep-original policy) — but
    // under force that means a COLOUR page ships despite an explicit
    // SCAN_COLOR_MODE=grayscale, so the error must say so.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-force-err-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), Buffer.from("not a jpeg"));
    const errors: string[] = [];
    const log = { info: () => {}, error: (m: string) => errors.push(m) };

    await postProcessTempPages(dir, "none", { jpegQuality: 90, grayscaleConversion: "force" }, log);

    expect(errors.some((m) => m.includes("SCAN_COLOR_MODE=grayscale"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves the source DPI through the forced conversion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-force-dpi-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(neutralPagePixels(), 300));

    await postProcessTempPages(
      dir,
      "none",
      { jpegQuality: 90, grayscaleConversion: "force" },
      noopLog,
    );

    const meta = await sharp(path.join(dir, "page_00.jpg")).metadata();
    expect(meta.channels).toBe(1);
    expect(meta.density).toBe(300);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
