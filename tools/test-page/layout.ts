// Single source of truth for the compatibility test-page geometry.
// Coordinates are PDF POINT space with pdf-lib's BOTTOM-LEFT origin (y up),
// identical to generate.ts. The oracle maps these into raster (top-left,
// y down) space via the crosshair-fit transform — see src/test-oracle.

export interface Swatch {
  r: number;
  g: number;
  b: number;
  label: string;
}

export interface PointRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const LAYOUT = {
  pageWidth: 595.28,
  pageHeight: 841.89,
  margin: 40,
  swatchW: 120,
  swatchH: 70,
  colSpacing: 150,
  rowSpacing: 105,
} as const;

export const SWATCHES: Swatch[] = [
  { r: 255, g: 0, b: 0, label: "FF0000" },
  { r: 0, g: 255, b: 0, label: "00FF00" },
  { r: 0, g: 0, b: 255, label: "0000FF" },
  { r: 0, g: 255, b: 255, label: "00FFFF" },
  { r: 255, g: 0, b: 255, label: "FF00FF" },
  { r: 255, g: 255, b: 0, label: "FFFF00" },
  { r: 192, g: 192, b: 192, label: "C0C0C0" },
  { r: 128, g: 128, b: 128, label: "808080" },
  { r: 64, g: 64, b: 64, label: "404040" },
  { r: 255, g: 128, b: 0, label: "FF8000" },
  { r: 128, g: 0, b: 255, label: "8000FF" },
  { r: 0, g: 160, b: 160, label: "00A0A0" },
];

export const greySwatchIndices = [6, 7, 8];

const gridLeft =
  (LAYOUT.pageWidth - (3 * LAYOUT.swatchW + 2 * (LAYOUT.colSpacing - LAYOUT.swatchW))) / 2;
const gridTop = LAYOUT.pageHeight - 200;

/** Swatch i's filled rectangle in PDF point space (bottom-left origin). */
export function swatchRect(i: number): PointRect {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return {
    x: gridLeft + col * LAYOUT.colSpacing,
    y: gridTop - row * LAYOUT.rowSpacing,
    w: LAYOUT.swatchW,
    h: LAYOUT.swatchH,
  };
}

/** The 4 corner registration marks, order [TL, TR, BL, BR] in PDF point space. */
export const crosshairPoints = [
  { x: LAYOUT.margin, y: LAYOUT.pageHeight - LAYOUT.margin },
  { x: LAYOUT.pageWidth - LAYOUT.margin, y: LAYOUT.pageHeight - LAYOUT.margin },
  { x: LAYOUT.margin, y: LAYOUT.margin },
  { x: LAYOUT.pageWidth - LAYOUT.margin, y: LAYOUT.margin },
];

/** Bottom horizontal-rule band (stripe/smear target), front + back identical. */
export const ruleLineBand: PointRect = {
  x: LAYOUT.margin + 20,
  y: LAYOUT.margin + 80,
  w: LAYOUT.pageWidth - 2 * (LAYOUT.margin + 20),
  h: 5 * 8,
};

/** Asymmetric corner marker region (F front / B back), near the TL crosshair. */
export const markerRegion: PointRect = {
  x: LAYOUT.margin,
  y: LAYOUT.pageHeight - LAYOUT.margin - 32,
  w: 28,
  h: 28,
};
