// src/esci2/test-support/dialects.ts
//
// Registry entries completed into the dialect a session would run, for tests
// that compose PARA or drive graph states for a known model.

import { parseCapaTokens, parseInfoTokens } from "../capabilities.js";
import { computeCapaFingerprint } from "../capa-fingerprint.js";
import { withCapabilities } from "../dialects/dispatch.js";
import { REGISTRY, type Dialect } from "../dialects/registry.js";
import {
  DIAGNOSTICS,
  REPLAY_FIXTURES,
  bodiesFromDiagnostic,
  readInit1Bodies,
  type CapabilityBodies,
} from "./capability-bodies.js";

/**
 * The INFO and CAPA bodies recorded for the model a CAPA fingerprint belongs
 * to: a replay fixture's INIT1 replies, else the bodies rebuilt from its
 * issue diagnostic (which carry only the lines that block has).
 */
export function recordedBodies(fingerprint: string): CapabilityBodies {
  for (const { path } of REPLAY_FIXTURES) {
    const bodies = readInit1Bodies(path);
    if (computeCapaFingerprint(bodies.capa) === fingerprint) return bodies;
  }
  const diagnostic = DIAGNOSTICS.find((d) => d.fp === fingerprint);
  if (diagnostic !== undefined) return bodiesFromDiagnostic(diagnostic.block);
  throw new Error(`recordedBodies: no fixture or diagnostic for fingerprint ${fingerprint}`);
}

/**
 * The registry entry for a CAPA fingerprint, completed with the capability
 * fields derived from that model's recorded bodies: the dialect its session
 * runs (for a diagnostic-only model, as far as its block tells).
 */
export function recordedDialect(fingerprint: string): Dialect {
  const entry = REGISTRY.get(fingerprint);
  if (entry === undefined) throw new Error(`recordedDialect: no entry for ${fingerprint}`);
  const { info, capa } = recordedBodies(fingerprint);
  return withCapabilities(entry, parseInfoTokens(info), parseCapaTokens(capa));
}
