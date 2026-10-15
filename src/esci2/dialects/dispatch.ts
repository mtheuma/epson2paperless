import { REGISTRY_ENTRIES, type RegistryEntry } from "./registry.js";
import type { ParaSpec } from "../para-composer.js";
import { buildDiagnostic, UnsupportedDialectError } from "../diagnostic.js";
import { parseInfoTokens } from "../capabilities.js";
import { createLogger } from "../../logger.js";

const log = createLogger("scanner-esci2");

/** Which key resolved a session's registry entry. */
export type IdentityMatch = "pid" | "name" | "fingerprint";

export interface ResolvedEntry {
  entry: RegistryEntry;
  matchedBy: IdentityMatch;
  /** The INFO `#PRD` product ID, if the printer reported one. */
  pid: string | null;
  /** The INFO `#PRD` product name, if the printer reported a name instead. */
  productName: string | null;
}

const upper = (s: string | null) => s?.toUpperCase() ?? null;

/**
 * Looks up the registry entry by model identity: the INFO product ID, then
 * the INFO product name, then the CAPA fingerprint. Throws
 * UnsupportedDialectError with the diagnostic block when none matches.
 *
 * A PID or name hit whose CAPA fingerprint isn't one of the entry's logs a
 * warning with the diagnostic block and proceeds with that entry: the model
 * is known, and its CAPA reply may have changed with a firmware update.
 *
 * Called from INIT1_CAPA in the graph state machine. INFO is read before
 * CAPA, so the identity is available on every trigger path, including the
 * host-triggered ones that carry no panel PID.
 */
export function lookupRegistryEntry(
  fingerprint: string,
  capaBody: Buffer,
  infoBody: Buffer,
  transport: "tls" | "plain",
): ResolvedEntry {
  const info = parseInfoTokens(infoBody);
  const pid = upper(info.prdPid);
  const name = upper(info.prdName);
  const identity = { pid: info.prdPid, productName: info.prdName };
  const byFingerprint = REGISTRY_ENTRIES.find((e) => e.capaFingerprints.includes(fingerprint));

  const byPid = pid === null ? undefined : REGISTRY_ENTRIES.find((e) => e.pids.includes(pid));
  const byName =
    name === null
      ? undefined
      : REGISTRY_ENTRIES.find((e) => e.names.some((n) => n.toUpperCase() === name));
  const byIdentity = byPid ?? byName;
  if (byIdentity !== undefined) {
    const matchedBy = byPid !== undefined ? "pid" : "name";
    if (!byIdentity.capaFingerprints.includes(fingerprint)) {
      const reported = matchedBy === "pid" ? `PID ${info.prdPid}` : `product name ${info.prdName}`;
      const diagnostic = buildDiagnostic({ capaBody, infoBody, transport, fingerprint });
      log.warn(
        `Printer identified as ${byIdentity.displayName} by its ${reported}, but its CAPA ` +
          `fingerprint is not one recorded for that model` +
          (byFingerprint ? ` (it is the ${byFingerprint.displayName} one)` : "") +
          `. Continuing with that model's settings; if the scan fails or looks wrong, ` +
          `please file an issue with the diagnostic block below:\n\n${diagnostic}`,
      );
    }
    return { entry: byIdentity, matchedBy, ...identity };
  }

  if (byFingerprint === undefined) {
    const diagnostic = buildDiagnostic({ capaBody, infoBody, transport, fingerprint });
    throw new UnsupportedDialectError(fingerprint, diagnostic);
  }
  return { entry: byFingerprint, matchedBy: "fingerprint", ...identity };
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
export function assertSourceSupported(entry: RegistryEntry, source: ParaSpec["source"]): void {
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
  entry: RegistryEntry,
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
