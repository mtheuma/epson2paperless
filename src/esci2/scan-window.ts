// src/esci2/scan-window.ts
import { isDeepStrictEqual } from "node:util";
import { parseArea, type InfoTokens } from "./capabilities.js";
import { baseDpiFor, scaleAcqExtents, type Extents, type ParaProfile } from "./para-composer.js";
import type { Dialect } from "./dialects/registry.js";

/**
 * Shadow derivation for the scan window (report-only). The printer's INFO
 * reply gives each source's scan area, in 1/100 inch, and its alignment. A
 * registry entry's window is a paper size placed in that area, so its width
 * and height can't be derived. What can be checked is that it fits and that
 * its x0 follows the alignment. The generic window is what a printer with no
 * entry would get (ticket 10).
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

export type WindowProblem =
  | { source: WindowSource; problem: "outside-scan-area"; window: Extents; maxArea: Extents }
  | { source: WindowSource; problem: "x0-misaligned"; window: Extents; expectedX0: number };

function entryWindows(entry: Dialect): [WindowSource, Extents][] {
  const out: [WindowSource, Extents][] = [];
  if (entry.fbExtents !== null) out.push(["flatbed", entry.fbExtents]);
  if (entry.adfExtents !== null) out.push(["adf", entry.adfExtents]);
  return out;
}

/**
 * Where an entry's windows, at its reference DPI, leave the printer's scan
 * area (its long-paper maximum, for crop mode) or start where the alignment
 * says they shouldn't. A window for a source the printer advertises no area
 * for is a sources disagreement, reported by compareWithEntry, so it is
 * skipped here.
 */
export function windowProblems(info: InfoTokens, entry: Dialect): WindowProblem[] {
  const dpi = baseDpiFor(entry.paraProfile);
  const out: WindowProblem[] = [];
  for (const [source, window] of entryWindows(entry)) {
    const geometry = sourceGeometry(info, source);
    if (geometry === null) continue;
    const bound = entry.paraProfile === "adf-crp" ? geometry.maxArea : geometry.area;
    const maxW = toPixels(bound.width, dpi);
    const maxH = toPixels(bound.height, dpi);
    if (
      window.x0 < 0 ||
      window.y0 < 0 ||
      window.x0 + window.w > maxW ||
      window.y0 + window.h > maxH
    ) {
      out.push({
        source,
        problem: "outside-scan-area",
        window,
        maxArea: { x0: 0, y0: 0, w: maxW, h: maxH },
      });
    }
    const expectedX0 = alignedX0(geometry.align, toPixels(geometry.area.width, dpi), window.w);
    if (expectedX0 !== null && expectedX0 !== window.x0) {
      out.push({ source, problem: "x0-misaligned", window, expectedX0 });
    }
  }
  return out;
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

export interface GenericWindowDifference {
  source: WindowSource;
  entry: Extents;
  generic: Extents;
}

/**
 * Where the generic window, at the entry's reference DPI, differs from the
 * entry's own. Not a disagreement: the entry's window is a captured paper
 * size (XP-7100 Letter, ET-2750, FF-680W's long page). Kept on record for a
 * future paper-size decision.
 */
export function genericWindowDifferences(
  info: InfoTokens,
  entry: Dialect,
): GenericWindowDifference[] {
  const profile = entry.paraProfile;
  const out: GenericWindowDifference[] = [];
  for (const [source, window] of entryWindows(entry)) {
    const generic = genericWindow(info, source, profile, baseDpiFor(profile));
    if (generic !== null && !isDeepStrictEqual(generic, window)) {
      out.push({ source, entry: window, generic });
    }
  }
  return out;
}
