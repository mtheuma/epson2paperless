import { WF3620_ENTRY } from "./wf3620.js";
import { XP620_ENTRY } from "./xp620.js";
import type { LegacyDialectEntry } from "./entry.js";

const BY_PID: Record<string, LegacyDialectEntry> = {
  [XP620_ENTRY.productName as string]: XP620_ENTRY,
};

export function resolveLegacyEntry(productName: string | null): LegacyDialectEntry {
  return (productName && BY_PID[productName]) || WF3620_ENTRY;
}
