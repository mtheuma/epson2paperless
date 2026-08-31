import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { measurePage } from "./metrics.js";
import { correctDocumentImage, correctDocumentImageAuto } from "../../src/postprocess/document.js";

async function solidJpeg(rgb: [number, number, number]): Promise<Buffer> {
  const w = 64,
    h = 64,
    buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe("measurePage", () => {
  it("classifies the measured page itself by default", async () => {
    const colour = await solidJpeg([200, 40, 40]);
    const m = await measurePage(colour);
    expect(m.grayscale).toBe(false);
    expect(m.chroma24).toBeGreaterThan(50);
  });

  it("takes chroma columns and verdict from a supplied verdict while pixel metrics describe the page", async () => {
    // The pipeline classifies clip-stage pixels BEFORE the tone curve and
    // before any re-encode, so a + document row carries the pipeline's own
    // verdict. Modelled with extremes: a fabricated neutral verdict against
    // a saturated colour page.
    const colour = await solidJpeg([200, 40, 40]);
    const m = await measurePage(colour, {
      grayscale: true,
      colourfulFraction: 0.0001,
      strongFraction: 0,
    });
    expect(m.grayscale).toBe(true); // verdict: from the supplied object
    expect(m.chroma24).toBeCloseTo(0.01); // chroma columns: from the supplied object
    expect(m.paperWhite[0]).toBeGreaterThan(m.paperWhite[2]); // pixels: from colour (R >> B)
  });

  it("reports exactly the pipeline's verdict when composed like the CLI's + document row", async () => {
    // Near-threshold page: neutral paper with a small muted mark below the
    // clip knee — the case where classifying the re-encoded clip JPEG
    // attenuates chroma and can flip the verdict vs the pipeline.
    const w = 400,
      h = 400;
    const buf = Buffer.alloc(w * h * 3, 220);
    for (let y = 200; y < 210; y++)
      for (let x = 200; x < 207; x++) {
        const i = (y * w + x) * 3;
        buf[i] = 157;
        buf[i + 1] = 130;
        buf[i + 2] = 130;
      }
    const jpeg = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const auto = await correctDocumentImageAuto(jpeg, 90);
    const processed = await correctDocumentImage(jpeg, 90);
    const m = await measurePage(processed, auto.verdict);
    expect(auto.verdict).toBeDefined();
    expect(m.grayscale).toBe(auto.verdict!.grayscale);
    expect(m.chroma24).toBe(100 * auto.verdict!.colourfulFraction);
    expect(m.chroma64).toBe(100 * auto.verdict!.strongFraction);
  });
});
