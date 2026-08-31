import { splitHashSegments } from "./segments.js";

/**
 * Token parsing for ESC/I-2 INFO and CAPA reply bodies.
 *
 * Both replies are sequences of `#`-prefixed compact strings. Some examples:
 *
 *   #ADFTYPEFEED#ADFDPLX2SCN#PRDh010PID 1147        #VERh008FB  2.00
 *   #GMMLISTUG10UG18#CMXLISTUNITUM08#QITLISTPREFON  OFF
 *
 * There's no consistent key/value delimiter inside a segment — the key
 * boundary depends on the token. We segment by `#` and interpret known
 * prefixes; everything else is passed through unparsed (and consumers
 * who care can do their own slicing).
 *
 * The fingerprint module deliberately does NOT use this typed parser — it
 * imports only the raw segment splitter from `./segments.js` so that new
 * tokens we don't yet recognise still contribute to the fingerprint
 * correctly.
 */

export interface InfoTokens {
  /** PID NNNN extracted from `#PRDh010PID NNNN        `. Null if missing. */
  prdPid: string | null;
  /** Firmware version string from `#VERh008<value>`. Null if missing. */
  firmware: string | null;
  /** FB scan-area value from `#FB AREA<value>`. Null if missing. */
  fbArea: string | null;
  /** ADF scan-area value from `#ADFAREA<value>`. Null if missing (= flatbed-only printer). */
  adfArea: string | null;
  /** Raw segments, in encounter order. */
  segments: string[];
}

export interface CapaTokens {
  /** Raw text after `#GMMLIST` prefix, e.g. "UG10UG18". Null if absent. */
  gmmList: string | null;
  /** Raw text after `#CMXLIST` prefix, e.g. "UNITUM08". Null if absent. */
  cmxList: string | null;
  /** Raw text after `#QITLIST` prefix, e.g. "PREFON  OFF". Null if absent. */
  qitList: string | null;
  /** Raw text after `#FMTLIST` prefix, e.g. "RAW JPG". Null if absent. */
  fmtList: string | null;
  /**
   * Raw text after `#CCTLIST` prefix, e.g. "COL MONOPREF". Null if absent.
   * Presence/absence drives whether the host driver emits `#CCTCOL ` in
   * PARA, which changes PARA length by 8 bytes; surface it in diagnostics
   * so a new printer's report tells us which PARA variant to send.
   */
  cctList: string | null;
  /** True if the CAPA body contains a `#ADFDPLX` segment. */
  adfDuplex: boolean;
  /** Supported main-scan resolutions (dpi) from `#RSMLIST`. Null if absent. */
  rsmList: number[] | null;
  /** Supported sub-scan resolutions (dpi) from `#RSSLIST`. Null if absent. */
  rssList: number[] | null;
  /** Supported ADF-specific resolutions (dpi) from `#ADFRSMSLIST`. Null if absent. */
  adfRsmsList: number[] | null;
  /** Supported flatbed-specific resolutions (dpi) from `#FB RSMSLIST`. Null if absent. */
  fbRsmsList: number[] | null;
  /** JPEG quality range from `#JPGRANG`. Null if absent. */
  jpgRange: { min: number; max: number } | null;
  /** Raw segments, in encounter order. Includes unrecognised prefixes. */
  segments: string[];
}

/**
 * Parses a concatenated Epson numeric list ("d050d075…i0001200") into numbers.
 * `d` values are 3-digit, `i` values 7-digit — both forms occur mixed in one
 * list on real hardware (ET-4950 #RSMLIST).
 */
function parseNumericList(text: string | null): number[] | null {
  if (text === null) return null;
  const out: number[] = [];
  for (const m of text.matchAll(/d(\d{3})|i(\d{7})/g)) {
    out.push(Number(m[1] ?? m[2]));
  }
  return out.length > 0 ? out : null;
}

/**
 * Returns the raw text immediately after `prefix` from the first matching
 * segment, trimmed of trailing whitespace. Returns null when no segment
 * starts with `prefix`.
 */
function textAfterPrefix(segments: string[], prefix: string): string | null {
  for (const seg of segments) {
    if (!seg.startsWith(prefix)) continue;
    return seg.slice(prefix.length).trimEnd();
  }
  return null;
}

export function parseInfoTokens(body: Buffer): InfoTokens {
  const segments = splitHashSegments(body);
  let prdPid: string | null = null;
  let firmware: string | null = null;
  for (const seg of segments) {
    const prdMatch = seg.match(/^#PRDh[0-9a-f]{3}PID\s+([0-9A-Fa-f]+)/);
    if (prdMatch) prdPid = prdMatch[1];
    const verMatch = seg.match(/^#VERh[0-9a-f]{3}(.+)$/);
    if (verMatch) firmware = verMatch[1].trimEnd();
  }
  // Note the literal trailing space in "#FB AREA" / "#FB ALGN" — Epson includes
  // it in the prefix, so the parser must too. textAfterPrefix already handles
  // value-side whitespace.
  return {
    prdPid,
    firmware,
    fbArea: textAfterPrefix(segments, "#FB AREA"),
    adfArea: textAfterPrefix(segments, "#ADFAREA"),
    segments,
  };
}

export function parseCapaTokens(body: Buffer): CapaTokens {
  const segments = splitHashSegments(body);
  return {
    gmmList: textAfterPrefix(segments, "#GMMLIST"),
    cmxList: textAfterPrefix(segments, "#CMXLIST"),
    qitList: textAfterPrefix(segments, "#QITLIST"),
    fmtList: textAfterPrefix(segments, "#FMTLIST"),
    cctList: textAfterPrefix(segments, "#CCTLIST"),
    adfDuplex: segments.some((s) => s.startsWith("#ADFDPLX")),
    rsmList: parseNumericList(textAfterPrefix(segments, "#RSMLIST")),
    rssList: parseNumericList(textAfterPrefix(segments, "#RSSLIST")),
    adfRsmsList: parseNumericList(textAfterPrefix(segments, "#ADFRSMSLIST")),
    fbRsmsList: parseNumericList(textAfterPrefix(segments, "#FB RSMSLIST")),
    jpgRange: (() => {
      const vals = parseNumericList(textAfterPrefix(segments, "#JPGRANG"));
      return vals && vals.length >= 2 ? { min: vals[0], max: vals[1] } : null;
    })(),
    segments,
  };
}
