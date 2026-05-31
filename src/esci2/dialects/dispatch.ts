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
 * Pins ctx.source = "flatbed" when the resolved entry uses fixed-flatbed
 * source detection. Replaces the legacy applyDialectSourceOverride helper.
 *
 * Necessary because the TLS scanner shell pre-sets ctx.source = "adf"
 * (src/esci2/scanner.ts) and expects the override to flip it for
 * flatbed-only TLS printers (ET-2950).
 */
export function applyEntrySourceOverride(
  ctx: { source: "adf" | "flatbed" },
  entry: RegistryEntry,
): void {
  if (entry.sourceDetection === "fixed-flatbed") {
    ctx.source = "flatbed";
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
  };
}
