import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";

/**
 * Thrown when a session lands on a printer no registry entry matches and
 * whose replies leave the generic dialect without something it needs (no
 * usable scan area, an unparseable CAPA reply). Carries enough context for
 * the user to file an issue that the maintainer can act on.
 *
 * Lives next to the diagnostic-block renderer it's thrown with.
 */
export class UnsupportedDialectError extends Error {
  constructor(
    public readonly capaFingerprint: string,
    public readonly diagnostic: string,
    /** Why the generic dialect can't run, e.g. "its INFO reply advertises no scan area". */
    public readonly reason: string,
  ) {
    super(
      `Unsupported printer (CAPA fingerprint ${capaFingerprint}): ${reason}. ` +
        `Please file an issue with the diagnostic block below:\n\n${diagnostic}`,
    );
    this.name = "UnsupportedDialectError";
  }
}

/**
 * Renders a copy-pasteable diagnostic block for an unrecognised printer: the
 * generic dialect's report, the UnsupportedDialectError, and the warning on a
 * fingerprint mismatch. Includes everything a maintainer needs to add a new
 * dialect or reproduce locally.
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
    `PRD:               ${info.prdName ?? `PID ${info.prdPid ?? "(absent)"}`}`,
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
