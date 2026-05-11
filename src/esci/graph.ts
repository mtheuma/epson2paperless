// src/esci/graph.ts
//
// ESC/I (legacy WF-3620) scan-session graph. Built atop the protocol-blind
// engine in src/scan-session.ts. Mirrors the wire sequence captured from
// real-hardware Wireshark pcaps; replay tests in src/esci/scanner.test.ts
// pin every byte we emit. Structurally parallels src/esci2/graph.ts.

import {
  createGraph,
  decision,
  type Graph,
  type GraphBuilder,
  type PageFlush,
  type SendSpec,
  type TransitionResult,
} from "../scan-session.js";
import {
  buildLockPacket,
  buildUnlockPacket,
  buildPassthruPacket,
  buildIsPacket,
} from "../protocol.js";
import {
  buildEscInit,
  buildFsI,
  buildFsF,
  buildEscE,
  buildEscParen,
  buildEscZ,
  buildFsW,
  buildFsG,
  buildEscCleanup,
  buildPageEject,
  buildFsWBlock,
  buildStreamConfigPayload,
  parseFsGReply,
  geometry,
  legacyDetectSource,
  SOURCE_BYTE,
  type Source,
  type Format,
  type ScanGeometry,
} from "./commands.js";
// FS Y is the ET-4950 ESC/I-2 init's first command, now lifted to the
// shared `commands-fs.ts` module. Used here only for the DIAGNOSE_PROTOCOL
// probe — sent after ESC @ NAKs to classify printers stuck between ESC/I
// and ESC/I-2.
import { buildFsY } from "../commands-fs.js";
import { expectIsType, expectLength } from "../graph-helpers.js";
import { GAMMA_LUT_R, GAMMA_LUT_G, GAMMA_LUT_B } from "./luts.js";
import { encodeRawGbrToJpeg } from "./raw-to-jpeg.js";
import { createLogger } from "../logger.js";

const log = createLogger("scanner-esci");

/**
 * Per-session mutable state threaded through every transition. The engine
 * owns sessionTempDir / pageIndex / backPageIndices bookkeeping; everything
 * here is ESC/I-protocol-specific.
 */
export interface EsciCtx {
  duplex: boolean;
  forcedSource: Source | null;
  /** Set in STATUS_2 from the FS F byte (or ctx.forcedSource). */
  source: Source;
  format: Format;
  jpegQuality: number;
  /** When true, a non-ACK reply to ESC @ triggers an FS Y diagnostic probe. */
  diagnoseProtocol: boolean;
  /**
   * True once STATUS_2 has actually run and assigned `ctx.source` (either
   * from the FS F status byte via `legacyDetectSource` or from
   * `ctx.forcedSource`). The shell uses this flag — not just the presence
   * of `ctx.source` — to decide whether to fire `LegacyScanSession.onSourceDetected`,
   * because `source` is initialized to `forcedSource ?? "adf-simplex"` in
   * the scanner shell before any state has run, so a session that fails
   * inside WELCOME / LOCKING / INIT could otherwise produce a spurious
   * detection callback on the failure path.
   */
  sourceDetected: boolean;
  /** True when looping back for the back side of a duplex sheet (or next ADF page). */
  inInterPageLoop: boolean;
  /** Page count, 1-indexed during dispatch (incremented just before flush). */
  pageCount: number;
  /** Gamma channel iterator (R/G/B). */
  gammaChannelIdx: number;
  /**
   * Per-page pixel buffer + write offset. Allocated in START once FS G has
   * confirmed the scan geometry; reset to a length-0 buffer between pages so
   * `imageBufferOffset < imageBuffer.length` is the page-complete check.
   */
  imageBuffer: Buffer;
  imageBufferOffset: number;
  /** Cached scan geometry (set in START alongside the imageBuffer allocation). */
  geom: ScanGeometry | null;
  /**
   * Trailing IS-0xa200 chunks stashed during the encode window; drained
   * on next IMG_RECEIVING entry. See PAGE_ENCODING_DRAIN. Issue #71.
   */
  deferredImageChunks: Buffer[];
}

export const ESCI_TIMEOUT_MS = 60_000;

// IS-0xa000 carries every ESC/I passthru-reply (ACKs, identity, status).
// IS-0x8000 = welcome; IS-0xa100 = lock-ack; IS-0xa101 = unlock-ack;
// IS-0xa200 = unsolicited image chunks.
export const ESCI_REPLY = 0xa000;
const ACK_BYTE = 0x06;
// Driver always probes with 0x01 (ADF-simplex) regardless of intended source —
// matches the Windows driver and ensures the 0x81 busy cycle fires on flatbed.
const PROBE_SOURCE_BYTE = 0x01;

const GAMMA_CHANNELS = [
  { tag: 0x52, lut: GAMMA_LUT_R },
  { tag: 0x47, lut: GAMMA_LUT_G },
  { tag: 0x42, lut: GAMMA_LUT_B },
] as const;

// =============================================================================
// Helpers
// =============================================================================

function isAck(payload: Buffer): boolean {
  return payload.length === 1 && payload[0] === ACK_BYTE;
}

function passthru(cmd: Buffer, replySize: number): Buffer {
  return buildPassthruPacket(cmd, replySize);
}

const sendEscZ = (): Buffer => passthru(buildEscZ(), 1);
const sendFsF = (): Buffer => passthru(buildFsF(), 16);
const sendFsI = (): Buffer => passthru(buildFsI(), 80);
const sendEscCleanup = (): Buffer => passthru(buildEscCleanup(), 1);

/** ESC e + 1-byte source param, sent as two back-to-back passthrus. */
function sendEscEPlusByte(byte: number): SendSpec<EsciCtx>[] {
  return [passthru(buildEscE(), 1), passthru(Buffer.from([byte]), 1)];
}

/** ESC e + ctx-resolved source byte. Used in reset / cleanup paths. */
const sendEscEPlusCtxSource: SendSpec<EsciCtx>[] = [
  passthru(buildEscE(), 1),
  (ctx: EsciCtx) => passthru(Buffer.from([SOURCE_BYTE[ctx.source]]), 1),
];

/**
 * awaitReply — registers a static state that waits for `expectedReplyType`,
 * runs `validate` against the payload, then advances to `next` (optionally
 * emitting `send`). Same shape as the per-graph helper in
 * `src/esci2/graph.ts`; intentionally not lifted to a shared module —
 * each graph parameterises it with its own `Ctx`, and the cost of two
 * copies is smaller than the cost of a generic shared abstraction. The
 * ESC/I path additionally needs custom validators (length-based replies
 * of 1 / 14 / 16 / 80 bytes, not just single-byte ACKs), which the
 * shape predicates in `src/graph-helpers.ts` like `ackByte` cover for
 * the simple cases.
 */
function awaitReply(
  g: GraphBuilder<EsciCtx>,
  name: string,
  expectedReplyType: number,
  validate: (payload: Buffer) => boolean,
  next: string,
  send?: SendSpec<EsciCtx> | SendSpec<EsciCtx>[],
): void {
  g.state(name, {
    on: {
      [expectedReplyType]: {
        validate,
        next,
        ...(send !== undefined ? { send } : {}),
      },
    },
  });
}

/**
 * escEThenAck — collapses the "ESC e + param then 2 ACKs" pattern that
 * recurs five times in the ESC/I init flow. The caller's upstream
 * transition emits both the ESC e opcode and the source-byte param via
 * `send: SendSpec[]`; this helper just registers the two ACK-wait states.
 * After ACK2, control flows to `next` — and the helper emits `nextSend`
 * (typically the FS F or ESC z that the destination state expects to
 * receive a reply for).
 */
function escEThenAck(
  g: GraphBuilder<EsciCtx>,
  prefix: string,
  next: string,
  nextSend?: SendSpec<EsciCtx> | SendSpec<EsciCtx>[],
): void {
  awaitReply(g, `${prefix}_ACK1`, ESCI_REPLY, isAck, `${prefix}_ACK2`);
  awaitReply(g, `${prefix}_ACK2`, ESCI_REPLY, isAck, next, nextSend);
}

/** Strip the leading status byte from an IS-0xa200 chunk and copy pixel tail. */
export function appendImageChunk(payload: Buffer, dest: Buffer, offset: number): number {
  if (payload.length === 0) return offset;
  payload.subarray(1).copy(dest, offset);
  return offset + payload.length - 1;
}

const length1 = (p: Buffer): boolean => p.length === 1;
const length16 = (p: Buffer): boolean => p.length === 16;
const length80 = (p: Buffer): boolean => p.length === 80;

// =============================================================================
// Graph builder
// =============================================================================

const g = createGraph<EsciCtx>("WELCOME", ESCI_TIMEOUT_MS);

// =============================================================================
// WELCOME / LOCKING / INIT (+ DIAGNOSE_INIT_PROBE)
// =============================================================================

// WELCOME: 0x8000 from printer → host sends LOCK → LOCKING.
awaitReply(g, "WELCOME", 0x8000, () => true, "LOCKING", buildLockPacket());

// LOCKING: 0xa100 lock-ack → send ESC @ → INIT.
awaitReply(g, "LOCKING", 0xa100, () => true, "INIT", passthru(buildEscInit(), 1));

// INIT: ESC @ ack-or-NAK. ACK → IDENTITY (FS I); NAK + diagnoseProtocol →
// DIAGNOSE_INIT_PROBE (FS Y); NAK + !diagnose → fail with the canonical
// "expected ESC @ ack, got type=0x{type} payload={hex}" message.
g.state(
  "INIT",
  decision<EsciCtx>((ctx, packet) => {
    if (packet.type === ESCI_REPLY && isAck(packet.payload)) {
      return { next: "IDENTITY", send: sendFsI() };
    }
    const detail = `type=0x${packet.type.toString(16)} payload=${packet.payload.toString("hex")}`;
    if (ctx.diagnoseProtocol) {
      // Compatibility-report breadcrumb. README + config.ts both promise this
      // [diagnose] line; the terminal error in DIAGNOSE_INIT_PROBE asks the
      // user to share these lines on the GitHub issue.
      log.info(
        `[diagnose] ESC @ returned non-ACK (${detail}) — sending FS Y probe to classify protocol`,
      );
      return { next: "DIAGNOSE_INIT_PROBE", send: passthru(buildFsY(), 1) };
    }
    return { error: new Error(`expected ESC @ ack, got ${detail}`) };
  }),
);

// DIAGNOSE_INIT_PROBE: terminal diagnostic state. Log the FS Y outcome with
// enough detail for a compatibility-issue triage, then fail with the
// "diagnostic probe complete" message the test pins.
g.state(
  "DIAGNOSE_INIT_PROBE",
  decision<EsciCtx>((_ctx, packet) => {
    const detail = `type=0x${packet.type.toString(16)} payload=${packet.payload.toString("hex")}`;
    if (packet.type === ESCI_REPLY && isAck(packet.payload)) {
      log.info(
        `[diagnose] FS Y returned ACK (${detail}) — printer likely speaks ESC/I-2 over plain TCP (ET-4950-style init, no TLS).`,
      );
    } else {
      log.info(
        `[diagnose] FS Y returned non-ACK (${detail}) — printer rejects both legacy ESC @ and ESC/I-2 FS Y; protocol family unknown.`,
      );
    }
    return {
      error: new Error(
        "diagnostic probe complete — please share the [diagnose] log lines on the GitHub issue",
      ),
    };
  }),
);

// =============================================================================
// IDENTITY → STATUS_1A → STATUS_1B → SOURCE probe → STATUS_2 (decision)
// =============================================================================

// IDENTITY: 80-byte identity payload (we don't decode it) → STATUS_1A, send FS F.
awaitReply(g, "IDENTITY", ESCI_REPLY, length80, "STATUS_1A", sendFsF());

// STATUS_1A: first FS F status reply. In the inter-page loop, byte 0 = 0x81
// (ADF empty) jumps straight to cleanup; 0x01 means more paper. On initial
// setup, always proceed to STATUS_1B.
g.state(
  "STATUS_1A",
  decision<EsciCtx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "STATUS_1A");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 16, "STATUS_1A", "status");
    if (lengthGuard) return lengthGuard;
    if (ctx.inInterPageLoop && packet.payload[0] === 0x81) {
      ctx.inInterPageLoop = false;
      return { next: "CLEANUP_1", send: sendEscCleanup() };
    }
    return { next: "STATUS_1B", send: sendFsF() };
  }),
);

// STATUS_1B: second FS F status reply. Initial setup → ESC e + probe param;
// inter-page loop (duplex back side) → ADF_IDENTITY_A.
g.state(
  "STATUS_1B",
  decision<EsciCtx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "STATUS_1B");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 16, "STATUS_1B", "status");
    if (lengthGuard) return lengthGuard;
    if (ctx.inInterPageLoop) {
      return { next: "ADF_IDENTITY_A", send: sendFsI() };
    }
    return { next: "SOURCE_ACK1", send: sendEscEPlusByte(PROBE_SOURCE_BYTE) };
  }),
);

// SOURCE_ACK1/ACK2 → STATUS_2 (with FS F to populate the status reply).
escEThenAck(g, "SOURCE", "STATUS_2", sendFsF());

// STATUS_2: decision on the FS F reply.
//   - 0x81 → busy / flatbed → reset cycle (RESET_PAREN, send ESC ()
//   - 0x01 → ADF (duplex/simplex per ctx) → pre-reset probe (ADF_PRESRC, send ESC e + 0x01)
//   - other → unrecognised, fail with the compatibility-issue message
//   - forcedSource shortcuts the byte-0 detection but the rest of the
//     branch logic still depends on whether the wire byte is 0x81 (busy).
g.state(
  "STATUS_2",
  decision<EsciCtx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "STATUS_2");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 16, "STATUS_2", "status");
    if (lengthGuard) return lengthGuard;
    const statusByte = packet.payload[0];
    if (ctx.forcedSource) {
      ctx.source = ctx.forcedSource;
    } else {
      const result = legacyDetectSource(statusByte, ctx.duplex);
      if (!result.ok) {
        return {
          error: new Error(
            `Unrecognised FS F status 0x${result.byte.toString(16).padStart(2, "0")} ` +
              `— please file a compatibility issue with LOG_LEVEL=debug output ` +
              `(see CONTRIBUTING.md). Workaround: set ESCI_FORCE_SOURCE.`,
          ),
        };
      }
      ctx.source = result.source;
    }
    ctx.sourceDetected = true;

    if (statusByte === 0x81) {
      return { next: "RESET_PAREN", send: passthru(buildEscParen(), 1) };
    }
    if (ctx.source !== "flatbed") {
      return { next: "ADF_PRESRC_ACK1", send: sendEscEPlusByte(PROBE_SOURCE_BYTE) };
    }
    // Flatbed reached without busy cycle (rare — most flatbeds reach 0x81 first).
    return { next: "GAMMA_CMD", send: sendEscZ() };
  }),
);

// =============================================================================
// ADF pre-reset cycle
// =============================================================================

// ADF_PRESRC_ACK1/ACK2 → ADF_STATUS_3 (with FS F).
escEThenAck(g, "ADF_PRESRC", "ADF_STATUS_3", sendFsF());

// ADF_STATUS_3: third FS F status check (ADF only); flows into the reset cycle.
awaitReply(g, "ADF_STATUS_3", ESCI_REPLY, length16, "RESET_PAREN", passthru(buildEscParen(), 1));

// =============================================================================
// Reset cycle: ESC ( → ESC @ → ESC e + source → FS F → STATUS_READY
// =============================================================================

// RESET_PAREN: 1-byte ESC ( reply (0x06 or 0x80; both fine) → RESET_INIT, send ESC @.
awaitReply(g, "RESET_PAREN", ESCI_REPLY, length1, "RESET_INIT", passthru(buildEscInit(), 1));

// RESET_INIT: ACK for ESC @ → RESET_SRC_ACK1, send ESC e + ctx.source byte.
awaitReply(g, "RESET_INIT", ESCI_REPLY, isAck, "RESET_SRC_ACK1", sendEscEPlusCtxSource);

// RESET_SRC_ACK1/ACK2 → STATUS_READY (with FS F).
escEThenAck(g, "RESET_SRC", "STATUS_READY", sendFsF());

// STATUS_READY: 16-byte FS F reply. ADF sources read identity twice; flatbed
// jumps straight to the gamma phase.
g.state(
  "STATUS_READY",
  decision<EsciCtx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "STATUS_READY");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 16, "STATUS_READY", "status");
    if (lengthGuard) return lengthGuard;
    if (ctx.source !== "flatbed") {
      return { next: "ADF_IDENTITY_A", send: sendFsI() };
    }
    return { next: "GAMMA_CMD", send: sendEscZ() };
  }),
);

// =============================================================================
// ADF post-reset identity reads + ADF+PDF extra source-set
// =============================================================================

// ADF_IDENTITY_A: 80-byte identity → ADF_IDENTITY_B, send FS I.
awaitReply(g, "ADF_IDENTITY_A", ESCI_REPLY, length80, "ADF_IDENTITY_B", sendFsI());

// ADF_IDENTITY_B: 80-byte identity. JPEG initial / inter-page loop → GAMMA_CMD;
// PDF initial → extra ESC e + ctx.source byte before gamma.
g.state(
  "ADF_IDENTITY_B",
  decision<EsciCtx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "ADF_IDENTITY_B");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 80, "ADF_IDENTITY_B", "identity");
    if (lengthGuard) return lengthGuard;
    if (ctx.format === "pdf" && !ctx.inInterPageLoop) {
      return { next: "ADF_PDF_SRC_ACK1", send: sendEscEPlusCtxSource };
    }
    ctx.inInterPageLoop = false;
    return { next: "GAMMA_CMD", send: sendEscZ() };
  }),
);

// ADF_PDF_SRC_ACK1/ACK2 → GAMMA_CMD (with ESC z).
escEThenAck(g, "ADF_PDF_SRC", "GAMMA_CMD", sendEscZ());

// =============================================================================
// Gamma phase — three identical ESC z + LUT cycles for R/G/B (driven via
// ctx.gammaChannelIdx, so two states represent all six wire exchanges).
// =============================================================================

// GAMMA_CMD: ACK for ESC z → GAMMA_DATA, send tag + LUT for current channel.
g.state("GAMMA_CMD", {
  on: {
    [ESCI_REPLY]: {
      validate: isAck,
      next: "GAMMA_DATA",
      send: (ctx: EsciCtx) => {
        const ch = GAMMA_CHANNELS[ctx.gammaChannelIdx];
        return passthru(Buffer.concat([Buffer.from([ch.tag]), ch.lut]), 1);
      },
    },
  },
});

// GAMMA_DATA: ACK for the LUT body. Advance channel; loop or proceed to WINDOW.
g.state(
  "GAMMA_DATA",
  decision<EsciCtx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "GAMMA_DATA");
    if (typeGuard) return typeGuard;
    if (!isAck(packet.payload)) {
      return {
        error: new Error(`GAMMA_DATA: expected gamma LUT ack (channel ${ctx.gammaChannelIdx})`),
      };
    }
    if (ctx.gammaChannelIdx + 1 < GAMMA_CHANNELS.length) {
      ctx.gammaChannelIdx += 1;
      return { next: "GAMMA_CMD", send: sendEscZ() };
    }
    ctx.gammaChannelIdx = 0;
    return { next: "WINDOW_CMD", send: passthru(buildFsW(), 1) };
  }),
);

// =============================================================================
// Window + Stream-Config + START
// =============================================================================

// WINDOW_CMD: ACK for FS W → WINDOW_DATA, send 64-byte FS W block.
g.state("WINDOW_CMD", {
  on: {
    [ESCI_REPLY]: {
      validate: isAck,
      next: "WINDOW_DATA",
      send: (ctx: EsciCtx) =>
        passthru(buildFsWBlock({ source: ctx.source, format: ctx.format }), 1),
    },
  },
});

// WINDOW_DATA: ACK for the FS W block → STATUS_PRESCAN, send FS F.
awaitReply(g, "WINDOW_DATA", ESCI_REPLY, isAck, "STATUS_PRESCAN", sendFsF());

// STATUS_PRESCAN: 16-byte FS F → START, send FS G.
awaitReply(g, "STATUS_PRESCAN", ESCI_REPLY, length16, "START", passthru(buildFsG(), 14));

// START: decision on FS G's 14-byte reply. chunkSize=0 → poll FS F until
// ready. Otherwise allocate the per-page buffer, send the IS-0x2200 stream-
// config payload (no reply), and enter IMG_RECEIVING.
g.state(
  "START",
  decision<EsciCtx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "START");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 14, "START", "FS G reply");
    if (lengthGuard) return lengthGuard;
    const reply = parseFsGReply(packet.payload);
    if (reply.chunkSize === 0) {
      return { next: "START_POLL", send: sendFsF() };
    }
    const geom = geometry({ source: ctx.source, format: ctx.format });
    ctx.geom = geom;
    ctx.imageBuffer = Buffer.alloc(geom.widthPx * geom.heightPx * 3);
    ctx.imageBufferOffset = 0;
    return {
      next: "IMG_RECEIVING",
      send: buildIsPacket(0x2200, buildStreamConfigPayload(reply, ctx.format)),
    };
  }),
);

// START_POLL: keep polling FS F until status byte 0 = 0x01 (ready); then one
// confirmation FS F via START_POLL_READY before re-issuing FS G.
g.state(
  "START_POLL",
  decision<EsciCtx>((_ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "START_POLL");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 16, "START_POLL", "status");
    if (lengthGuard) return lengthGuard;
    if (packet.payload[0] === 0x01) {
      return { next: "START_POLL_READY", send: sendFsF() };
    }
    return { next: "START_POLL", send: sendFsF() };
  }),
);

// START_POLL_READY: final 16-byte FS F → re-send FS G, return to START.
awaitReply(g, "START_POLL_READY", ESCI_REPLY, length16, "START", passthru(buildFsG(), 14));

// =============================================================================
// IMG_RECEIVING — accumulates pixel chunks into ctx.imageBuffer; on the
// page-boundary chunk dispatches the flushPage barrier and routes to
// PAGE_EJECT_WAIT (ADF) or POST_STATUS (flatbed).
// =============================================================================

/**
 * Page-complete transition out of IMG_RECEIVING: snapshot geometry/buffer
 * for async encode, reset per-page ctx fields, route to
 * PAGE_ENCODING_DRAIN (ADF) or POST_STATUS (flatbed). Factored out so the
 * deferred-chunk overflow branch can reuse the same construction.
 */
function makeFlushTransition(ctx: EsciCtx): TransitionResult<EsciCtx> {
  ctx.pageCount += 1;
  const isBack = ctx.source === "adf-duplex" && ctx.pageCount % 2 === 0;
  if (!ctx.geom) {
    return { error: new Error("IMG_RECEIVING: page complete with no cached geometry") };
  }
  const { widthPx, heightPx } = ctx.geom;
  const rawRgb = ctx.imageBuffer;
  const quality = ctx.jpegQuality;
  ctx.imageBuffer = Buffer.alloc(0);
  ctx.imageBufferOffset = 0;
  const flush: PageFlush = {
    side: isBack ? "back" : "front",
    encode: () => encodeRawGbrToJpeg(rawRgb, widthPx, heightPx, quality),
  };
  if (ctx.source === "flatbed") {
    return { next: "POST_STATUS", send: sendFsF(), flushPage: flush };
  }
  return {
    next: "PAGE_ENCODING_DRAIN",
    send: passthru(buildPageEject(), 1),
    flushPage: flush,
  };
}

/**
 * Drain ctx.deferredImageChunks into the current page buffer (#71).
 * Returns "overflowed" when the deferred chunks alone fill the page —
 * remaining deferred entries plus `incoming` get re-stashed for the
 * next page, and the caller should emit a flush transition.
 */
function drainDeferredIntoBuffer(ctx: EsciCtx, incoming: Buffer): "drained" | "overflowed" {
  if (ctx.deferredImageChunks.length === 0) return "drained";
  const chunks = ctx.deferredImageChunks;
  ctx.deferredImageChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    ctx.imageBufferOffset = appendImageChunk(chunks[i], ctx.imageBuffer, ctx.imageBufferOffset);
    if (ctx.imageBufferOffset >= ctx.imageBuffer.length) {
      for (let j = i + 1; j < chunks.length; j++) {
        ctx.deferredImageChunks.push(chunks[j]);
      }
      ctx.deferredImageChunks.push(incoming);
      return "overflowed";
    }
  }
  return "drained";
}

g.state(
  "IMG_RECEIVING",
  decision<EsciCtx>((ctx, packet) => {
    if (packet.type !== 0xa200) {
      return {
        error: new Error(
          `IMG_RECEIVING: expected IS-0xa200 image chunk, got 0x${packet.type.toString(16).padStart(4, "0")}`,
        ),
      };
    }
    if (drainDeferredIntoBuffer(ctx, packet.payload) === "overflowed") {
      return makeFlushTransition(ctx);
    }
    ctx.imageBufferOffset = appendImageChunk(
      packet.payload,
      ctx.imageBuffer,
      ctx.imageBufferOffset,
    );
    if (ctx.imageBufferOffset < ctx.imageBuffer.length) {
      return { next: "IMG_RECEIVING" };
    }
    return makeFlushTransition(ctx);
  }),
);

// =============================================================================
// PAGE_ENCODING_DRAIN — ADF only; absorbs trailing IS-0xa200 image chunks
// that arrive during the flushPage encode window (the printer eagerly
// streams the next page's first bytes before we ACK the page-eject), then
// ACKs the 0x0c 0x00 eject and routes back to STATUS_1A. Issue #71 —
// without this state, trailing 0xa200 chunks landed in PAGE_EJECT_WAIT
// and tripped its 0xa000-only validator, failing the whole scan.
// =============================================================================

g.state(
  "PAGE_ENCODING_DRAIN",
  decision<EsciCtx>((ctx, packet) => {
    if (packet.type === 0xa200) {
      ctx.deferredImageChunks.push(packet.payload);
      return { next: "PAGE_ENCODING_DRAIN" };
    }
    const typeGuard = expectIsType(packet, ESCI_REPLY, "PAGE_ENCODING_DRAIN");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 1, "PAGE_ENCODING_DRAIN", "page-eject ACK");
    if (lengthGuard) return lengthGuard;
    ctx.inInterPageLoop = true;
    return { next: "STATUS_1A", send: sendFsF() };
  }),
);

// =============================================================================
// POST-IMAGE cleanup: POST_STATUS → CLEANUP_1 → (ADF: cleanup-src cycle) →
//                     CLEANUP_2 → UNLOCKING → DONE
// =============================================================================

// POST_STATUS: 16-byte FS F → CLEANUP_1, send ESC ).
awaitReply(g, "POST_STATUS", ESCI_REPLY, length16, "CLEANUP_1", sendEscCleanup());

// CLEANUP_1: 1-byte ESC ) reply (0x06 ACK or 0x80 NAK; both fine).
//   ADF → re-set source via ESC e + source byte → ADF_CLEANUP_ACK1
//   Flatbed → second ESC ) directly → CLEANUP_2
g.state(
  "CLEANUP_1",
  decision<EsciCtx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, ESCI_REPLY, "CLEANUP_1");
    if (typeGuard) return typeGuard;
    const lengthGuard = expectLength(packet.payload, 1, "CLEANUP_1", "ESC ) reply");
    if (lengthGuard) return lengthGuard;
    if (ctx.source !== "flatbed") {
      return { next: "ADF_CLEANUP_ACK1", send: sendEscEPlusCtxSource };
    }
    return { next: "CLEANUP_2", send: sendEscCleanup() };
  }),
);

// ADF_CLEANUP_ACK1/ACK2 → ADF_CLEANUP_STATUS (with FS F).
escEThenAck(g, "ADF_CLEANUP", "ADF_CLEANUP_STATUS", sendFsF());

// ADF_CLEANUP_STATUS: 16-byte FS F → CLEANUP_2, send ESC ).
awaitReply(g, "ADF_CLEANUP_STATUS", ESCI_REPLY, length16, "CLEANUP_2", sendEscCleanup());

// CLEANUP_2: 1-byte ESC ) reply → UNLOCKING. UNLOCKING's onEnter sends the
// unlock packet so the bytes land AFTER CLEANUP_2's reply, preserving wire
// order vs. fixtures (mirrors esci2/graph.ts UNLOCKING shape).
awaitReply(g, "CLEANUP_2", ESCI_REPLY, length1, "UNLOCKING");

// UNLOCKING: onEnter sends the unlock packet; awaits 0xa101 ack → DONE.
g.state("UNLOCKING", {
  onEnter: () => buildUnlockPacket(),
  on: {
    0xa101: { next: "DONE" },
  },
});

// =============================================================================
// Cleanup states — post-image-transfer panel hygiene. A failure in any of
// these recovers via the engine's post-scan-save fallback (v0.3.0 §3.3)
// provided at least one page has flushed. POST_STATUS is intentionally NOT
// in this list (treated as part of image-acquisition close — a failure
// there can signal a real transfer-end protocol error).
// =============================================================================

g.cleanupStates([
  "CLEANUP_1",
  "ADF_CLEANUP_ACK1",
  "ADF_CLEANUP_ACK2",
  "ADF_CLEANUP_STATUS",
  "CLEANUP_2",
  "UNLOCKING",
]);

// =============================================================================
// Export the built graph
// =============================================================================

export const esciGraph: Graph<EsciCtx> = g.build();
