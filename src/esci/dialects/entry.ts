import type { Buffer } from "node:buffer";
import type { Source, Format, ScanMode, ScanGeometry, FsGReply } from "../commands.js";

export type SetupEntryState = "INIT" | "XP_IDENT_A_META";
export type TeardownEntryState = "POST_STATUS" | "XP_TEARDOWN_INIT";

/** A dialect branch point: target state + the command to emit on entry.
 *  `send` takes no ctx — every setup/teardown command is context-independent,
 *  so this module needs no dependency on the graph's EsciCtx. */
export interface Branch<S extends string> {
  next: S;
  send: () => Buffer;
}

export interface LegacyDialectEntry {
  name: "wf3620" | "xp620";
  productName: string | null; // push-scan PID; null = default fallback
  sourcePolicy: "detect" | "fixed-flatbed";
  supportedSources: Source[];
  raster: (mode: ScanMode) => Pick<ScanGeometry, "widthPx" | "heightPx">;
  gamma: { r: Buffer; g: Buffer; b: Buffer };
  fswBlock: (mode: ScanMode) => Buffer;
  streamConfig: (reply: FsGReply, format: Format) => Buffer;
  prestart: "status-then-start" | "start-direct";
  setup: Branch<SetupEntryState>;
  teardown: Branch<TeardownEntryState>;
}
