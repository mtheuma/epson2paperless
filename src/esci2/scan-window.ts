// src/esci2/scan-window.ts
import { parseArea, type InfoTokens } from "./capabilities.js";
import { baseDpiFor, scaleAcqExtents, type Extents, type ParaProfile } from "./para-composer.js";
import type { DialectWindow } from "./dialects/registry.js";

/**
 * Scan windows from the printer's INFO reply, which gives each source's
 * scan area, in 1/100 inch, and its alignment. A registry entry's own window
 * is a paper size placed in that area, so its width and height can't be
 * derived; what can be checked is that it fits (fitsScanArea, on a CAPA
 * fingerprint mismatch). The generic window is what a printer with no entry,
 * or an entry that inherits it, gets.
 */

export type WindowSource = "flatbed" | "adf";

/** Width and height in 1/100 inch. */
export interface ScanArea {
  width: number;
  height: number;
}

export interface SourceGeometry {
  /** The source's scan area: #FB AREA / #ADFAREA. */
  area: ScanArea;
  /**
   * The longest document the source takes. For the ADF, #ADFAMAX when it is
   * longer (long paper: the FF-680W takes 240 in); otherwise the area. Only
   * crop mode (adf-crp), which stops at the end of the paper, scans past
   * the area into it.
   */
  maxArea: ScanArea;
  /** "LEFT", "RIGT" or "CNTR"; null when INFO doesn't say. */
  align: string | null;
}

export function sourceGeometry(info: InfoTokens, source: WindowSource): SourceGeometry | null {
  const area = parseArea(source === "flatbed" ? info.fbArea : info.adfArea);
  if (area === null) return null;
  const max = source === "adf" ? parseArea(info.adfAreaMax) : null;
  const maxArea = {
    width: Math.max(area.width, max?.width ?? 0),
    height: Math.max(area.height, max?.height ?? 0),
  };
  return { area, maxArea, align: source === "flatbed" ? info.fbAlign : info.adfAlign };
}

/** A length in 1/100 inch as whole pixels at `dpi`, floored so it never overshoots. */
export const toPixels = (hundredths: number, dpi: number): number =>
  Math.floor((hundredths * dpi) / 100);

/**
 * Where a window of `windowWidth` pixels starts in an area `areaWidth`
 * pixels wide. RIGT: flush with the far edge. LEFT: at 0. CNTR: centred
 * (only seen at full width, where it is also 0). Null for an alignment the
 * printer didn't give or that we don't know.
 */
export function alignedX0(
  align: string | null,
  areaWidth: number,
  windowWidth: number,
): number | null {
  if (align === "RIGT") return areaWidth - windowWidth;
  if (align === "LEFT") return 0;
  if (align === "CNTR") return Math.floor((areaWidth - windowWidth) / 2);
  return null;
}

/**
 * Whether `window`, at the profile's reference DPI, lies inside the scan
 * area INFO advertises for `source` (its long-paper maximum, for crop mode,
 * which stops at the end of the paper). False when INFO advertises no area
 * for the source: there is nothing for the window to fit in.
 */
export function fitsScanArea(
  info: InfoTokens,
  source: WindowSource,
  window: Extents,
  profile: ParaProfile,
): boolean {
  const geometry = sourceGeometry(info, source);
  if (geometry === null) return false;
  const dpi = baseDpiFor(profile);
  const bound = profile === "adf-crp" ? geometry.maxArea : geometry.area;
  return (
    window.x0 >= 0 &&
    window.y0 >= 0 &&
    window.x0 + window.w <= toPixels(bound.width, dpi) &&
    window.y0 + window.h <= toPixels(bound.height, dpi)
  );
}

/** A4 at 300 DPI, the generic window's paper size on a standard printer. */
const GENERIC_A4_AT_300 = { w: 2481, h: 3506 };

/**
 * The window a printer with no entry, or whose entry inherits it
 * ("generic"), scans at `dpi`; null when INFO advertises no area for
 * `source`, when the profile has no such source (adf-crp has no flatbed), or
 * when clipping leaves nothing to scan.
 *
 * - standard: A4 at 300 DPI, x0 from the alignment rule.
 * - adf-crp: the full ADF scan area at 200 DPI (crop mode stops at the end
 *   of the paper).
 *
 * The reference window is scaled to `dpi` the way composePara scales a
 * registry window (scaleAcqExtents), then clipped to the scan area at `dpi`.
 * Clipping last is what guarantees no overrun: adf-crp's rounded scaling of
 * a full-area window lands one pixel past the edge at 75 DPI.
 */
export function genericWindow(
  info: InfoTokens,
  source: WindowSource,
  profile: ParaProfile,
  dpi: number,
): Extents | null {
  const geometry = sourceGeometry(info, source);
  return geometry === null ? null : genericWindowIn(geometry, source, profile, dpi);
}

/** genericWindow for a source whose geometry is already read from INFO. */
export function genericWindowIn(
  geometry: SourceGeometry,
  source: WindowSource,
  profile: ParaProfile,
  dpi: number,
): Extents | null {
  if (profile === "adf-crp" && source === "flatbed") return null;
  const baseDpi = baseDpiFor(profile);
  const baseAreaW = toPixels(geometry.area.width, baseDpi);
  let reference: Extents;
  if (profile === "adf-crp") {
    reference = { x0: 0, y0: 0, w: baseAreaW, h: toPixels(geometry.area.height, baseDpi) };
  } else {
    const { w, h } = GENERIC_A4_AT_300;
    // An area narrower than A4 makes a right-aligned x0 negative. Clamping it
    // to 0 and clipping below gives the same window as placing A4 flush
    // right and then clipping: the whole area, which is all the printer can
    // scan of a sheet wider than it.
    const x0 = Math.max(0, alignedX0(geometry.align, baseAreaW, w) ?? 0);
    reference = { x0, y0: 0, w, h };
  }
  const scaled = scaleAcqExtents(profile, reference, dpi);
  const areaW = toPixels(geometry.area.width, dpi);
  const areaH = toPixels(geometry.area.height, dpi);
  const x0 = Math.min(scaled.x0, areaW);
  const y0 = Math.min(scaled.y0, areaH);
  const w = Math.min(scaled.x0 + scaled.w, areaW) - x0;
  const h = Math.min(scaled.y0 + scaled.h, areaH) - y0;
  return w > 0 && h > 0 ? { x0, y0, w, h } : null;
}

/**
 * The generic window for `source` at the profile's reference DPI, carrying
 * the geometry makeParaSpec computes it from at the wire DPI. Null when INFO
 * advertises no usable scan area for the source.
 */
export function inheritedWindow(
  info: InfoTokens,
  source: WindowSource,
  profile: ParaProfile,
): DialectWindow | null {
  const geometry = sourceGeometry(info, source);
  if (geometry === null) return null;
  const window = genericWindowIn(geometry, source, profile, baseDpiFor(profile));
  return window === null ? null : { ...window, generic: geometry };
}
