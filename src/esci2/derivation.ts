// src/esci2/derivation.ts
import { isDeepStrictEqual } from "node:util";
import type { CapaTokens, InfoTokens } from "./capabilities.js";
import type { RegistryEntry } from "./dialects/registry.js";

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
};

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
      out.push({ field, derived: derived[field], entry: fromEntry });
    }
  };
  FIELD_NAMES.forEach(check);
  return out;
}
