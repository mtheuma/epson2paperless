/** Decoded image: tightly-packed pixels, row-major, top-left origin. */
export interface Raster {
  data: Buffer;
  width: number;
  height: number;
  channels: number; // 3 (RGB) for our JPEG decodes
}

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned rectangle. Units depend on context (points or pixels). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Independent per-axis scale+offset: px = scale*pt + offset. sy is negative
 *  (PDF y-up vs raster y-down). */
export interface Transform {
  sx: number;
  ox: number;
  sy: number;
  oy: number;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  measured: number;
  baseline?: number;
  tolerance?: number;
  detail?: string;
}

export interface OracleReport {
  pass: boolean;
  crosshairResidualPx: number;
  checks: CheckResult[];
}
