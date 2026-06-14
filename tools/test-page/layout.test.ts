import { describe, it, expect } from "vitest";
import { LAYOUT, swatchRect, SWATCHES, greySwatchIndices, crosshairPoints } from "./layout.js";

describe("test-page layout", () => {
  it("mirrors the generator's page + margin constants", () => {
    expect(LAYOUT.pageWidth).toBeCloseTo(595.28, 2);
    expect(LAYOUT.pageHeight).toBeCloseTo(841.89, 2);
    expect(LAYOUT.margin).toBe(40);
  });

  it("exposes 12 swatches with the declared RGB labels", () => {
    expect(SWATCHES).toHaveLength(12);
    expect(SWATCHES[0]).toEqual({ r: 255, g: 0, b: 0, label: "FF0000" });
    expect(SWATCHES[6]).toEqual({ r: 192, g: 192, b: 192, label: "C0C0C0" });
  });

  it("identifies the three grey swatches", () => {
    expect(greySwatchIndices).toEqual([6, 7, 8]);
  });

  it("computes swatch rects from the grid math (pdf bottom-left, points)", () => {
    const r0 = swatchRect(0);
    const colSpacing = 150;
    const swatchW = 120;
    const gridLeft = (595.28 - (3 * swatchW + 2 * (colSpacing - swatchW))) / 2;
    const gridTop = 841.89 - 200;
    expect(r0).toEqual({ x: gridLeft, y: gridTop, w: 120, h: 70 });
    expect(swatchRect(3).y).toBeCloseTo(gridTop - 105, 5);
  });

  it("places 4 crosshairs at the margins (pdf bottom-left)", () => {
    expect(crosshairPoints).toEqual([
      { x: 40, y: 841.89 - 40 }, // TL
      { x: 595.28 - 40, y: 841.89 - 40 }, // TR
      { x: 40, y: 40 }, // BL
      { x: 595.28 - 40, y: 40 }, // BR
    ]);
  });
});
