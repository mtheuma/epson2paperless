import { buildEscI, buildEscInit } from "../commands.js";
import { passthru } from "./send.js";
import {
  XP_RASTER,
  XP_GAMMA_R,
  XP_GAMMA_G,
  XP_GAMMA_B,
  XP_FSW_BLOCK,
  XP_STREAM_CONFIG,
} from "./xp620-data.js";
import type { LegacyDialectEntry } from "./entry.js";

export const XP620_ENTRY: LegacyDialectEntry = {
  name: "xp620",
  productName: "PID 08C8",
  sourcePolicy: "fixed-flatbed",
  supportedSources: ["flatbed"],
  raster: () => XP_RASTER,
  gamma: { r: XP_GAMMA_R, g: XP_GAMMA_G, b: XP_GAMMA_B },
  fswBlock: () => XP_FSW_BLOCK, // fixed; format-independent
  streamConfig: () => XP_STREAM_CONFIG, // fixed; format-independent
  prestart: "start-direct",
  // ESC I is a two-phase read: reply size 4 (STX 02 02 + LE u16 length), then a
  // pure-read of that length. XP_IDENT_A_META handles phase 2 (see Task 12).
  setup: { next: "XP_IDENT_A_META", send: () => passthru(buildEscI(), 4) }, // ESC I (reply 4)
  teardown: { next: "XP_TEARDOWN_INIT", send: () => passthru(buildEscInit(), 1) }, // ESC @ (reply 1)
  deliveredDpi: () => 300, // fixed; format-independent
};
