import { REGISTRY_ENTRIES, type Dialect, type RegistryEntry } from "./registry.js";
import {
  STANDARD_BASE_DPI,
  baseDpiFor,
  scaleEdges,
  type Extents,
  type ParaSpec,
} from "../para-composer.js";
import { buildDiagnostic, UnsupportedDialectError } from "../diagnostic.js";
import type { CapaTokens, InfoTokens } from "../capabilities.js";
import { buildGenericEntry, GenericDialectUnusableError, printerIdentity } from "./generic.js";
import { capabilityFields, deriveCapabilities, type DerivedCapabilities } from "../derivation.js";
import { createLogger } from "../../logger.js";

const log = createLogger("scanner-esci2");

/** Which key resolved a session's registry entry, or "generic" when none did. */
export type IdentityMatch = "pid" | "name" | "fingerprint" | "generic";

export interface ResolvedEntry {
  entry: Dialect;
  matchedBy: IdentityMatch;
  /** The derivation the dialect was built with, for the caller's shadow comparison. */
  derived: DerivedCapabilities;
}

/** What INIT1 knows when it resolves the dialect. */
export interface Init1Replies {
  /** INFO and CAPA, parsed once by the caller and shared with the shadow derivation. */
  info: InfoTokens;
  capa: CapaTokens;
  fingerprint: string;
  /** Raw bodies, rendered into the diagnostic block on a miss or mismatch. */
  infoBody: Buffer;
  capaBody: Buffer;
  transport: "tls" | "plain";
}

/**
 * Looks up the registry entry by model identity: the INFO product ID, then
 * the INFO product name, then the CAPA fingerprint, and completes it with the
 * capability fields derived from this printer's own replies. When none matches, the
 * printer gets the generic dialect, built from its own replies, with a
 * warning and the diagnostic block for the report. Throws
 * UnsupportedDialectError with the diagnostic block only when the generic
 * dialect can't be built either.
 *
 * A PID or name hit whose CAPA fingerprint isn't one of the entry's logs a
 * warning with the diagnostic block and proceeds with that entry: the model
 * is known, and its CAPA reply may have changed with a firmware update.
 *
 * Called from INIT1_CAPA in the graph state machine. INFO is read before
 * CAPA, so the identity is available on every trigger path, including the
 * host-triggered ones that carry no panel PID.
 */
export function lookupRegistryEntry(replies: Init1Replies): ResolvedEntry {
  const { info, capa, fingerprint } = replies;
  const derived = deriveCapabilities(info, capa);
  // prdPid is canonical upper-case hex, and entries store names upper-case
  // (both pinned by registry.test.ts), so only the reported name needs folding.
  const { prdPid } = info;
  const prdName = info.prdName?.toUpperCase() ?? null;
  const byPid = prdPid === null ? undefined : REGISTRY_ENTRIES.find((e) => e.pids.includes(prdPid));
  const byName =
    prdName === null ? undefined : REGISTRY_ENTRIES.find((e) => e.names.includes(prdName));
  const byFingerprint = REGISTRY_ENTRIES.find((e) => e.capaFingerprints.includes(fingerprint));

  const byIdentity = byPid ?? byName;
  if (byIdentity !== undefined) {
    const matchedBy = byPid !== undefined ? "pid" : "name";
    if (!byIdentity.capaFingerprints.includes(fingerprint)) {
      const reported = matchedBy === "pid" ? `PID ${prdPid}` : `product name ${info.prdName}`;
      log.warn(
        `Printer identified as ${byIdentity.displayName} by its ${reported}, but its CAPA ` +
          `fingerprint is not one recorded for that model` +
          (byFingerprint ? ` (it is the ${byFingerprint.displayName} one)` : "") +
          `. Continuing with that model's settings; if the scan fails or looks wrong, ` +
          `please file an issue with the diagnostic block below:\n\n${buildDiagnostic(replies)}`,
      );
    }
    return { entry: withCapabilities(byIdentity, derived), matchedBy, derived };
  }

  if (byFingerprint !== undefined) {
    return { entry: withCapabilities(byFingerprint, derived), matchedBy: "fingerprint", derived };
  }
  return { entry: resolveGenericEntry(replies, derived), matchedBy: "generic", derived };
}

/**
 * A registry entry completed with the capability fields derived from the
 * printer's own replies, the same ones the generic dialect is built with.
 *
 * The entry's windows are pinned at its windowDpi, and the composer reads
 * them at the derived profile's reference DPI. When the two differ (a
 * printer whose replies give it the other profile), the windows are
 * rescaled so they keep their physical size.
 */
export function withCapabilities(entry: RegistryEntry, derived: DerivedCapabilities): Dialect {
  const fields = capabilityFields(derived);
  const dpi = baseDpiFor(fields.paraProfile);
  const scale = dpi / (entry.windowDpi ?? STANDARD_BASE_DPI);
  if (scale === 1) return { ...entry, ...fields };
  const rescale = (e: Extents | null) => (e === null ? null : scaleEdges(e, scale));
  return {
    ...entry,
    fbExtents: rescale(entry.fbExtents),
    adfExtents: rescale(entry.adfExtents),
    windowDpi: dpi,
    ...fields,
  };
}

function resolveGenericEntry(replies: Init1Replies, derived: DerivedCapabilities): Dialect {
  const diagnostic = buildDiagnostic(replies);
  let entry: Dialect;
  try {
    entry = buildGenericEntry(replies.info, replies.capa, derived);
  } catch (err) {
    if (!(err instanceof GenericDialectUnusableError)) throw err;
    throw new UnsupportedDialectError(replies.fingerprint, diagnostic, err.message);
  }
  log.warn(
    `${printerIdentity(replies.info)} not recognised — generic ESC/I-2 dialect, experimental, ` +
      "please report how the scan turns out, with the diagnostic block below.",
  );
  log.info(`Diagnostic block for the report:\n\n${diagnostic}`);
  return entry;
}

/**
 * Pins ctx.source for entries with fixed source detection. Replaces the
 * legacy applyDialectSourceOverride helper.
 *
 * Necessary because scanner shells pre-set a transport-level default before
 * the registry resolves. Fixed-source entries override that default once the
 * CAPA fingerprint is known.
 */
export function applyEntrySourceOverride(
  ctx: { source: "adf" | "flatbed" },
  entry: RegistryEntry,
): void {
  if (entry.sourceDetection === "fixed-flatbed") {
    ctx.source = "flatbed";
  } else if (entry.sourceDetection === "fixed-adf") {
    ctx.source = "adf";
  }
}

/**
 * Rejects a PARA source the hardware can't do. Currently only guards
 * adf-duplex against simplex-only ADFs.
 *
 * Called from buildParaSend after the source axis resolves — NOT at entry
 * resolution. `stat-length` entries don't know their source until
 * INIT_POLL_STAT, and `duplex=true` on a flatbed scan is inert and must stay
 * that way (SCAN_SIDES defaults to "duplex", so flatbed-only models see it on
 * every default host-triggered scan).
 *
 * Origin-independent: an adf-duplex PARA against a simplex-only ADF is wrong
 * whether the panel or the host asked for it.
 */
export function assertSourceSupported(entry: Dialect, source: ParaSpec["source"]): void {
  if (source === "adf-duplex" && !entry.adfDuplex) {
    throw new Error(
      `${entry.displayName} has no duplex ADF — refusing to compose an adf-duplex PARA ` +
        `the hardware never advertised. Set SCAN_SIDES=simplex for host-triggered scans, ` +
        `or scan 1-sided from the panel.`,
    );
  }
}

/**
 * Pure projection of a registry entry + source/action axes onto a ParaSpec.
 * Called at PARA-build time after the source axis has been resolved (with
 * duplex folded in by the call site).
 */
export function makeParaSpec(
  entry: Dialect,
  source: ParaSpec["source"],
  action: ParaSpec["action"],
  resolution?: number,
  colorMode?: ParaSpec["colorMode"],
  jpegQuality?: number,
): ParaSpec {
  return {
    source,
    action,
    fbExtents: entry.fbExtents,
    adfExtents: entry.adfExtents,
    gmm: entry.gmm,
    gammaClass: entry.gammaClass,
    cmxClass: entry.cmxClass,
    optionalSegments: entry.optionalSegments,
    profile: entry.paraProfile,
    resolution,
    colorMode,
    monoGammaClass: entry.monoGammaClass,
    jpegQuality,
  };
}
