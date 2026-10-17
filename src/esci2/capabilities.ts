import { splitHashSegments } from "./segments.js";
import { extractPid } from "../printer-ids.js";

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
  /**
   * PID NNNN extracted from `#PRDh010PID NNNN        `, as four upper-case
   * hex digits (canonicalised by `extractPid`). Null if missing, or when the
   * printer reports a product name instead (see `prdName`).
   */
  prdPid: string | null;
  /**
   * Product name from a name-form `#PRD`, e.g. "FF-680W" from
   * `#PRDh007FF-680W\0`. Some sheet-fed scanners report this in place of a
   * PID. Null if missing or PID-form.
   */
  prdName: string | null;
  /** Firmware version string from `#VERh008<value>`. Null if missing. */
  firmware: string | null;
  /** FB scan-area value from `#FB AREA<value>`. Null if missing. */
  fbArea: string | null;
  /** ADF scan-area value from `#ADFAREA<value>`. Null if missing (= flatbed-only printer). */
  adfArea: string | null;
  /**
   * ADF duplex type from `#ADFDPLX<value>`: "2SCN" (two-pass, the sheet is
   * re-fed) or "1SCN" (single-pass, both sides at once). Null without duplex.
   */
  adfDuplexType: string | null;
  /** Flatbed alignment from `#FB ALGN<value>`: "LEFT", "RIGT" or "CNTR". Null if missing. */
  fbAlign: string | null;
  /** ADF alignment from `#ADFALGN<value>`: "LEFT", "RIGT" or "CNTR". Null if missing. */
  adfAlign: string | null;
  /** Longest document the ADF takes, from `#ADFAMAX<value>` (long paper). Null if missing. */
  adfAreaMax: string | null;
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
  /** True if the CAPA body contains a `#ADFCRP` segment (the ADF can crop). */
  adfCrop: boolean;
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

/**
 * The value of a `#PRDhNNN<value>` segment, or null for any other segment.
 * NNN is the value's length in hex: 16 for the space-padded `PID NNNN` form,
 * the name's own length for the name form, which is followed by a NUL pad
 * byte. Trailing padding of either kind is trimmed.
 */
function parsePrdValue(seg: string): string | null {
  const m = seg.match(/^#PRDh([0-9a-fA-F]{3})/);
  if (!m) return null;
  const start = m[0].length;
  return seg.slice(start, start + parseInt(m[1], 16)).replace(/[\s\0]+$/, "");
}

export function parseInfoTokens(body: Buffer): InfoTokens {
  const segments = splitHashSegments(body);
  let prdPid: string | null = null;
  let prdName: string | null = null;
  let firmware: string | null = null;
  for (const seg of segments) {
    const prd = parsePrdValue(seg);
    if (prd !== null) {
      const pid = extractPid(prd);
      if (pid !== null) prdPid = pid.slice("PID ".length);
      else if (prd.length > 0) prdName = prd;
    }
    const verMatch = seg.match(/^#VERh[0-9a-f]{3}(.+)$/);
    if (verMatch) firmware = verMatch[1].trimEnd();
  }
  // Note the literal trailing space in "#FB AREA" / "#FB ALGN" — Epson includes
  // it in the prefix, so the parser must too. textAfterPrefix already handles
  // value-side whitespace.
  return {
    prdPid,
    prdName,
    firmware,
    fbArea: textAfterPrefix(segments, "#FB AREA"),
    adfArea: textAfterPrefix(segments, "#ADFAREA"),
    adfDuplexType: textAfterPrefix(segments, "#ADFDPLX"),
    fbAlign: textAfterPrefix(segments, "#FB ALGN"),
    adfAlign: textAfterPrefix(segments, "#ADFALGN"),
    adfAreaMax: textAfterPrefix(segments, "#ADFAMAX"),
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
    adfCrop: segments.some((s) => s.startsWith("#ADFCRP")),
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

/**
 * Error tokens from a STAT reply, e.g. "ADF PE" (ADF paper empty) from
 * `#ERRADF PE  `. Each `#ERR` segment is a 4-character location (the unit:
 * ADF, FB or TPU) followed by a 4-character code; both are returned trimmed
 * and space-joined, split at the field boundary so a four-letter location
 * stays apart from its code. Empty when the reply reports no error (a bare
 * `#ERR` included).
 */
export function parseStatErrors(body: Buffer): string[] {
  return splitHashSegments(body)
    .filter((seg) => seg.startsWith("#ERR"))
    .map((seg) => `${seg.slice(4, 8).trim()} ${seg.slice(8).trim()}`.trim())
    .filter((err) => err.length > 0); // a bare #ERR names no error
}

/**
 * An INFO area value ("d850i0001170": width, then height) in 1/100 inch, e.g.
 * 8.50 x 11.70 in. Null when absent or not two numbers.
 */
export function parseArea(text: string | null): { width: number; height: number } | null {
  const values = parseNumericList(text);
  return values?.length === 2 ? { width: values[0], height: values[1] } : null;
}
