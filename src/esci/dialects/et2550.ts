import { buildEscInit, buildEscCleanup } from "../commands.js";
import { passthru } from "./send.js";
import {
  ET_RASTER,
  ET_GAMMA_R,
  ET_GAMMA_G,
  ET_GAMMA_B,
  ET_FSW_BLOCK,
  ET_STREAM_CONFIG,
} from "./et2550-data.js";
import type { LegacyDialectEntry } from "./entry.js";

/**
 * ET-2550 (issue #166, PID 1106, firmware 1.40) — legacy ESC/I, flatbed-only.
 *
 * Its captured command sequence is the WF-3620 flatbed path with both
 * `ESC e` source-select pairs removed, because there is no ADF to select:
 * sent one, the printer NAKs the parameter byte. The shared graph skips both
 * pairs for any printer whose first FS F reply says no ADF is fitted, which
 * the ET-2550's does, so this dialect needs no source rule or state group of
 * its own; unlike the XP-620 the rest of the flow is identical.
 *
 * Teardown is the one part not backed by observed bytes end to end: the capture
 * ends mid-connection with no FIN, so the trailing `ESC )` and its reply are
 * what we have, and there is no unlock packet (same as the XP-620).
 */
export const ET2550_ENTRY: LegacyDialectEntry = {
  name: "et2550",
  productName: "PID 1106",
  sourcePolicy: "detect",
  raster: () => ET_RASTER,
  gamma: { r: ET_GAMMA_R, g: ET_GAMMA_G, b: ET_GAMMA_B },
  fswBlock: () => ET_FSW_BLOCK, // fixed; format-independent in the capture
  streamConfig: () => ET_STREAM_CONFIG, // fixed; only one geometry captured
  // FS W's ack is followed straight by FS G — no FS F prescan round-trip.
  prestart: "start-direct",
  setup: { next: "INIT", send: () => passthru(buildEscInit(), 1) }, // ESC @ (reply 1)
  teardown: { next: "ET_TEARDOWN_PAREN", send: () => passthru(buildEscCleanup(), 1) }, // ESC ) (reply 1)
  deliveredDpi: () => 300, // fixed; only one geometry captured
};
