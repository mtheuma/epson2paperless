import type { CapaTokens } from "./capabilities.js";
import type { ParaSpec } from "./para-composer.js";

export interface WireDpiSelection {
  wireDpi: number;
  /** Set when the scan must be host-downsampled to reach the target. */
  downsampleToDpi?: number;
  /** Set when the target exceeded the printer's maximum (info-logged by caller). */
  cappedFrom?: number;
}

/**
 * The DPIs a scan of `source` may request on the wire. Base set is
 * RSMLIST ∩ RSSLIST; the source's own RSMSLIST — when present — acts as a
 * CAP (max), never as the allowed-set itself: FF-680W and DS-575W advertise
 * #ADFRSMSLISTd300d600 yet Epson's driver scans them at 200 / 400
 * (capture-proven). What the cap preserves is the real per-source ceiling
 * (ET-4950: ADF 600 vs flatbed 1200). Sorted ascending; empty = nothing
 * advertised (caller falls back to the dialect's pinned default).
 */
export function advertisedDpiSet(capa: CapaTokens, source: ParaSpec["source"]): number[] {
  const sourceList = source === "flatbed" ? capa.fbRsmsList : capa.adfRsmsList;
  let base: number[];
  if (capa.rsmList !== null && capa.rssList !== null) {
    const rss = new Set(capa.rssList);
    base = capa.rsmList.filter((d) => rss.has(d));
  } else if (sourceList !== null) {
    return [...sourceList].sort((a, b) => a - b);
  } else {
    return [];
  }
  if (sourceList !== null && sourceList.length > 0) {
    const cap = Math.max(...sourceList);
    base = base.filter((d) => d <= cap);
  }
  return base.sort((a, b) => a - b);
}

/** Spec's selection rule: exact, else smallest-above + downsample, else max + capped. */
export function selectWireDpi(target: number, advertised: number[]): WireDpiSelection {
  if (advertised.includes(target)) return { wireDpi: target };
  const above = advertised.filter((d) => d > target);
  if (above.length > 0) return { wireDpi: Math.min(...above), downsampleToDpi: target };
  return { wireDpi: Math.max(...advertised), cappedFrom: target };
}
