import { REGISTRY, type RegistryEntry } from "./registry.js";
import type { ParaSpec } from "../para-composer.js";
import { buildDiagnostic, UnsupportedDialectError } from "../diagnostic.js";

/**
 * Looks up the registry entry for a CAPA fingerprint. Throws
 * UnsupportedDialectError on miss with the existing diagnostic block.
 *
 * Called from INIT1_CAPA in the graph state machine, immediately after the
 * fingerprint is computed.
 */
export function lookupRegistryEntry(
  fingerprint: string,
  capaBody: Buffer,
  infoBody: Buffer,
  transport: "tls" | "plain",
): RegistryEntry {
  const entry = REGISTRY.get(fingerprint);
  if (entry === undefined) {
    const diagnostic = buildDiagnostic({ capaBody, infoBody, transport, fingerprint });
    throw new UnsupportedDialectError(fingerprint, diagnostic);
  }
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
  };
}
