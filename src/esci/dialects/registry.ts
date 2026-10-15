import { WF3620_ENTRY } from "./wf3620.js";
import { XP620_ENTRY } from "./xp620.js";
import { ET2550_ENTRY } from "./et2550.js";
import type { LegacyDialectEntry } from "./entry.js";

// Every entry gets a PID-lookup slot. New PID-keyed dialects are added here,
// not by hand-editing BY_PID.
const PID_ENTRIES: LegacyDialectEntry[] = [WF3620_ENTRY, XP620_ENTRY, ET2550_ENTRY];

const BY_PID: Record<string, LegacyDialectEntry> = {};
for (const entry of PID_ENTRIES) {
  BY_PID[entry.productName] = entry;
}

// The WF-3620 settings are the de facto generic legacy dialect: any PID
// without an entry of its own, and every trigger that carries no PID
// (scan:now, the webhook), runs them. The session's identity check says
// which of those cases it is.
const FALLBACK_ENTRY = WF3620_ENTRY;

// PIDs with a dedicated legacy dialect. Exported so the protocol probe's
// ESC/I-2 PID-hint set can be tested disjoint from legacy routing — a PID in
// both would silently shadow its legacy dialect under PRINTER_PROTOCOL=auto.
export const LEGACY_DIALECT_PIDS: ReadonlySet<string> = new Set(Object.keys(BY_PID));

export function resolveLegacyEntry(productName: string | null): LegacyDialectEntry {
  return (productName && BY_PID[productName]) || FALLBACK_ENTRY;
}

/**
 * How the product the printer names in its FS I identity reply relates to
 * the dialect the session is running:
 * - `match`: it is the dialect's own PID.
 * - `unrecognised`: the session is on the fallback and no dialect claims the
 *   product — an untested older model trying the WF-3620 settings.
 * - `mismatch`: another dialect claims the product (`owner`), or the
 *   session picked a PID-keyed dialect the printer doesn't name.
 */
export type LegacyIdentityCheck =
  | { kind: "match" }
  | { kind: "unrecognised" }
  | { kind: "mismatch"; owner: LegacyDialectEntry | null };

export function checkLegacyIdentity(
  entry: LegacyDialectEntry,
  productName: string | null,
): LegacyIdentityCheck {
  if (productName === entry.productName) return { kind: "match" };
  const owner = (productName && BY_PID[productName]) || null;
  if (owner === null && entry === FALLBACK_ENTRY) return { kind: "unrecognised" };
  return { kind: "mismatch", owner };
}
