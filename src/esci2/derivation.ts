// src/esci2/derivation.ts
import type { CapaTokens, InfoTokens } from "./capabilities.js";
import type { CapabilityFields, SourceDetection } from "./dialects/model-overrides.js";
import type { ParaProfile } from "./para-composer.js";

/**
 * Capability derivation: dialect fields computed from the printer's own INFO
 * and CAPA replies. Every session takes them from here (capabilityFields),
 * and no model override carries them. Each field is one rule in RULES.
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
 * What the init poll's first status reply means for the scan, as Epson's own
 * driver judges it: an error on the unit being scanned stops the scan
 * (`blocking`), and an error on any other unit is only `warnings`. A unit is
 * an error's location (ADF, FB, TPU, or one no source maps to), so it is
 * never the unit being scanned unless it is ADF or FB. There is no
 * always-fatal code: Epson has none.
 */
export type StatusJudgement =
  | { source: "flatbed" | "adf"; warnings: string[] }
  | { blocking: string[] };

const ADF_PAPER_EMPTY = "ADF PE";

/** An error's unit: its location, e.g. "ADF" from "ADF PJ". */
const unitOf = (error: string) => error.split(" ")[0];

/** The location a source's errors carry. */
const UNIT = { flatbed: "FB", adf: "ADF" } as const;

/**
 * Judges a status reply's errors (parseStatErrors) for a session whose source
 * is `source`, or "detect" on a printer with both sources. There the ADF is
 * empty only when it reports paper empty, which means the flatbed. Epson's
 * own source detection reads any other ADF code as a document loaded, so
 * the ADF is the source (and that error stops it), as it is with no ADF
 * error.
 */
export function judgeStatusErrors(
  errors: string[],
  source: "detect" | "flatbed" | "adf",
): StatusJudgement {
  const scanned =
    source === "detect" ? (errors.includes(ADF_PAPER_EMPTY) ? "flatbed" : "adf") : source;
  // ADF paper empty is never reported: it is a state, not a fault. On a
  // printer with both sources it is what says flatbed, and a flatbed scan
  // never needs the feeder. On an ADF-only one it is exempt only because
  // this is the first status reply, while Epson's driver judges the last one
  // before PARA: the DS-575W duplex capture's first status says paper empty,
  // yet the scan goes ahead.
  const reported = errors.filter((e) => e !== ADF_PAPER_EMPTY);
  const blocking = reported.filter((e) => unitOf(e) === UNIT[scanned]);
  if (blocking.length > 0) return { blocking };
  return { source: scanned, warnings: reported.filter((e) => unitOf(e) !== UNIT[scanned]) };
}
