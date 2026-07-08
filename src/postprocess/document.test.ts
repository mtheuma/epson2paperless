import { describe, it, expect } from "vitest";
import { correctDocumentPixels } from "./document.js";

// Build a 3-channel raw image: `rows` of per-pixel [r,g,b].
function raw(rows: number[][][]): { buf: Buffer; w: number; h: number } {
  const h = rows.length, w = rows[0].length;
  const buf = Buffer.alloc(w * h * 3);
  let i = 0;
  for (const row of rows) for (const [r, g, b] of row) { buf[i++] = r; buf[i++] = g; buf[i++] = b; }
  return { buf, w, h };
}

describe("correctDocumentPixels", () => {
  it("flattens the paper band (incl. column dips) to 255 and leaves below-knee content exact", () => {
    // Wide paper band ~220 with a dip column at 185; one dark content pixel at 128.
    const paperRow = Array.from({ length: 64 }, (_, x) =>
      x === 10 ? [185, 185, 210] : [222, 220, 244] as number[],
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
