import { GAMMA_LUT_R, GAMMA_LUT_G, GAMMA_LUT_B } from "../luts.js";
import {
  buildFsWBlock,
  buildStreamConfigPayload,
  geometry,
  buildEscInit,
  buildFsF,
} from "../commands.js";
import { passthru } from "./send.js";
import type { LegacyDialectEntry } from "./entry.js";

export const WF3620_ENTRY: LegacyDialectEntry = {
  name: "wf3620",
  productName: null,
  sourcePolicy: "detect",
  supportedSources: ["flatbed", "adf-simplex", "adf-duplex"],
  raster: (mode) => geometry(mode),
  gamma: { r: GAMMA_LUT_R, g: GAMMA_LUT_G, b: GAMMA_LUT_B },
  fswBlock: (mode) => buildFsWBlock(mode),
  streamConfig: (reply, format) => buildStreamConfigPayload(reply, format),
  prestart: "status-then-start",
  setup: { next: "INIT", send: () => passthru(buildEscInit(), 1) }, // ESC @  (reply 1)
  teardown: { next: "POST_STATUS", send: () => passthru(buildFsF(), 16) }, // FS F   (reply 16)
  deliveredDpi: (mode) => (mode.format === "jpg" ? 600 : 300), // mirrors geometryFor
};
