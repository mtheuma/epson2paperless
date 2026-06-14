import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { renderOverlay } from "./overlay.js";

describe("renderOverlay", () => {
  it("draws sample boxes + crosshair marks over a base JPEG and returns a PNG", async () => {
    const base = await sharp({
      create: { width: 200, height: 280, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .jpeg()
      .toBuffer();
    const png = await renderOverlay(base, {
      crosshairs: [
        { x: 10, y: 10 },
        { x: 190, y: 10 },
        { x: 10, y: 270 },
        { x: 190, y: 270 },
      ],
      boxes: [{ x: 50, y: 50, w: 40, h: 30, label: "FF0000" }],
    });
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(280);
  });
});
