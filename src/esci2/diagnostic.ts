import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";

/**
 * Thrown when a session lands on a printer whose CAPA fingerprint isn't
 * in the registry. Carries enough context for the user to file an issue
 * that the maintainer can act on.
 *
 * Relocated from dialect.ts to live next to the diagnostic-block renderer.
 * dialect.ts re-exports for backward compatibility.
 */
export class UnsupportedDialectError extends Error {
  constructor(
    public readonly capaFingerprint: string,
    public readonly diagnostic: string,
  ) {
    super(
      `Unsupported printer CAPA fingerprint ${capaFingerprint}. ` +
        `Please file an issue with the diagnostic block below:\n\n${diagnostic}`,
    );
    this.name = "UnsupportedDialectError";
  }
}

/**
 * Renders a copy-pasteable diagnostic block for the UnsupportedDialectError
 * raised when CAPA fingerprint doesn't resolve. Includes everything a
 * maintainer needs to add a new dialect or reproduce locally.
 *
 * Body relocated verbatim from dialect-registry.ts. Pinned tests in
 * diagnostic.test.ts (moved from dialect-registry.test.ts) assert the
 * exact rendering, including the `(absent)` treatment of bare LIST tokens.
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
  // Treat empty string as absent: a bare `#XXXLIST` (segment present, value
  // empty) parses to "" rather than null, but for at-a-glance reading the
  // diagnostic should still mark it as (absent). Matters most for CCT, where
  // present-vs-absent drives PARA-variant selection.
  const orAbsent = (s: string | null) => (s && s.length > 0 ? s : "(absent)");
  return [
    `CAPA fingerprint:  ${args.fingerprint}`,
    `PRD:               PID ${info.prdPid ?? "(absent)"}`,
    `Firmware:          ${info.firmware ?? "(absent)"}`,
    `Transport:         ${transportLabel}`,
    `Source caps:       flatbed: ${yn(hasFlatbed)}  ADF: ${yn(hasAdf)}  duplex: ${yn(hasDuplex)}`,
    `Scan area (FB):    ${info.fbArea ?? "(absent)"}`,
    `Scan area (ADF):   ${info.adfArea ?? "(absent)"}`,
    `GMM list:          ${orAbsent(capa.gmmList)}`,
    `CMX list:          ${orAbsent(capa.cmxList)}`,
    `QIT list:          ${orAbsent(capa.qitList)}`,
    `FMT list:          ${orAbsent(capa.fmtList)}`,
    `CCT list:          ${orAbsent(capa.cctList)}`,
    `INFO segments:     ${info.segments.length}`,
    `CAPA segments:     ${capa.segments.length}`,
  ].join("\n");
}
