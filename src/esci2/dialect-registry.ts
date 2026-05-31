import { et4950FamilyDialect } from "./dialects/et-4950-family.js";
import { et2750Dialect } from "./dialects/et-2750.js";
import { et2950Dialect } from "./dialects/et-2950.js";
import { xp7100Dialect } from "./dialects/xp-7100.js";
import type { Dialect } from "./dialect.js";

/**
 * All registered ESC/I-2 dialects, keyed by CAPA#1 sha256 fingerprint.
 * Adding a new printer to this list (after capturing its CAPA reply) is
 * the only required code change to support a new model — provided its
 * wire bytes fit one of the existing dialects' shapes.
 */
export const DIALECTS: readonly Dialect[] = [
  et4950FamilyDialect,
  et2750Dialect,
  et2950Dialect,
  xp7100Dialect,
];

const BY_FINGERPRINT: ReadonlyMap<string, Dialect> = new Map(
  DIALECTS.map((d) => [d.capaFingerprint, d]),
);

export function lookupDialect(fingerprint: string): Dialect | null {
  return BY_FINGERPRINT.get(fingerprint) ?? null;
}

export { buildDiagnostic } from "./diagnostic.js";
