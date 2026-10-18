import type { Buffer } from "node:buffer";
import type { Format, ScanMode, ScanGeometry, FsGReply } from "../commands.js";

export type SetupEntryState = "INIT" | "XP_IDENT_A_META";
export type TeardownEntryState = "POST_STATUS" | "XP_TEARDOWN_INIT" | "ET_TEARDOWN_PAREN";

/** A dialect branch point: target state + the command to emit on entry.
 *  `send` takes no ctx — every setup/teardown command is context-independent,
 *  so this module needs no dependency on the graph's EsciCtx. */
export interface Branch<S extends string> {
  next: S;
  send: () => Buffer;
}

export interface LegacyDialectEntry {
  name: "wf3620" | "xp620" | "et2550";
  /** `PID XXXX`, matched against the push-scan trigger and the FS I identity reply. */
  productName: string;
  /**
   * `detect`: the session's FS F replies settle the source — the first one
   * says whether an ADF is fitted (none → flatbed), and on a printer with one
   * the status byte picks flatbed or ADF. `fixed-flatbed`: flatbed from the
   * start, for a dialect whose setup never reaches those states (the XP-620);
   * a forced ADF source is rejected before connecting.
   */
  sourcePolicy: "detect" | "fixed-flatbed";
  raster: (mode: ScanMode) => Pick<ScanGeometry, "widthPx" | "heightPx">;
  gamma: { r: Buffer; g: Buffer; b: Buffer };
  fswBlock: (mode: ScanMode) => Buffer;
  streamConfig: (reply: FsGReply, format: Format) => Buffer;
  prestart: "status-then-start" | "start-direct";
  setup: Branch<SetupEntryState>;
  teardown: Branch<TeardownEntryState>;
  /**
   * DPI the fixed wire parameters actually deliver for a mode. The legacy
   * path has NO wire resolution arm (cross-product DPI×format combos are
   * uncaptured, and every dialect's FS W block and stream config are built
   * for its fixed captured geometries only) — this feeds only the host-side
   * downsample decision.
   */
  deliveredDpi: (mode: ScanMode) => number;
}
