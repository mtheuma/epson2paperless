import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { isEffectivelyGrayscale, toGrayscaleJpeg } from "./auto-color.js";
import { postProcessTempPages } from "./index.js";
import { setJpegOrientation, readJpegOrientation } from "../exif.js";

const W = 400;
const H = 520;

/** Neutral text-like page: white paper, dark grey "lines", mild neutral noise. */
function neutralPagePixels(): Buffer {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const isText = y % 20 < 2 && x > 40 && x < W - 40;
      // Deterministic per-pixel jitter stands in for scanner noise; equal on
      // all channels, so the page stays truly neutral.
      const jitter = ((x * 31 + y * 17) % 7) - 3;
      const v = (isText ? 40 : 245) + jitter;
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

async function encode(pixels: Buffer): Promise<Buffer> {
  return sharp(pixels, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

describe("isEffectivelyGrayscale", () => {
  it("classifies a neutral text page as greyscale", async () => {
    expect(await isEffectivelyGrayscale(await encode(neutralPagePixels()))).toBe(true);
  });

  it("tolerates sub-floor chroma noise", async () => {
    expect(await isEffectivelyGrayscale(await encode(neutralPageWithChromaNoise()))).toBe(true);
  });

  it("classifies a page with a colour photo region as colour", async () => {
    const buf = neutralPagePixels();
    paintRect(buf, 100, 100, 120, 80, [180, 120, 60]); // ~4.4% of the page
    expect(await isEffectivelyGrayscale(await encode(buf))).toBe(false);
  });

  it("catches a small saturated mark via the strong-chroma trigger", async () => {
    const buf = neutralPagePixels();
    // A highlighter-sized swipe: ~0.35% of the page — under the broad 0.4%
    // fraction, but saturated well past the strong floor.
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

describe("toGrayscaleJpeg", () => {
  it("produces a single-channel JPEG", async () => {
    const out = await toGrayscaleJpeg(await encode(neutralPagePixels()), 90);
    const meta = await sharp(out).metadata();
    expect(meta.channels).toBe(1);
    expect(meta.format).toBe("jpeg");
  });

  it("preserves the EXIF orientation of a duplex back page", async () => {
    const stamped = setJpegOrientation(await encode(neutralPagePixels()), 3);
    const out = await toGrayscaleJpeg(stamped, 90);
    expect(readJpegOrientation(out)).toBe(3);
  });
});

const noopLog = { info: () => {}, error: () => {} };

describe("postProcessTempPages with autoColor", () => {
  it("converts a neutral page and keeps a colour page byte-identical under profile none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-auto-"));
    const colourPixels = neutralPagePixels();
    paintRect(colourPixels, 100, 100, 120, 80, [180, 120, 60]);
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(neutralPagePixels()));
    fs.writeFileSync(path.join(dir, "page_01.jpg"), await encode(colourPixels));
    const colourBefore = fs.readFileSync(path.join(dir, "page_01.jpg"));

    await postProcessTempPages(dir, "none", { jpegQuality: 90, autoColor: true }, noopLog);

    const neutralMeta = await sharp(path.join(dir, "page_00.jpg")).metadata();
    expect(neutralMeta.channels).toBe(1);
    expect(fs.readFileSync(path.join(dir, "page_01.jpg")).equals(colourBefore)).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("composes with the document profile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-auto-doc-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(neutralPagePixels()));
    await postProcessTempPages(dir, "document", { jpegQuality: 90, autoColor: true }, noopLog);
    // metadata() reports the stored channel count; .raw() would re-expand a
    // 1-channel JPEG to 3 on decode and mask the conversion.
    expect((await sharp(path.join(dir, "page_00.jpg")).metadata()).channels).toBe(1);
    const { data } = await sharp(path.join(dir, "page_00.jpg"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(250); // white-point clip still applied first
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("autoColor off leaves everything untouched under profile none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-auto-off-"));
    fs.writeFileSync(path.join(dir, "page_00.jpg"), await encode(neutralPagePixels()));
    const before = fs.readFileSync(path.join(dir, "page_00.jpg"));
    await postProcessTempPages(dir, "none", { jpegQuality: 90 }, noopLog);
    expect(fs.readFileSync(path.join(dir, "page_00.jpg")).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
