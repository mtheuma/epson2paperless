// src/esci2/graph.ts

import {
  createGraph,
  decision,
  type Graph,
  type GraphBuilder,
  type SendSpec,
} from "../scan-session.js";
import {
  buildLockPacket,
  buildUnlockPacket,
  buildPassthruPacket,
  buildPurereadPacket,
} from "../protocol.js";
import {
  buildFsY,
  buildFsX,
  buildFsZ,
  buildEsci2Command,
  buildParaHeader,
  buildParaPayload,
  parseEsci2ReplyHeader,
  parseTokens,
} from "./commands.js";

// Suppress unused-import warnings for identifiers used in T26 state helpers.
void buildUnlockPacket;

/**
 * Per-session mutable state threaded through every transition. The engine
 * owns the page-index + back-page-indices + sessionTempDir bookkeeping;
 * everything here is ESC/I-2-protocol-specific.
 */
export interface Esci2Ctx {
  duplex: boolean;
  source: "adf" | "flatbed"; // detected at INIT_POLL iteration 0
  initPollIteration: number;
  imgChunkSize: number;
  pageEndKind: "none" | "more" | "last";
  pageSide: "front" | "back";
  zeroImgRetries: number;
  postScanCycle: 1 | 2;
}

export const ESCI2_TIMEOUT_MS = 30_000;
export const ESCI2_REPLY_SIZE = 64;
const LEGACY_REPLY_SIZE = 1;
const INIT_POLL_ITERATIONS = 3;

/**
 * Async-event dispatch bytes (type 0x9000 body[0]).
 * Verified against current src/esci2/scanner.ts:124-126.
 */
const ASYNC_FATAL_BYTES = new Set([
  0x02, // Disconnect
  0x80, // Timeout
  0xa0, // ServerError
]);
const ASYNC_CANCEL_BYTES = new Set([0x03 /* ScanCancel */]);

// =============================================================================
// Helpers
// =============================================================================

/**
 * awaitAck — creates a static state that waits for `expectedReplyType` and
 * optionally sends bytes on transition. Used in WELCOME/LOCKING/INIT1/INIT2.
 */
function awaitAck(
  g: GraphBuilder<Esci2Ctx>,
  name: string,
  expectedReplyType: number,
  next: string,
  send?: SendSpec<Esci2Ctx> | SendSpec<Esci2Ctx>[],
): void {
  g.state(name, { on: { [expectedReplyType]: { next, ...(send !== undefined ? { send } : {}) } } });
}

// =============================================================================
// Graph builder
// =============================================================================

const g = createGraph<Esci2Ctx>("WELCOME", ESCI2_TIMEOUT_MS)
  // Empty 0xa000 envelopes are "wait for body" pre-data signals on the
  // ESC/I-2 wire (current scanner.ts:393-396 silently logs and waits).
  // Filter them out pre-dispatch so consumer states see only non-empty
  // 0xa000 packets.
  .globalIgnoreFilter((packet) => packet.type === 0xa000 && packet.payload.length === 0)
  // 0x9000 is the protocol-level async event channel: fatal/cancel
  // payloads abort the session regardless of state; ScanStart/Stop and
  // unknown bytes are info-only (return null to ignore). Mirrors
  // scanner.ts:345-387's existing handleAsyncEvent.
  .globalAbortHandlers({
    0x9000: (_ctx, packet) => {
      const dispatch = packet.payload.length > 0 ? packet.payload[0] : -1;
      if (ASYNC_FATAL_BYTES.has(dispatch)) {
        return new Error(`Async fatal event 0x${dispatch.toString(16)}`);
      }
      if (ASYNC_CANCEL_BYTES.has(dispatch)) {
        return new Error(`Async ScanCancel (0x${dispatch.toString(16)})`);
      }
      return null; // ScanStart (0x01), Stop (0x04), or unknown — info-only
    },
  });

// =============================================================================
// T22: WELCOME / LOCKING / INIT1 / INIT2 cycles
// =============================================================================

// WELCOME: 0x8000 from printer → host sends LOCK → LOCKING
// Replaces the T21 placeholder.
awaitAck(g, "WELCOME", 0x8000, "LOCKING", buildLockPacket());

// LOCKING: 0xa100 lock-ack → send FS Y → INIT1_FS_Y
// scanner.ts onLockAck: receives 0xa100, sends buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE)
awaitAck(g, "LOCKING", 0xa100, "INIT1_FS_Y", buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE));

// INIT1_FS_Y: 0xa000 FS-Y-ack → send INFO META command → INIT1_INFO_META
// scanner.ts onInit1FsY: receives 0xa000, runs INFO+CAPA two-phase sequence,
// then sends FIN → INIT1_FIN. INFO/CAPA states added in T24.
awaitAck(
  g,
  "INIT1_FS_Y",
  0xa000,
  "INIT1_INFO_META",
  buildPassthruPacket(buildEsci2Command("INFO"), ESCI2_REPLY_SIZE),
);

// INIT1_FIN: 0xa000 FIN-ack → send FS Z → INIT2_FS_Z
// scanner.ts onInit1Fin: receives 0xa000, sends buildPassthruPacket(buildFsZ(), LEGACY_REPLY_SIZE)
awaitAck(g, "INIT1_FIN", 0xa000, "INIT2_FS_Z", buildPassthruPacket(buildFsZ(), LEGACY_REPLY_SIZE));

// INIT2_FS_Z: 0xa000 FS-Z-ack → send INFO META command → INIT2_INFO_META
// scanner.ts onInit2FsZ: receives 0xa000, runs INFO+CAPA+RESA two-phase sequence,
// then sends FIN → INIT2_FIN. INFO/CAPA/RESA states added in T24.
awaitAck(
  g,
  "INIT2_FS_Z",
  0xa000,
  "INIT2_INFO_META",
  buildPassthruPacket(buildEsci2Command("INFO"), ESCI2_REPLY_SIZE),
);

// INIT2_FIN: 0xa000 FIN-ack → reset initPollIteration, send FS Y → INIT_POLL_FS_Y.
// scanner.ts onInit2Fin: receives 0xa000, sets initPollIteration=0, sends buildPassthruPacket(buildFsY(), 1).
awaitAck(
  g,
  "INIT2_FIN",
  0xa000,
  "INIT_POLL_FS_Y",
  buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE),
);

// =============================================================================
// T24: twoPhaseRead helper + INIT1/INIT2 TPR cycles + MODE_SWITCH / POST_MODE /
//      PARA / TRDT / IMG_META states
// =============================================================================

/**
 * twoPhaseRead — generates 2 states for a capability-read command:
 *   `${prefix}_META` — decision: parses reply header; validates cmd name;
 *                       sends a pure-read for the declared length; advances to _DATA.
 *   `${prefix}_DATA` — static: 0xa000 body receipt; sends `nextSend`; advances to `next`.
 *
 * Used for INFO / CAPA / RESA commands in INIT1 and INIT2.
 */
function twoPhaseRead(
  g: GraphBuilder<Esci2Ctx>,
  prefix: string,
  expectedCmd: string,
  nextSend: SendSpec<Esci2Ctx> | SendSpec<Esci2Ctx>[],
  next: string,
): void {
  g.state(
    `${prefix}_META`,
    decision<Esci2Ctx>((_ctx, packet) => {
      const header = parseEsci2ReplyHeader(packet.payload);
      if (header === null || header.cmd !== expectedCmd) {
        return {
          error: new Error(
            `${prefix}_META: bad reply header (expected cmd=${expectedCmd}, got ${header?.cmd ?? "(unparseable)"})`,
          ),
        };
      }
      return {
        next: `${prefix}_DATA`,
        send: buildPurereadPacket(header.length),
      };
    }),
  );

  g.state(`${prefix}_DATA`, {
    on: { 0xa000: { next, send: nextSend } },
  });
}

// INIT1 two-phase reads: INFO → CAPA → FIN
twoPhaseRead(
  g,
  "INIT1_INFO",
  "INFO",
  buildPassthruPacket(buildEsci2Command("CAPA"), ESCI2_REPLY_SIZE),
  "INIT1_CAPA_META",
);
twoPhaseRead(
  g,
  "INIT1_CAPA",
  "CAPA",
  buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
  "INIT1_FIN",
);

// INIT2 two-phase reads: INFO → CAPA → RESA → FIN
twoPhaseRead(
  g,
  "INIT2_INFO",
  "INFO",
  buildPassthruPacket(buildEsci2Command("CAPA"), ESCI2_REPLY_SIZE),
  "INIT2_CAPA_META",
);
twoPhaseRead(
  g,
  "INIT2_CAPA",
  "CAPA",
  buildPassthruPacket(buildEsci2Command("RESA"), ESCI2_REPLY_SIZE),
  "INIT2_RESA_META",
);
twoPhaseRead(
  g,
  "INIT2_RESA",
  "RESA",
  buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
  "INIT2_FIN",
);

// =============================================================================
// T23: statThenDrain helper + INIT_POLL cycle
// =============================================================================

/**
 * statThenDrain — builds three states that encode the "STAT reply → optional
 * drain → FIN" sub-flow that recurs in INIT_POLL (inline), POST_MODE (T24),
 * and POSTSCAN×2 (T26).
 *
 *   `${prefix}_STAT`       — decision: parses reply header length; if >0 sends
 *                            pure-read and goes to _STAT_DRAIN, else sends FIN
 *                            and goes to _FIN.
 *   `${prefix}_STAT_DRAIN` — static: 0xa000 → sends FIN, goes to _FIN.
 *   `${prefix}_FIN`        — static: 0xa000 → next (with optional finSend).
 *
 * INIT_POLL does not use this helper because its FIN state is a custom decision
 * (loop-back vs advance). POST_MODE and POSTSCAN use it directly.
 */
function statThenDrain(
  g: GraphBuilder<Esci2Ctx>,
  prefix: string,
  next: string,
  finSend?: SendSpec<Esci2Ctx> | SendSpec<Esci2Ctx>[],
): void {
  g.state(
    `${prefix}_STAT`,
    decision<Esci2Ctx>((_ctx, packet) => {
      const header = parseEsci2ReplyHeader(packet.payload);
      if (header === null) {
        return { error: new Error(`${prefix}_STAT: unparseable reply header`) };
      }
      if (header.length > 0) {
        return {
          next: `${prefix}_STAT_DRAIN`,
          send: buildPurereadPacket(header.length),
        };
      }
      return {
        next: `${prefix}_FIN`,
        send: buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
      };
    }),
  );

  g.state(`${prefix}_STAT_DRAIN`, {
    on: {
      0xa000: {
        next: `${prefix}_FIN`,
        send: buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
      },
    },
  });

  g.state(`${prefix}_FIN`, {
    on: { 0xa000: { next, ...(finSend !== undefined ? { send: finSend } : {}) } },
  });
}

// Expose for T24-T26 (referenced below once those task blocks are added).
void statThenDrain;

// ---------------------------------------------------------------------------
// INIT_POLL cycle — 3 iterations of FS Y → STAT → (optional drain) → FIN
// ---------------------------------------------------------------------------
//
// Inlined rather than using statThenDrain because INIT_POLL_FIN is a decision
// state that does the loop-back check on the same 0xa000 packet that completes
// the FIN exchange, rather than a plain static transition.
// Mirrors scanner.ts onInitFsY / onInitStat / onInitStatDrain / onInitFin.

// INIT_POLL_FS_Y: receives 0xa000 (FS Y ACK, payload[0]=0x06); sends STAT.
g.state("INIT_POLL_FS_Y", {
  on: {
    0xa000: {
      next: "INIT_POLL_STAT",
      send: buildPassthruPacket(buildEsci2Command("STAT"), ESCI2_REPLY_SIZE),
    },
  },
});

// INIT_POLL_STAT: decision on STAT reply — drain if length>0, else FIN.
// On the first iteration (ctx.initPollIteration === 0) also detects source:
//   length 0 → ADF (no status queued); length 12 → flatbed (filler #---#---#---).
//   Other lengths default to ADF (mirrors scanner.ts:619-633).
g.state(
  "INIT_POLL_STAT",
  decision<Esci2Ctx>((ctx, packet) => {
    const header = parseEsci2ReplyHeader(packet.payload);
    if (header === null) {
      return { error: new Error("INIT_POLL_STAT: unparseable reply header") };
    }
    // Source detection — only on the FIRST iteration. Per scanner.ts:619-633:
    // length 0 → ADF (printer queued no status); length 12 → flatbed (queued
    // `#---#---#---` filler). Other lengths default to ADF with a comment.
    if (ctx.initPollIteration === 0) {
      if (header.length === 0) {
        ctx.source = "adf";
      } else if (header.length === 12) {
        ctx.source = "flatbed";
      } else {
        ctx.source = "adf"; // fallback per scanner.ts:626-627
      }
    }
    if (header.length > 0) {
      return {
        next: "INIT_POLL_STAT_DRAIN",
        send: buildPurereadPacket(header.length),
      };
    }
    return {
      next: "INIT_POLL_FIN",
      send: buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
    };
  }),
);

// INIT_POLL_STAT_DRAIN: drains queued status bytes, then sends FIN.
g.state("INIT_POLL_STAT_DRAIN", {
  on: {
    0xa000: {
      next: "INIT_POLL_FIN",
      send: buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
    },
  },
});

// INIT_POLL_FIN: decision on FIN reply — loop or advance to MODE_SWITCH.
// scanner.ts onInitFin: increments initPollIteration; if <3 sends FS Y and
// loops; else sends FS X and moves to MODE_SWITCH.
g.state(
  "INIT_POLL_FIN",
  decision<Esci2Ctx>((ctx, _packet) => {
    ctx.initPollIteration += 1;
    if (ctx.initPollIteration < INIT_POLL_ITERATIONS) {
      return {
        next: "INIT_POLL_FS_Y",
        send: buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE),
      };
    }
    // 3 iterations done — send FS X to enter extended mode → MODE_SWITCH.
    // scanner.ts onInitFin: sends buildPassthruPacket(buildFsX(), LEGACY_REPLY_SIZE).
    return {
      next: "MODE_SWITCH",
      send: buildPassthruPacket(buildFsX(), LEGACY_REPLY_SIZE),
    };
  }),
);

// =============================================================================
// T24 (continued): MODE_SWITCH / POST_MODE_STAT / PARA / TRDT / IMG_META states
// =============================================================================

// Helper: build the PARA header + body send pair, resolving source + duplex from ctx.
// Called both in POST_MODE_STAT's decision (skip-drain branch) and in the
// POST_MODE_STAT_DRAIN static transition (drain branch). Each call computes
// paraPayload once per thunk invocation; the cost is negligible.
function buildParaSend(ctx: Esci2Ctx): [Buffer, Buffer] {
  const paraPayload = buildParaPayload({ source: ctx.source, duplex: ctx.duplex });
  return [
    buildPassthruPacket(buildParaHeader(paraPayload.length), 0),
    buildPassthruPacket(paraPayload, ESCI2_REPLY_SIZE),
  ];
}

// MODE_SWITCH: receives the FS X ack (payload[0]=0x06); sends STAT → POST_MODE_STAT.
// scanner.ts onModeSwitch: validates ACK byte, sends STAT.
g.state("MODE_SWITCH", {
  on: {
    0xa000: {
      validate: (payload) => payload[0] === 0x06,
      next: "POST_MODE_STAT",
      send: buildPassthruPacket(buildEsci2Command("STAT"), ESCI2_REPLY_SIZE),
    },
  },
});

// POST_MODE_STAT: decision on STAT reply.
// If length>0 → pure-read drain → POST_MODE_STAT_DRAIN.
// If length===0 → send PARA header + body → PARA.
// scanner.ts onPostModeStat: same drain-or-skip logic; sendParaHeaderAndBody on both paths.
g.state(
  "POST_MODE_STAT",
  decision<Esci2Ctx>((_ctx, packet) => {
    const header = parseEsci2ReplyHeader(packet.payload);
    if (header === null) {
      return { error: new Error("POST_MODE_STAT: unparseable reply header") };
    }
    if (header.length > 0) {
      return {
        next: "POST_MODE_STAT_DRAIN",
        send: buildPurereadPacket(header.length),
      };
    }
    return {
      next: "PARA",
      send: [(ctx) => buildParaSend(ctx)[0], (ctx) => buildParaSend(ctx)[1]],
    };
  }),
);

// POST_MODE_STAT_DRAIN: drains queued status bytes, then sends PARA header + body → PARA.
// scanner.ts onPostModeStatDrain: calls sendParaHeaderAndBody().
g.state("POST_MODE_STAT_DRAIN", {
  on: {
    0xa000: {
      next: "PARA",
      send: [(ctx) => buildParaSend(ctx)[0], (ctx) => buildParaSend(ctx)[1]],
    },
  },
});

// PARA: validates printer's acceptance of parameters (#parOK), sends TRDT.
// scanner.ts onPara: parses tokens, checks #parOK, sends TRDT.
g.state("PARA", {
  on: {
    0xa000: {
      validate: (payload) => {
        const tokens = parseTokens(payload.subarray(12));
        return tokens.get("par")?.trim() === "OK";
      },
      next: "TRDT",
      send: buildPassthruPacket(buildEsci2Command("TRDT"), ESCI2_REPLY_SIZE),
    },
  },
});

// TRDT: transfer-data handshake; sends IMG to start the image-receive loop.
// scanner.ts onTrdt: receives 0xa000, sends IMG → IMG_META.
g.state("TRDT", {
  on: {
    0xa000: {
      next: "IMG_META",
      send: buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE),
    },
  },
});

// IMG_META: decision on IMG reply header.
// - Parses header; errors on unparseable or #ERR* token.
// - Updates ctx.imgChunkSize, ctx.pageSide, ctx.pageEndKind.
// - Sends pure-read for the declared image chunk; advances to IMG_DATA.
//
// pageEndKind logic (mirrors scanner.ts:835-843):
//   On flatbed, any #pen is terminal (glass is inherently single-page; #lft
//   is never emitted on the flatbed path). On ADF, #lftd000 disambiguates
//   "terminal" (last page) vs "page boundary, more coming".
//     pageEndKind = tokens.has("pen")
//       ? source === "flatbed" || tokens.get("lft") === "d000" ? "last" : "more"
//       : "none";
g.state(
  "IMG_META",
  decision<Esci2Ctx>((ctx, packet) => {
    const header = parseEsci2ReplyHeader(packet.payload);
    if (!header) {
      return { error: new Error("IMG_META: unparseable reply header") };
    }
    const tokens = parseTokens(packet.payload.subarray(12));
    for (const key of tokens.keys()) {
      if (key.startsWith("ERR") || key.startsWith("err")) {
        return {
          error: new Error(`IMG_META: printer error token #${key}${tokens.get(key) ?? ""}`),
        };
      }
    }
    ctx.imgChunkSize = header.length;
    ctx.pageSide = tokens.get("typ") === "IMGB" ? "back" : "front";
    // Per scanner.ts:835-842:
    // On flatbed, any #pen is terminal because the glass is single-page.
    // On ADF, #lftd000 disambiguates "terminal" vs "page boundary, more coming".
    if (tokens.has("pen")) {
      if (ctx.source === "flatbed") {
        ctx.pageEndKind = "last";
      } else if (tokens.get("lft") === "d000") {
        ctx.pageEndKind = "last";
      } else {
        ctx.pageEndKind = "more";
      }
    } else {
      ctx.pageEndKind = "none";
    }
    return {
      next: "IMG_DATA",
      send: buildPurereadPacket(ctx.imgChunkSize),
    };
  }),
);

// =============================================================================
// Export the built graph
// =============================================================================

export const esci2Graph: Graph<Esci2Ctx> = g.build();
