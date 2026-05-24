import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";
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

/**
 * Renders a copy-pasteable diagnostic block for the UnsupportedDialectError
 * raised when CAPA fingerprint doesn't resolve. Includes everything a
 * maintainer needs to add a new dialect or reproduce locally.
 */
export function buildDiagnostic(args: {
  capaBody: Buffer;
  infoBody: Buffer;
  transport: "tls" | "plain";
  fingerprint: string;
}): string {
  const info = parseInfoTokens(args.infoBody);
  const capa = parseCapaTokens(args.capaBody);
  const transportLabel = args.transport === "tls" ? "esci2-tls" : "esci2-plain";
  // Source caps derived from segment presence:
  //   flatbed: any #FB ALGNxx or #FB AREA segment seen in INFO
  //   ADF:     any #ADFxxxx segment seen in INFO (#ADFAREA, #ADFTYPE, etc.)
  //   duplex:  CAPA contains #ADFDPLX
  const hasFlatbed = info.segments.some((s) => s.startsWith("#FB "));
  const hasAdf = info.segments.some((s) => s.startsWith("#ADF"));
  const hasDuplex = capa.adfDuplex;
  const yn = (v: boolean) => (v ? "Y" : "N");
  return [
    `CAPA fingerprint:  ${args.fingerprint}`,
    `PRD:               PID ${info.prdPid ?? "(absent)"}`,
    `Firmware:          ${info.firmware ?? "(absent)"}`,
    `Transport:         ${transportLabel}`,
    `Source caps:       flatbed: ${yn(hasFlatbed)}  ADF: ${yn(hasAdf)}  duplex: ${yn(hasDuplex)}`,
    `Scan area (FB):    ${info.fbArea ?? "(absent)"}`,
    `Scan area (ADF):   ${info.adfArea ?? "(absent)"}`,
    `GMM list:          ${capa.gmmList ?? "(absent)"}`,
    `CMX list:          ${capa.cmxList ?? "(absent)"}`,
    `QIT list:          ${capa.qitList ?? "(absent)"}`,
    `FMT list:          ${capa.fmtList ?? "(absent)"}`,
    `CCT list:          ${capa.cctList ?? "(absent)"}`,
    `INFO segments:     ${info.segments.length}`,
    `CAPA segments:     ${capa.segments.length}`,
  ].join("\n");
}
