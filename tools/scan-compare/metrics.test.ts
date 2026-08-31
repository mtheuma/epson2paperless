import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { measurePage } from "./metrics.js";

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

  it("takes chroma columns and verdict from verdictSource while pixel metrics describe the page", async () => {
    // The pipeline classifies clip-stage pixels BEFORE the tone curve, so a
    // toned row must carry its clip-only counterpart's verdict. Modelled here
    // with two extremes: verdict from a neutral grey page, metrics from a
    // saturated colour page.
    const colour = await solidJpeg([200, 40, 40]);
    const neutral = await solidJpeg([180, 180, 180]);
    const m = await measurePage(colour, neutral);
    expect(m.grayscale).toBe(true); // verdict: from neutral
    expect(m.chroma24).toBeLessThan(1); // chroma columns: from neutral
    expect(m.paperWhite[0]).toBeGreaterThan(m.paperWhite[2]); // pixels: from colour (R >> B)
  });
});
