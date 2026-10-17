// src/esci2/derivation.ts
import { isDeepStrictEqual } from "node:util";
import type { CapaTokens, InfoTokens } from "./capabilities.js";
import type { CapabilityFields, RegistryEntry, SourceDetection } from "./dialects/registry.js";
import type { ParaProfile } from "./para-composer.js";

/**
 * Capability derivation: dialect fields computed from the printer's own INFO
 * and CAPA replies.
 *
 * Some of them are live: every session takes them from here
 * (capabilityFields), and no registry entry carries them. The rest are still
 * shadowed: compared with what the registry entry says and reported, without
 * changing what is sent. Once a shadowed field agrees with every fixture
 * model, a later change makes it live and drops it from the registry.
 *
 * Each field is one rule in RULES. A shadowed field also has a row in
 * SHADOWED saying where the entry keeps the value it is compared with.
 */
export interface DerivedCapabilities {
  /** PARA carries the optional #QIT segment (live). */
  qit: boolean;
  /** PARA carries the optional #CCT segment (live). */
  cct: boolean;
  /** The ADF can scan both sides (live). */
  adfDuplex: boolean;
  /** Which sources the printer has: each one advertises a scan area in INFO. */
  sources: { flatbed: boolean; adf: boolean };
  /** How the session learns its source (live). */
  sourceDetection: SourceDetection;
  /** PARA layout: "adf-crp" for an ADF-only printer whose ADF can crop (live). */
  paraProfile: ParaProfile;
  /** Duplex back pages arrive turned 180° (a two-pass ADF re-feeds the sheet). */
  duplexBackRotated: boolean;
}

/** The fields still compared with the registry entry rather than used directly. */
export type ShadowedField = "sources" | "duplexBackRotated";

/** One differing field, typed by the field it names. */
export type Disagreement = {
  [K in ShadowedField]: {
    field: K;
    derived: DerivedCapabilities[K];
    entry: DerivedCapabilities[K];
  };
}[ShadowedField];

/**
 * A CAPA list's items: four characters each ("UG10UG18" → UG10, UG18), trimmed
 * of their space padding ("PREFON  OFF" → PREF, ON, OFF).
 */
export const listItems = (list: string | null): string[] =>
  (list?.match(/.{1,4}/g) ?? []).map((item) => item.trim());

const RULES: {
  [K in keyof DerivedCapabilities]: (info: InfoTokens, capa: CapaTokens) => DerivedCapabilities[K];
} = {
  // The optional segments are sent only when their list carries the value the
  // composer sends (#QITOFF, #CCTCOL).
  qit: (_info, capa) => listItems(capa.qitList).includes("OFF"),
  cct: (_info, capa) => listItems(capa.cctList).includes("COL"),
  adfDuplex: (info, capa) => capa.adfDuplex && sourcesOf(info).adf,
  sources: (info) => sourcesOf(info),
  sourceDetection: (info) => {
    const { flatbed, adf } = sourcesOf(info);
    if (flatbed && adf) return "init-poll-status";
    if (flatbed) return "fixed-flatbed";
    return adf ? "fixed-adf" : null;
  },
  // "No flatbed" is redundant on every printer seen so far (only ADF-only
  // printers list #ADFCRP), but it is the documented rule.
  paraProfile: (info, capa) => (capa.adfCrop && !sourcesOf(info).flatbed ? "adf-crp" : "standard"),
  // Single-pass ("1SCN") or no duplex: back pages arrive upright.
  duplexBackRotated: (info) => info.adfDuplexType === "2SCN",
};

const SHADOWED: {
  [K in ShadowedField]: (entry: RegistryEntry) => DerivedCapabilities[K];
} = {
  sources: (e) => ({ flatbed: e.fbExtents !== null, adf: e.adfExtents !== null }),
  duplexBackRotated: (e) => e.duplexBackRotated,
};

/** A scan-area segment with no value advertises no source. */
function sourcesOf(info: InfoTokens): DerivedCapabilities["sources"] {
  const advertises = (area: string | null) => area !== null && area.length > 0;
  return { flatbed: advertises(info.fbArea), adf: advertises(info.adfArea) };
}

const FIELD_NAMES = Object.keys(RULES) as (keyof DerivedCapabilities)[];
const SHADOWED_FIELDS = Object.keys(SHADOWED) as ShadowedField[];

/** Takes the parsed INFO and CAPA replies, so the session's own parse is reused. */
export function deriveCapabilities(info: InfoTokens, capa: CapaTokens): DerivedCapabilities {
  // RULES' mapped type guarantees a rule for every key, so the result is complete.
  return Object.fromEntries(
    FIELD_NAMES.map((field) => [field, RULES[field](info, capa)]),
  ) as unknown as DerivedCapabilities;
}

/** The live fields, in the shape a session's dialect carries them. */
export function capabilityFields(derived: DerivedCapabilities): CapabilityFields {
  return {
    adfDuplex: derived.adfDuplex,
    optionalSegments: { qit: derived.qit, cct: derived.cct },
    paraProfile: derived.paraProfile,
    sourceDetection: derived.sourceDetection,
  };
}

/**
 * Whether a disagreement is one the entry itself already flags as
 * unconfirmed, so reporting it on every session would only repeat a known
 * open question. Today that is the FF-680W's back-page rotation
 * (duplexBackRotationUnverified), which the rotation cutover settles; duplex
 * scans on such an entry already warn and invite a hardware report.
 */
export function isExpectedDisagreement(d: Disagreement, entry: RegistryEntry): boolean {
  return d.field === "duplexBackRotated" && entry.duplexBackRotationUnverified === true;
}

/** Per-field disagreements between a derivation and a registry entry, in SHADOWED order. */
export function compareWithEntry(
  derived: DerivedCapabilities,
  entry: RegistryEntry,
): Disagreement[] {
  const out: Disagreement[] = [];
  const check = <K extends ShadowedField>(field: K) => {
    const fromEntry = SHADOWED[field](entry);
    if (!isDeepStrictEqual(derived[field], fromEntry)) {
      out.push({ field, derived: derived[field], entry: fromEntry } as Disagreement);
    }
  };
  SHADOWED_FIELDS.forEach(check);
  return out;
}

/**
 * The source a printer with both sources is on, read from the content of the
 * init poll's first status reply: "ADF paper empty" means the flatbed, no
 * error means the ADF. Any other error leaves the source undecided, so it is
 * returned for the caller to end the session with.
 */
export type StatusSourceDecision = { source: "flatbed" | "adf" } | { unexpectedErrors: string[] };

export function sourceFromStatusErrors(errors: string[]): StatusSourceDecision {
  const unexpected = errors.filter((e) => e !== "ADF PE");
  if (unexpected.length > 0) return { unexpectedErrors: unexpected };
  return { source: errors.length > 0 ? "flatbed" : "adf" };
}
