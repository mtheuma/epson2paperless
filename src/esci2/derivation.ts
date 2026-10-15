// src/esci2/derivation.ts
import { isDeepStrictEqual } from "node:util";
import type { CapaTokens, InfoTokens } from "./capabilities.js";
import type { RegistryEntry } from "./dialects/registry.js";
import type { ParaProfile } from "./para-composer.js";

/**
 * Shadow derivation: dialect fields computed from the printer's own INFO and
 * CAPA replies, compared with what the registry entry says. Report-only for
 * now; nothing here changes what is sent. Once a field agrees with every
 * fixture model, a later change can take it from the derivation and drop it
 * from the registry.
 *
 * Each field is one row in FIELDS: its derivation rule and where the entry
 * keeps the value it is compared with. Adding a field is a new row plus its
 * slot in DerivedCapabilities.
 */
export interface DerivedCapabilities {
  /** PARA carries the optional #QIT segment. */
  qit: boolean;
  /** PARA carries the optional #CCT segment. */
  cct: boolean;
  /** The ADF can scan both sides. */
  adfDuplex: boolean;
  /** Which sources the printer has: each one advertises a scan area in INFO. */
  sources: { flatbed: boolean; adf: boolean };
  /**
   * How the session learns its source. A printer with both sources reads it
   * from the init poll's status reply; a single-source printer is fixed to
   * it. Null when INFO advertises no scan area at all.
   */
  sourceDetection: "init-poll-status" | "fixed-flatbed" | "fixed-adf" | null;
  /** PARA layout: "adf-crp" for an ADF-only printer whose ADF can crop. */
  paraProfile: ParaProfile;
  /** Duplex back pages arrive turned 180° (a two-pass ADF re-feeds the sheet). */
  duplexBackRotated: boolean;
}

/** One differing field, typed by the field it names. */
export type Disagreement = {
  [K in keyof DerivedCapabilities]: {
    field: K;
    derived: DerivedCapabilities[K];
    entry: DerivedCapabilities[K];
  };
}[keyof DerivedCapabilities];

interface FieldRule<K extends keyof DerivedCapabilities> {
  derive: (info: InfoTokens, capa: CapaTokens) => DerivedCapabilities[K];
  fromEntry: (entry: RegistryEntry) => DerivedCapabilities[K];
}

/** A list segment with no items advertises nothing, as in the diagnostic block. */
const advertises = (list: string | null): boolean => list !== null && list.length > 0;

const FIELDS: { [K in keyof DerivedCapabilities]: FieldRule<K> } = {
  qit: {
    derive: (_info, capa) => advertises(capa.qitList),
    fromEntry: (e) => e.optionalSegments.qit,
  },
  cct: {
    derive: (_info, capa) => advertises(capa.cctList),
    fromEntry: (e) => e.optionalSegments.cct,
  },
  adfDuplex: {
    derive: (_info, capa) => capa.adfDuplex,
    fromEntry: (e) => e.adfDuplex,
  },
  sources: {
    derive: (info) => sourcesOf(info),
    fromEntry: (e) => ({ flatbed: e.fbExtents !== null, adf: e.adfExtents !== null }),
  },
  sourceDetection: {
    derive: (info) => {
      const { flatbed, adf } = sourcesOf(info);
      if (flatbed && adf) return "init-poll-status";
      if (flatbed) return "fixed-flatbed";
      return adf ? "fixed-adf" : null;
    },
    // The entry's "stat-length" reads the same status reply, by its length.
    fromEntry: (e) =>
      e.sourceDetection === "stat-length" ? "init-poll-status" : e.sourceDetection,
  },
  paraProfile: {
    // "No flatbed" is redundant on every printer seen so far (only ADF-only
    // printers list #ADFCRP), but it is the documented rule.
    derive: (info, capa) => (capa.adfCrop && !sourcesOf(info).flatbed ? "adf-crp" : "standard"),
    fromEntry: (e) => e.paraProfile ?? "standard",
  },
  duplexBackRotated: {
    // Single-pass ("1SCN") or no duplex: back pages arrive upright.
    derive: (info) => info.adfDuplexType === "2SCN",
    fromEntry: (e) => e.duplexBackRotated,
  },
};

/** A scan-area segment with no value advertises no source, as with lists. */
function sourcesOf(info: InfoTokens): DerivedCapabilities["sources"] {
  return { flatbed: advertises(info.fbArea), adf: advertises(info.adfArea) };
}

const FIELD_NAMES = Object.keys(FIELDS) as (keyof DerivedCapabilities)[];

/** Takes the parsed INFO and CAPA replies, so the session's own parse is reused. */
export function deriveCapabilities(info: InfoTokens, capa: CapaTokens): DerivedCapabilities {
  // FIELDS' mapped type guarantees a rule for every key, so the result is complete.
  return Object.fromEntries(
    FIELD_NAMES.map((field) => [field, FIELDS[field].derive(info, capa)]),
  ) as unknown as DerivedCapabilities;
}

/** Per-field disagreements between a derivation and a registry entry, in FIELDS order. */
export function compareWithEntry(
  derived: DerivedCapabilities,
  entry: RegistryEntry,
): Disagreement[] {
  const out: Disagreement[] = [];
  const check = <K extends keyof DerivedCapabilities>(field: K) => {
    const fromEntry = FIELDS[field].fromEntry(entry);
    if (!isDeepStrictEqual(derived[field], fromEntry)) {
      out.push({ field, derived: derived[field], entry: fromEntry } as Disagreement);
    }
  };
  FIELD_NAMES.forEach(check);
  return out;
}

/**
 * Today's source rule for `stat-length` entries, from the first init-poll
 * STAT reply's declared length. ET-4950 fixtures: length 0 → ADF (printer
 * queued no status); length 12 → flatbed (queued `#ERRADF PE  `). Other
 * lengths default to ADF.
 */
export function sourceFromStatLength(length: number): "adf" | "flatbed" {
  return length === 12 ? "flatbed" : "adf";
}

/**
 * The source a printer with both sources is on, read from the content of the
 * init poll's first status reply: "ADF paper empty" means the flatbed, no
 * error means the ADF. Any other error is one a content-based decision would
 * end the session on, so it is returned for the caller to report.
 */
export type StatusSourceDecision = { source: "flatbed" | "adf" } | { unexpectedErrors: string[] };

export function sourceFromStatusErrors(errors: string[]): StatusSourceDecision {
  const unexpected = errors.filter((e) => e !== "ADF PE");
  if (unexpected.length > 0) return { unexpectedErrors: unexpected };
  return { source: errors.length > 0 ? "flatbed" : "adf" };
}
