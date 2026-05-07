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
  /** Accumulated image-chunk bytes for the current page. Reset on each page flush. */
  imageChunks: Buffer[];
  /**
   * Declared body length captured by the most recent two-phase-read META
   * state, consumed by its paired DATA state for length validation. Lives
   * on ctx (not in a graph-builder closure) so concurrent sessions sharing
   * the singleton `esci2Graph` don't overwrite each other's value.
   */
  tprDeclaredLength: number;
}

export const ESCI2_TIMEOUT_MS = 30_000;
export const ESCI2_REPLY_SIZE = 64;
const LEGACY_REPLY_SIZE = 1;
const INIT_POLL_ITERATIONS = 3;
// scanner.ts:120: 2000 zero-length retries gives ~40s of headroom for slow scan starts.
const MAX_ZERO_IMG_RETRIES = 2000;

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
 * optionally validates the payload byte 0 (e.g. legacy ESC/I-2 ACKs are
 * 0x06 inside an 0xa000 envelope) before advancing.
 */
function awaitAck(
  g: GraphBuilder<Esci2Ctx>,
  name: string,
  expectedReplyType: number,
  next: string,
  send?: SendSpec<Esci2Ctx> | SendSpec<Esci2Ctx>[],
  expectedAckByte?: number,
): void {
  g.state(name, {
    on: {
      [expectedReplyType]: {
        next,
        ...(send !== undefined ? { send } : {}),
        ...(expectedAckByte !== undefined
          ? { validate: (payload: Buffer) => payload[0] === expectedAckByte }
          : {}),
      },
    },
  });
}

/**
 * Guard helper for decision states: ensure the incoming packet matches the
 * expected IS type. Returns an Error TransitionResult on mismatch (the engine
 * routes it through the normal failure path); returns null to continue.
 *
 * Static states fail fast on unmatched packet types automatically (engine
 * behaviour), but decision states see every packet, so each one needs its
 * own type guard to avoid acting on the wrong wire data.
 */
function expectIsType(
  packet: { type: number },
  expected: number,
  stateName: string,
): { error: Error } | null {
  if (packet.type !== expected) {
    return {
      error: new Error(
        `${stateName}: expected packet type 0x${expected.toString(16).padStart(4, "0")}, got 0x${packet.type.toString(16).padStart(4, "0")}`,
      ),
    };
  }
  return null;
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
// Welcome / Lock / Init capability cycles
// =============================================================================

// WELCOME: 0x8000 from printer → host sends LOCK → LOCKING
// Replaces the T21 placeholder.
awaitAck(g, "WELCOME", 0x8000, "LOCKING", buildLockPacket());

// LOCKING: 0xa100 lock-ack (payload[0] === 0x06) → send FS Y → INIT1_FS_Y
awaitAck(
  g,
  "LOCKING",
  0xa100,
  "INIT1_FS_Y",
  buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE),
  0x06,
);

// INIT1_FS_Y: 0xa000 FS-Y-ack (1-byte 0x06) → send INFO META command → INIT1_INFO_META
awaitAck(
  g,
  "INIT1_FS_Y",
  0xa000,
  "INIT1_INFO_META",
  buildPassthruPacket(buildEsci2Command("INFO"), ESCI2_REPLY_SIZE),
  0x06,
);

// INIT1_FIN: 0xa000 FIN-ack → send FS Z → INIT2_FS_Z
// (No ack-byte check here — FIN reply is a 64-byte envelope, not a 1-byte ACK.)
awaitAck(g, "INIT1_FIN", 0xa000, "INIT2_FS_Z", buildPassthruPacket(buildFsZ(), LEGACY_REPLY_SIZE));

// INIT2_FS_Z: 0xa000 FS-Z-ack (1-byte 0x06) → send INFO META command → INIT2_INFO_META
awaitAck(
  g,
  "INIT2_FS_Z",
  0xa000,
  "INIT2_INFO_META",
  buildPassthruPacket(buildEsci2Command("INFO"), ESCI2_REPLY_SIZE),
  0x06,
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
// twoPhaseRead helper + INIT1/INIT2 capability reads (INFO / CAPA / RESA) +
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
    decision<Esci2Ctx>((ctx, packet) => {
      const typeGuard = expectIsType(packet, 0xa000, `${prefix}_META`);
      if (typeGuard) return typeGuard;
      const header = parseEsci2ReplyHeader(packet.payload);
      if (header === null || header.cmd !== expectedCmd) {
        return {
          error: new Error(
            `${prefix}_META: bad reply header (expected cmd=${expectedCmd}, got ${header?.cmd ?? "(unparseable)"})`,
          ),
        };
      }
      // Store on ctx (not closure) so concurrent sessions sharing the
      // singleton graph don't overwrite each other's expected length.
      ctx.tprDeclaredLength = header.length;
      return {
        next: `${prefix}_DATA`,
        send: buildPurereadPacket(header.length),
      };
    }),
  );

  g.state(
    `${prefix}_DATA`,
    decision<Esci2Ctx>((ctx, packet) => {
      const typeGuard = expectIsType(packet, 0xa000, `${prefix}_DATA`);
      if (typeGuard) return typeGuard;
      if (packet.payload.length !== ctx.tprDeclaredLength) {
        return {
          error: new Error(
            `${prefix}_DATA: expected ${ctx.tprDeclaredLength} bytes, got ${packet.payload.length}`,
          ),
        };
      }
      return { next, send: nextSend };
    }),
  );
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
// statThenDrain helper + INIT_POLL cycle (3 iterations of FS Y → STAT → drain → FIN)
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
      const typeGuard = expectIsType(packet, 0xa000, `${prefix}_STAT`);
      if (typeGuard) return typeGuard;
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

// =============================================================================
// FIN_AFTER_IMG decision (flatbed skips POSTSCAN) + POSTSCAN drain cycles ×2
// =============================================================================

// FIN_AFTER_IMG: decision on receipt of FIN reply after last image chunk.
// - Flatbed: skip POSTSCAN drain entirely — go straight to UNLOCKING (whose
//   onEnter sends the unlock packet). Verified by the 2026-04-24 flatbed Frida
//   fixture (last 5 sends: @IMG | @IMG | @FIN | UNLOCK — no POSTSCAN in between).
// - ADF: start POSTSCAN drain cycle 1 by sending FS Y.
g.state(
  "FIN_AFTER_IMG",
  decision<Esci2Ctx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, 0xa000, "FIN_AFTER_IMG");
    if (typeGuard) return typeGuard;
    if (ctx.source === "flatbed") {
      // No POSTSCAN drain — UNLOCKING's onEnter sends the unlock packet.
      return { next: "UNLOCKING" };
    }
    // ADF: start POSTSCAN drain cycle 1.
    return {
      next: "POSTSCAN_FS_Y_1",
      send: buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE),
    };
  }),
);

// POSTSCAN_FS_Y_1: receives FS Y ACK (0xa000, payload[0]=0x06); sends STAT.
g.state("POSTSCAN_FS_Y_1", {
  on: {
    0xa000: {
      validate: (payload) => payload[0] === 0x06,
      next: "POSTSCAN_1_STAT",
      send: buildPassthruPacket(buildEsci2Command("STAT"), ESCI2_REPLY_SIZE),
    },
  },
});

// POSTSCAN cycle 1: POSTSCAN_1_STAT → POSTSCAN_1_STAT_DRAIN? → POSTSCAN_1_FIN → POSTSCAN_FS_Y_2
// POSTSCAN_1_FIN sends FS Y to start cycle 2.
statThenDrain(
  g,
  "POSTSCAN_1",
  "POSTSCAN_FS_Y_2",
  buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE),
);

// POSTSCAN_FS_Y_2: receives FS Y ACK (0xa000, payload[0]=0x06); sends STAT.
g.state("POSTSCAN_FS_Y_2", {
  on: {
    0xa000: {
      validate: (payload) => payload[0] === 0x06,
      next: "POSTSCAN_2_STAT",
      send: buildPassthruPacket(buildEsci2Command("STAT"), ESCI2_REPLY_SIZE),
    },
  },
});

// POSTSCAN cycle 2: POSTSCAN_2_STAT → POSTSCAN_2_STAT_DRAIN? → POSTSCAN_2_FIN → UNLOCKING
// POSTSCAN_2_FIN has no further send — UNLOCKING's onEnter sends the unlock packet.
statThenDrain(g, "POSTSCAN_2", "UNLOCKING");

// =============================================================================
// UNLOCKING state — onEnter sends unlock packet, awaits 0xa101 ack → DONE
// =============================================================================

// UNLOCKING: static state that sends the unlock packet on entry and awaits 0xa101 ack.
// The onEnter hook sends the packet to preserve wire order: unlock → 0xa101 ack → DONE.
// If the send were on the transition leading INTO UNLOCKING (e.g., on FIN_AFTER_IMG or
// POSTSCAN_2_FIN), the packet would be sent BEFORE the state entered, which would appear
// on the wire AFTER the incoming state's 0xa000 ack — reversing the order vs. the fixture.
g.state("UNLOCKING", {
  onEnter: () => buildUnlockPacket(),
  on: { 0xa101: { next: "DONE" } },
});

// ---------------------------------------------------------------------------
// INIT_POLL cycle — 3 iterations of FS Y → STAT → (optional drain) → FIN
// ---------------------------------------------------------------------------
//
// Inlined rather than using statThenDrain because INIT_POLL_FIN is a decision
// state that does the loop-back check on the same 0xa000 packet that completes
// the FIN exchange, rather than a plain static transition.

// INIT_POLL_FS_Y: receives 0xa000 (FS Y ACK, payload[0]=0x06); sends STAT.
g.state("INIT_POLL_FS_Y", {
  on: {
    0xa000: {
      validate: (payload) => payload[0] === 0x06,
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
    const typeGuard = expectIsType(packet, 0xa000, "INIT_POLL_STAT");
    if (typeGuard) return typeGuard;
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
  decision<Esci2Ctx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, 0xa000, "INIT_POLL_FIN");
    if (typeGuard) return typeGuard;
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
// MODE_SWITCH / POST_MODE_STAT / PARA / TRDT / IMG_META states
// =============================================================================

// Builds the PARA header + body send pair, resolving source + duplex from ctx.
// Called once per dispatch in POST_MODE_STAT and POST_MODE_STAT_DRAIN — each
// site is now a decision so the result is computed once and embedded as a
// concrete Buffer[] in the returned TransitionResult.send.
function buildParaSend(ctx: Esci2Ctx): Buffer[] {
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
  decision<Esci2Ctx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, 0xa000, "POST_MODE_STAT");
    if (typeGuard) return typeGuard;
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
    return { next: "PARA", send: buildParaSend(ctx) };
  }),
);

// POST_MODE_STAT_DRAIN: drains queued status bytes, then sends PARA header + body → PARA.
// Decision (rather than static) so buildParaSend resolves once per dispatch.
g.state(
  "POST_MODE_STAT_DRAIN",
  decision<Esci2Ctx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, 0xa000, "POST_MODE_STAT_DRAIN");
    if (typeGuard) return typeGuard;
    return { next: "PARA", send: buildParaSend(ctx) };
  }),
);

// PARA: validates printer's acceptance of parameters — header must parse,
// cmd must be "PARA", and the body must contain #parOK. The bare token
// check would otherwise accept a malformed reply that happened to contain
// "#parOK" at the right offset.
g.state("PARA", {
  on: {
    0xa000: {
      validate: (payload) => {
        const header = parseEsci2ReplyHeader(payload);
        if (header === null || header.cmd !== "PARA") return false;
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
// - Zero-length chunk with page-end: dispatches page-end without going through IMG_DATA.
// - Zero-length chunk with no page-end: zero-retry path (up to MAX_ZERO_IMG_RETRIES).
// - Non-zero chunk size: resets zeroImgRetries, sends pure-read, advances to IMG_DATA.
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
    const typeGuard = expectIsType(packet, 0xa000, "IMG_META");
    if (typeGuard) return typeGuard;
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

    // Zero-length chunk with page-end token: dispatch page-end without entering IMG_DATA.
    if (ctx.imgChunkSize === 0 && ctx.pageEndKind !== "none") {
      const accumulated = ctx.imageChunks;
      ctx.imageChunks = [];
      if (ctx.pageEndKind === "last") {
        if (accumulated.length > 0) {
          return {
            next: "FIN_AFTER_IMG",
            send: buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
            flushPage: {
              side: ctx.pageSide,
              encode: () => Promise.resolve(Buffer.concat(accumulated)),
            },
          };
        }
        return {
          next: "FIN_AFTER_IMG",
          send: buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
        };
      }
      // pageEndKind === "more"
      if (accumulated.length > 0) {
        return {
          next: "IMG_META",
          send: buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE),
          flushPage: {
            side: ctx.pageSide,
            encode: () => Promise.resolve(Buffer.concat(accumulated)),
          },
        };
      }
      return {
        next: "IMG_META",
        send: buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE),
      };
    }

    // Zero-length chunk with no page-end: printer has nothing yet, retry.
    if (ctx.imgChunkSize === 0) {
      if (ctx.zeroImgRetries >= MAX_ZERO_IMG_RETRIES) {
        return {
          error: new Error(`IMG_META: max ${MAX_ZERO_IMG_RETRIES} zero-length retries exceeded`),
        };
      }
      ctx.zeroImgRetries += 1;
      return {
        next: "IMG_META",
        send: buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE),
      };
    }

    // Non-zero chunk size — advance to IMG_DATA.
    ctx.zeroImgRetries = 0;
    return {
      next: "IMG_DATA",
      send: buildPurereadPacket(ctx.imgChunkSize),
    };
  }),
);

// IMG_DATA: decision on received image chunk.
// - Validates chunk length against ctx.imgChunkSize.
// - Accumulates chunk into ctx.imageChunks.
// - pageEndKind=none: request next chunk metadata (loop).
// - pageEndKind=more: flush page (flushPage barrier), request next page's metadata.
// - pageEndKind=last: flush page (flushPage barrier), send FIN, advance to FIN_AFTER_IMG.
//
// Barrier ordering (spec §3.5): engine stages next+send, pauses, awaits encode(),
// writes to temp dir, unpauses, then delivers the staged send to the wire.
// Wire order: lastImgChunk-received → FIN-sent. The encode+write happen between
// but produce no wire bytes, preserving replay test byte-equivalence.
g.state(
  "IMG_DATA",
  decision<Esci2Ctx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, 0xa000, "IMG_DATA");
    if (typeGuard) return typeGuard;
    if (packet.payload.length !== ctx.imgChunkSize) {
      return {
        error: new Error(
          `IMG_DATA: expected ${ctx.imgChunkSize} bytes, got ${packet.payload.length}`,
        ),
      };
    }

    // Push the payload reference directly. The engine's recv pump materialises
    // each IS packet into a fresh subarray (scan-session.ts:tryParseHead), so
    // the underlying ArrayBuffer is not reused across packets — no copy needed.
    ctx.imageChunks.push(packet.payload);

    if (ctx.pageEndKind === "none") {
      // Mid-stream — request the next chunk's metadata.
      return {
        next: "IMG_META",
        send: buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE),
      };
    }

    // Page boundary — assemble the page bytes and use the engine's flushPage barrier.
    const accumulated = ctx.imageChunks;
    ctx.imageChunks = []; // reset for next page

    if (ctx.pageEndKind === "last") {
      // Terminal — send FIN, advance to FIN_AFTER_IMG.
      return {
        next: "FIN_AFTER_IMG",
        send: buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
        flushPage: {
          side: ctx.pageSide,
          encode: () => Promise.resolve(Buffer.concat(accumulated)),
        },
      };
    }

    // pageEndKind === "more" — flush this page, request the next page's metadata.
    return {
      next: "IMG_META",
      send: buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE),
      flushPage: {
        side: ctx.pageSide,
        encode: () => Promise.resolve(Buffer.concat(accumulated)),
      },
    };
  }),
);

// =============================================================================
// Cleanup-state declaration — engine post-scan-save fallback (v0.3.0 §3.3)
// =============================================================================
//
// Once the last page has been flushed, the remaining states are panel
// hygiene: ADF drain handshake (POSTSCAN_*), final ack handshake
// (FIN_AFTER_IMG), and the LOCK release (UNLOCKING). Failures here —
// printer dropping the connection, async fatal during drain, an
// unexpected reply byte on the unlock ack — should not discard scans
// already sitting in the temp dir. The engine consults this set at
// settle time and only recovers when current state is one of these.
g.cleanupStates([
  "FIN_AFTER_IMG",
  "POSTSCAN_FS_Y_1",
  "POSTSCAN_1_STAT",
  "POSTSCAN_1_STAT_DRAIN",
  "POSTSCAN_1_FIN",
  "POSTSCAN_FS_Y_2",
  "POSTSCAN_2_STAT",
  "POSTSCAN_2_STAT_DRAIN",
  "POSTSCAN_2_FIN",
  "UNLOCKING",
]);

// =============================================================================
// Export the built graph
// =============================================================================

export const esci2Graph: Graph<Esci2Ctx> = g.build();
