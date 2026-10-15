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
// (scan:now, the webhook), starts on them. The session's identity check says
// which of those cases it is, and hands a PID-less session over to the
// printer's own dialect when that dialect's setup matches (the ET-2550).
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
 * - `switch`: another dialect claims the product (`owner`) and its setup
 *   branch is the running dialect's, so every byte on the wire so far is what
 *   `owner` would have sent; the session can carry on as `owner`.
 * - `mismatch`: another dialect claims the product (`owner`) but its setup
 *   diverged before FS I, or the session picked a PID-keyed dialect the
 *   printer doesn't name (`owner: null`).
 */
export type LegacyIdentityCheck =
  | { kind: "match" }
  | { kind: "unrecognised" }
  | { kind: "switch"; owner: LegacyDialectEntry }
  | { kind: "mismatch"; owner: LegacyDialectEntry | null };

export function checkLegacyIdentity(
  entry: LegacyDialectEntry,
  productName: string | null,
): LegacyIdentityCheck {
  if (productName === entry.productName) return { kind: "match" };
  const owner = (productName && BY_PID[productName]) || null;
  if (owner === null && entry === FALLBACK_ENTRY) return { kind: "unrecognised" };
  if (owner !== null && sameSetup(entry, owner)) return { kind: "switch", owner };
  return { kind: "mismatch", owner };
}

// Same setup state and the same first command: the two dialects put
// identical bytes on the wire from the lock up to their first FS I read.
function sameSetup(a: LegacyDialectEntry, b: LegacyDialectEntry): boolean {
  return a.setup.next === b.setup.next && a.setup.send().equals(b.setup.send());
}
