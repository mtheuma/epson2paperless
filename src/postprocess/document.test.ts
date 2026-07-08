import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { correctDocumentPixels, correctDocumentImage } from "./document.js";
import { setJpegOrientation, readJpegOrientation } from "../exif.js";

// Build a 3-channel raw image: `rows` of per-pixel [r,g,b].
function raw(rows: number[][][]): { buf: Buffer; w: number; h: number } {
  const h = rows.length,
    w = rows[0].length;
  const buf = Buffer.alloc(w * h * 3);
  let i = 0;
  for (const row of rows)
    for (const [r, g, b] of row) {
      buf[i++] = r;
      buf[i++] = g;
      buf[i++] = b;
    }
  return { buf, w, h };
}

describe("correctDocumentPixels", () => {
  it("flattens the paper band (incl. column dips) to 255 and leaves below-knee content exact", () => {
    // Wide paper band ~220 with a dip column at 185; one dark content pixel at 128.
    const paperRow = Array.from({ length: 64 }, (_, x) =>
      x === 10 ? [185, 185, 210] : ([222, 220, 244] as number[]),
    );
    // Enough paper rows to satisfy the near-white fraction; one content pixel.
    const rows = Array.from({ length: 20 }, () => paperRow.map((p) => [...p]));
    rows[0][0] = [128, 120, 140]; // below-knee content
    const { buf } = raw(rows);

    const { data, applied } = correctDocumentPixels(buf, 3);
    expect(applied).toBe(true);
    // content pixel unchanged, exactly
    expect([data[0], data[1], data[2]]).toEqual([128, 120, 140]);
    // a paper pixel and the dip column both went to pure white
    const at = (x: number, y: number, c: number) => data[(y * 64 + x) * 3 + c];
    expect([at(20, 5, 0), at(20, 5, 1), at(20, 5, 2)]).toEqual([255, 255, 255]);
    expect([at(10, 5, 0), at(10, 5, 1), at(10, 5, 2)]).toEqual([255, 255, 255]);
  });

  it("guard: full-bleed dark image is returned unchanged (applied=false)", () => {
    const rows = Array.from({ length: 16 }, () =>
      Array.from({ length: 16 }, () => [60, 90, 120] as number[]),
    );
    const { buf } = raw(rows);
    const { data, applied } = correctDocumentPixels(buf, 3);
    expect(applied).toBe(false);
    expect(data.equals(buf)).toBe(true);
  });
});

async function solidJpeg(w: number, h: number, rgb: [number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe("correctDocumentImage", () => {
  it("drives a cast paper background toward neutral white", async () => {
    const jpeg = await solidJpeg(64, 64, [222, 220, 244]);
    const out = await correctDocumentImage(jpeg, 90);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // center pixel is neutral white within JPEG tolerance
    const c = (64 * 32 + 32) * 3;
    expect(data[c]).toBeGreaterThan(250);
    expect(Math.abs(data[c] - data[c + 2])).toBeLessThan(4);
  });

  it("preserves a below-knee grey block through the full JPEG round-trip (within tolerance)", async () => {
    // Mostly paper (so paperWhite is high and the guard passes) with a grey block.
    const w = 64,
      h = 64,
      buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const grey = x >= 40 && x < 56 && y >= 40 && y < 56;
        const v = grey ? [150, 150, 150] : [230, 228, 248];
        buf[i] = v[0];
        buf[i + 1] = v[1];
        buf[i + 2] = v[2];
      }
    const jpeg = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const out = await correctDocumentImage(jpeg, 90);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const g = (48 * w + 48) * 3; // inside the grey block
    // grey survives — not clipped to white, close to its input value
    expect(data[g]).toBeLessThan(200);
    expect(Math.abs(data[g] - 150)).toBeLessThan(8);
  });

  it("bakes EXIF Orientation=3 into pixels so duplex back pages are not un-rotated", async () => {
    // Top half red, bottom half blue; Orientation=3 means a viewer rotates 180.
    const w = 8,
      h = 8,
      buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const top = y < h / 2;
        buf[i] = top ? 220 : 20;
        buf[i + 1] = 20;
        buf[i + 2] = top ? 20 : 220;
      }
    const base = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const oriented = setJpegOrientation(base, 3);

    const out = await correctDocumentImage(oriented, 90);
    // orientation baked in → tag gone (or 1), pixels physically rotated
    expect(readJpegOrientation(out) ?? 1).toBe(1);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // after 180° rotation the top row is now the original bottom (blue-dominant)
    expect(data[2]).toBeGreaterThan(data[0]); // B > R at top-left
  });
});
