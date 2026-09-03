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

  it("lifts a knee-band pixel strictly between its input value and 255 (not identity, not plateau)", () => {
    // 20x20 grid: 399 background pixels at 220 (so the 95th-pct paperWhite is
    // exactly 220 — clipPoint=170, kneeStart=150) and one pixel at 160, which
    // falls strictly inside the (150, 170) knee band.
    const rows = Array.from({ length: 20 }, () =>
      Array.from({ length: 20 }, () => [220, 220, 220] as number[]),
    );
    rows[0][0] = [160, 160, 160];
    const { buf } = raw(rows);

    const { data, applied } = correctDocumentPixels(buf, 3);
    expect(applied).toBe(true);
    // Expected smoothstep at t=0.5: round(160*0.5 + 255*0.5) = 208.
    expect([data[0], data[1], data[2]]).toEqual([208, 208, 208]);
    expect(data[0]).toBeGreaterThan(160);
    expect(data[0]).toBeLessThan(255);
  });

  it("guard trips via MIN_NEAR_WHITE_FRACTION (not MIN_PAPER_WHITE) when paper is bright but sparse", () => {
    // 10x10 grid: 90 mid-tone pixels at 50, 10 bright pixels at 200.
    // 95th-pct paperWhite = 200 (well above MIN_PAPER_WHITE=170), but only
    // 10/100 = 0.10 pixels are near-white (< MIN_NEAR_WHITE_FRACTION=0.15).
    const rows = Array.from({ length: 10 }, (_, y) =>
      Array.from({ length: 10 }, () => (y === 0 ? [200, 200, 200] : [50, 50, 50])),
    );
    const { buf } = raw(rows);

    const { data, applied } = correctDocumentPixels(buf, 3);
    expect(applied).toBe(false);
    expect(data.equals(buf)).toBe(true);
  });

  it("tone curve lifts below-knee content beyond the white-point clip (stage 2)", () => {
    // Paper at 220 (clipPoint=170, kneeStart=150); one content pixel at 128,
    // below the knee so stage 1 (clip) leaves it exactly unchanged.
    const rows = Array.from({ length: 20 }, () =>
      Array.from({ length: 20 }, () => [128, 128, 128] as number[]),
    );
    // fill most of the grid with paper so the guard passes and paperWhite=220
    for (let y = 0; y < 20; y++) for (let x = 1; x < 20; x++) rows[y][x] = [220, 220, 220];
    const { buf } = raw(rows);

    const plain = correctDocumentPixels(buf, 3); // stage 1 only
    const toned = correctDocumentPixels(buf, 3, "et4950-family"); // stage 1 + 2
    expect(plain.applied).toBe(true);
    expect(toned.applied).toBe(true);
    // stage 1 leaves the below-knee grey exactly unchanged...
    expect(plain.data[0]).toBe(128);
    // ...the tone curve lifts it toward the printed-page brightness.
    expect(toned.data[0]).toBeGreaterThan(plain.data[0]);
    // paper stays pure white in both — stage 1 clips to 255 and the curve's
    // top end is anchored so 255 maps to exactly 255 (issue #158; before the
    // anchor the R channel landed at 253 and colour pages never reached pure
    // white). Exact assertion: this path is raw pixels, no JPEG round-trip.
    expect(plain.data[3]).toBe(255);
    expect(toned.data[3]).toBe(255);
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

  it("decodes a grayscale (1-channel) JPEG without throwing and produces a valid same-size JPEG", async () => {
    const w = 48,
      h = 48;
    const grayBuf = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // Bright paper background with a darker content block, all in a single channel.
        const inBlock = x >= 20 && x < 32 && y >= 20 && y < 32;
        grayBuf[y * w + x] = inBlock ? 120 : 230;
      }
    const jpeg = await sharp(grayBuf, { raw: { width: w, height: h, channels: 1 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const out = await correctDocumentImage(jpeg, 90);
    const { info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(w);
    expect(info.height).toBe(h);
  });

  it("guard: when the low-paper guard trips, returns the original JPEG buffer unchanged (no re-encode)", async () => {
    const jpeg = await solidJpeg(64, 64, [60, 90, 120]);
    const out = await correctDocumentImage(jpeg, 90);
    expect(out).toBe(jpeg); // same buffer instance, not just equal bytes
    expect(out.equals(jpeg)).toBe(true);
  });

  it("guard: a page that trips the low-paper guard still downsamples (SCAN_RESOLUTION must not be silently ignored)", async () => {
    // Same full-bleed dark image as the guard test above — applied=false —
    // but with a downsample pending, the pure no-op skip must not fire.
    const jpeg = await solidJpeg(64, 64, [60, 90, 120]);
    const out = await correctDocumentImage(jpeg, 90, undefined, { fromDpi: 300, toDpi: 150 });
    expect(out).not.toBe(jpeg);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(32);
    expect(meta.density).toBe(150);
  });

  it("preserves the input's JFIF density on the re-encode", async () => {
    const w = 64,
      h = 64,
      buf = Buffer.alloc(w * h * 3);
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = 222;
      buf[i + 1] = 220;
      buf[i + 2] = 244;
    }
    const jpeg = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .withMetadata({ density: 300 })
      .jpeg({ quality: 95 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).density).toBe(300); // sanity: input carries the density we intend to assert on

    const out = await correctDocumentImage(jpeg, 90);
    const outMeta = await sharp(out).metadata();
    expect(outMeta.density).toBe(300);
  });

  it("folds a downsample into the single re-encode alongside the paper-white clip", async () => {
    const jpeg = await solidJpeg(64, 64, [222, 220, 244]);
    const out = await correctDocumentImage(jpeg, 90, undefined, { fromDpi: 300, toDpi: 150 });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(32);
    expect(info.height).toBe(32);
    // the paper-white clip still ran on the resized output
    const c = (info.width * 16 + 16) * 3;
    expect(data[c]).toBeGreaterThan(250);
    const meta = await sharp(out).metadata();
    expect(meta.density).toBe(150);
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
