import { WF3620_ENTRY } from "./wf3620.js";
import { XP620_ENTRY } from "./xp620.js";
import type { LegacyDialectEntry } from "./entry.js";

// Every entry with a non-null productName gets a PID-lookup slot. New
// PID-keyed dialects are added here, not by hand-editing BY_PID.
const PID_ENTRIES: LegacyDialectEntry[] = [XP620_ENTRY];

const BY_PID: Record<string, LegacyDialectEntry> = {};
for (const entry of PID_ENTRIES) {
  if (entry.productName === null) {
    throw new Error(`registry: dialect "${entry.name}" has no productName — cannot key BY_PID`);
  }
  BY_PID[entry.productName] = entry;
}

export function resolveLegacyEntry(productName: string | null): LegacyDialectEntry {
  return (productName && BY_PID[productName]) || WF3620_ENTRY;
}
