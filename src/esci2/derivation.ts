// src/esci2/derivation.ts
import type { CapaTokens, InfoTokens } from "./capabilities.js";
import type { CapabilityFields, SourceDetection } from "./dialects/registry.js";
import type { ParaProfile } from "./para-composer.js";

/**
 * Capability derivation: dialect fields computed from the printer's own INFO
 * and CAPA replies. Every session takes them from here (capabilityFields),
 * and no registry entry carries them. Each field is one rule in RULES.
 *
 * An entry's null windows still say which sources the model lacks; a test
 * holds them to `sources` on every fixture and diagnostic.
 */
export interface DerivedCapabilities {
  /** PARA carries the optional #QIT segment. */
  qit: boolean;
  /** PARA carries the optional #CCT segment. */
  cct: boolean;
  /** The ADF can scan both sides. */
  adfDuplex: boolean;
  /**
   * Which sources the printer has: each one advertises a scan area in INFO.
   * Source detection follows from it; the generic dialect also takes its
   * windows from it.
   */
  sources: { flatbed: boolean; adf: boolean };
  /** How the session learns its source. */
  sourceDetection: SourceDetection;
  /** PARA layout: "adf-crp" for an ADF-only printer whose ADF can crop. */
  paraProfile: ParaProfile;
  /** Duplex back pages arrive turned 180°: a two-pass ADF turns the sheet over. */
  duplexBackRotated: boolean;
}

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
  // Single-pass ("1SCN"), no duplex type, or no duplex ADF: back pages
  // arrive the same way up as the front.
  duplexBackRotated: (info, capa) => RULES.adfDuplex(info, capa) && info.adfDuplexType === "2SCN",
};

/** A scan-area segment with no value advertises no source. */
function sourcesOf(info: InfoTokens): DerivedCapabilities["sources"] {
  const advertises = (area: string | null) => area !== null && area.length > 0;
  return { flatbed: advertises(info.fbArea), adf: advertises(info.adfArea) };
}

const FIELD_NAMES = Object.keys(RULES) as (keyof DerivedCapabilities)[];

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
    duplexBackRotated: derived.duplexBackRotated,
  };
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
