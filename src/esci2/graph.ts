// src/esci2/graph.ts

import {
  createGraph,
  decision,
  type Graph,
  type GraphBuilder,
  type SendSpec,
  type TransitionResult,
} from "../scan-session.js";
import {
  buildLockPacket,
  buildUnlockPacket,
  buildPassthruPacket,
  buildPurereadPacket,
} from "../protocol.js";
import { buildFsY, buildFsX, buildFsZ } from "../commands-fs.js";
import {
  buildEsci2Command,
  buildParaHeader,
  parseEsci2ReplyHeader,
  parseTokens,
} from "./commands.js";
import { ackByte, expectIsType } from "../graph-helpers.js";
import { supportsWireGrayscale, type RegistryEntry } from "./dialects/registry.js";
import {
  lookupRegistryEntry,
  applyEntrySourceOverride,
  makeParaSpec,
  assertSourceSupported,
} from "./dialects/dispatch.js";
import { computeCapaFingerprint } from "./capa-fingerprint.js";
import { composePara, baseDpiFor, type ParaSpec } from "./para-composer.js";
import { parseCapaTokens, type CapaTokens } from "./capabilities.js";
import { advertisedDpiSet, selectWireDpi } from "./resolution.js";
import { createLogger } from "../logger.js";

const log = createLogger("scanner-esci2");

/**
 * Per-session mutable state threaded through every transition. The engine
 * owns the page-index + back-page-indices + sessionTempDir bookkeeping;
 * everything here is ESC/I-2-protocol-specific.
 */
export interface Esci2Ctx {
  duplex: boolean;
  source: "adf" | "flatbed"; // detected at INIT_POLL iteration 0
  /** Transport layer in use this session. Probe-driven, not dialect-driven. */
  transport: "tls" | "plain";
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
  /** INFO reply body captured from INIT1, used for dialect resolution + diagnostics. Buffer.alloc(0) until INIT1_INFO_DATA fires. */
  infoBody: Buffer;
  /** CAPA#1 reply body captured from INIT1. Buffer.alloc(0) until INIT1_CAPA_DATA fires. */
  capaBody: Buffer;
  /**
   * Parsed CAPA#1 tokens (resolution lists, JPEG quality range, etc.),
   * captured alongside `entry` at INIT1_CAPA once the fingerprint resolves.
   * Undefined until INIT1 completes. Consumed by buildParaSend to select the
   * wire DPI and clamp jpegQuality against the printer's advertised range.
   */
  capaTokens: CapaTokens | undefined;
  /** Resolved registry entry post-INIT1, drives PARA build + init-poll count + source detection. Undefined until INIT1 completes. */
  entry: RegistryEntry | undefined;
  /** Panel-selected output format; drives action-aware dialects' PARA splice. */
  action: "jpg" | "pdf";
  /**
   * Target scan resolution in DPI, threaded from config.scanResolution.
   * Undefined means the dialect's pinned default. buildParaSend resolves
   * this against the printer's advertised CAPA resolution lists (via
   * selectWireDpi) to pick the actual wire DPI — see `wireDpi` /
   * `downsampleToDpi` below.
   */
  resolution: number | undefined;
  /**
   * Colour mode, threaded from config.scanColorMode. Only greyscale-capable
   * dialects (those with a monoGammaClass, e.g. DS-575W) act on it on the
   * wire; all others scan in colour and the scanner shell converts every
   * page to greyscale host-side at finalize.
   */
  colorMode: "color" | "grayscale";
  /**
   * Requested JPEG encode quality (1..100), threaded from
   * config.scanJpegQuality (or DEFAULT_JPEG_QUALITY). buildParaSend clamps
   * this against the printer's advertised #JPGRANG before it reaches the
   * wire; the unclamped value still drives the host-side JPEG encode.
   */
  jpegQuality: number;
  /**
   * The DPI actually requested on the wire, resolved by buildParaSend via
   * selectWireDpi. Undefined until the PARA build runs. Read by Task 6's
   * finalize resolver alongside `downsampleToDpi`.
   */
  wireDpi: number | undefined;
  /**
   * Set when the wire couldn't reach the requested target DPI exactly and
   * the scan must be host-downsampled after capture to reach it. Undefined
   * when no downsample is needed (exact match or capped-at-max).
   */
  downsampleToDpi: number | undefined;
}

export const ESCI2_TIMEOUT_MS = 30_000;
export const ESCI2_REPLY_SIZE = 64;

const LEGACY_REPLY_SIZE = 1;
// 5000 zero-length retries gives ~100s of headroom for slow scan starts.
// XP-7100 flatbed captures show up to 2612 zero-length IMG responses before
// the printer starts delivering data, so the limit must exceed that.
const MAX_ZERO_IMG_RETRIES = 5000;

/**
 * Async-event dispatch bytes (type 0x9000 body[0]).
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
 * awaitReply — registers a static state that waits for `expectedReplyType`,
 * runs `validate` against the payload, then advances to `next` (optionally
 * emitting `send`). Local rename of what used to be `awaitAck` — both
 * graphs now have a same-shaped helper but they intentionally stay
 * per-graph (no shared abstraction) because the marginal cost of two
 * copies is small and the graphs use the helper with different `Ctx`
 * type parameters; lifting it would force a generic Ctx parameter that
 * adds a layer of indirection without payoff. Revisit if a third graph
 * appears.
 */
function awaitReply(
  g: GraphBuilder<Esci2Ctx>,
  name: string,
  expectedReplyType: number,
  validate: (payload: Buffer) => boolean,
  next: string,
  send?: SendSpec<Esci2Ctx> | SendSpec<Esci2Ctx>[],
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

// =============================================================================
// Graph builder
// =============================================================================

// Empty 0xa000 envelopes are "wait for body" pre-data signals on the
// ESC/I-2 wire EXCEPT in POSTSCAN_*_STAT_DRAIN — there, after our
// pure-read(0) for a length=0 STAT reply, the printer's empty 0xa000
// IS the drain-complete trigger and must reach the state for it to
// advance to FIN. The bypass is per-state via `bypassIgnoreFilter: true`
// on the two drain states (declared below) — the filter itself stays a
// pure shape predicate. INIT_POLL_STAT_DRAIN and POST_MODE_STAT_DRAIN
// never need the bypass (their _STAT decisions skip the drain when
// length === 0).
const g = createGraph<Esci2Ctx>("WELCOME", ESCI2_TIMEOUT_MS)
  .globalIgnoreFilter((packet) => packet.type === 0xa000 && packet.payload.length === 0)
  // 0x9000 is the protocol-level async event channel: fatal/cancel
  // payloads abort the session regardless of state; ScanStart/Stop and
  // unknown bytes are info-only (return null to ignore).
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
awaitReply(g, "WELCOME", 0x8000, () => true, "LOCKING", buildLockPacket());

// LOCKING: 0xa100 lock-ack (payload[0] === 0x06) → send FS Y → INIT1_FS_Y
awaitReply(
  g,
  "LOCKING",
  0xa100,
  ackByte(0x06),
  "INIT1_FS_Y",
  buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE),
);

// INIT1_FS_Y: 0xa000 FS-Y-ack (1-byte 0x06) → send INFO META command → INIT1_INFO_META
awaitReply(
  g,
  "INIT1_FS_Y",
  0xa000,
  ackByte(0x06),
  "INIT1_INFO_META",
  buildPassthruPacket(buildEsci2Command("INFO"), ESCI2_REPLY_SIZE),
);

// INIT1_FIN: 0xa000 FIN-ack → send FS Z → INIT2_FS_Z
// (No ack-byte check here — FIN reply is a 64-byte envelope, not a 1-byte ACK.)
awaitReply(
  g,
  "INIT1_FIN",
  0xa000,
  () => true,
  "INIT2_FS_Z",
  buildPassthruPacket(buildFsZ(), LEGACY_REPLY_SIZE),
);

// INIT2_FS_Z: 0xa000 FS-Z-ack (1-byte 0x06) → send INFO META command → INIT2_INFO_META
awaitReply(
  g,
  "INIT2_FS_Z",
  0xa000,
  ackByte(0x06),
  "INIT2_INFO_META",
  buildPassthruPacket(buildEsci2Command("INFO"), ESCI2_REPLY_SIZE),
);

// INIT2_FIN: 0xa000 FIN-ack → reset initPollIteration, send FS Y → INIT_POLL_FS_Y.
awaitReply(
  g,
  "INIT2_FIN",
  0xa000,
  () => true,
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
  /** Optional side-effect + early-return hook fired in `${prefix}_DATA`
   *  after the length check. Return undefined for the normal transition,
   *  or a `{ error }` TransitionResult to abort the session. */
  onData?: (ctx: Esci2Ctx, body: Buffer) => TransitionResult<Esci2Ctx> | void,
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
      if (onData) {
        const result = onData(ctx, packet.payload);
        if (result !== undefined) return result;
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
  (ctx, body) => {
    ctx.infoBody = body;
  },
);
twoPhaseRead(
  g,
  "INIT1_CAPA",
  "CAPA",
  buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
  "INIT1_FIN",
  (ctx, body) => {
    ctx.capaBody = body;
    const fingerprint = computeCapaFingerprint(body);
    try {
      ctx.entry = lookupRegistryEntry(fingerprint, ctx.capaBody, ctx.infoBody, ctx.transport);
    } catch (err) {
      return { error: err as Error };
    }
    ctx.capaTokens = parseCapaTokens(body);
    log.debug("Dialect resolved", { name: ctx.entry.displayName, fingerprint });
    applyEntrySourceOverride(ctx, ctx.entry);
  },
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
 * statThenDrain — builds three states that encode the "STAT reply →
 * (optional) drain → FIN" sub-flow that recurs in INIT_POLL (inline),
 * POST_MODE (T24), and POSTSCAN×2 (T26).
 *
 *   `${prefix}_STAT`       — decision: parses reply header length and either
 *                            advances to _STAT_DRAIN with a pure-read or jumps
 *                            straight to _FIN. POST_MODE skips the drain when
 *                            length === 0; POSTSCAN always drains (legacy
 *                            scanner sent buildPurereadPacket(header?.length ??
 *                            12) before FIN unconditionally — firmware
 *                            variants that emit zero-length status replies
 *                            still need the drain to clear printer-side
 *                            cleanup state, and the declared length is what
 *                            we replay back to the printer regardless).
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
  alwaysDrain = false,
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
      if (header.length > 0 || alwaysDrain) {
        // Use the declared length verbatim — including 0 — to mirror
        // the legacy scanner's wire sequence. The 12-byte fallback in
        // the old code applied only to unparseable headers (which we
        // now error on above), not to valid length=0 replies.
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
    // POSTSCAN drains run with `alwaysDrain=true` and the printer can
    // reply length=0 — the empty 0xa000 IS the drain-complete trigger
    // here, so opt this state out of `globalIgnoreFilter`. The
    // POST_MODE / INIT_POLL drains never reach with length=0 (their
    // _STAT decisions skip the drain entirely in that case), so the
    // bypass is scoped to alwaysDrain cycles only.
    ...(alwaysDrain ? { bypassIgnoreFilter: true as const } : {}),
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

// POSTSCAN cycle 1: POSTSCAN_1_STAT → POSTSCAN_1_STAT_DRAIN → POSTSCAN_1_FIN → POSTSCAN_FS_Y_2
// POSTSCAN_1_FIN sends FS Y to start cycle 2.
statThenDrain(
  g,
  "POSTSCAN_1",
  "POSTSCAN_FS_Y_2",
  buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE),
  true,
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

// POSTSCAN cycle 2: POSTSCAN_2_STAT → POSTSCAN_2_STAT_DRAIN → POSTSCAN_2_FIN → UNLOCKING
// POSTSCAN_2_FIN has no further send — UNLOCKING's onEnter sends the unlock packet.
statThenDrain(g, "POSTSCAN_2", "UNLOCKING", undefined, true);

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
//   Other lengths default to ADF, preserving the source-detection fallback.
g.state(
  "INIT_POLL_STAT",
  decision<Esci2Ctx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, 0xa000, "INIT_POLL_STAT");
    if (typeGuard) return typeGuard;
    const header = parseEsci2ReplyHeader(packet.payload);
    if (header === null) {
      return { error: new Error("INIT_POLL_STAT: unparseable reply header") };
    }
    // Source detection — only on the FIRST iteration, and only when the
    // dialect declares `sourceDetection: "stat-length"`.
    // ET-4950 fixtures: length 0 → ADF (printer queued no status);
    // length 12 → flatbed (queued `#---#---#---` filler). Other lengths
    // default to ADF.
    //
    // ET-2750 uses `sourceDetection: "fixed-flatbed"` because it is
    // flatbed-only hardware AND its STAT replies declare length=0 even
    // though the IS frame packs an inline 52-byte filler — applying the
    // stat-length heuristic would misclassify it as ADF, so skip the
    // override entirely and trust the `source: "flatbed"` value the
    // scanner shell pre-set in `initialCtx`.
    if (ctx.initPollIteration === 0 && ctx.entry!.sourceDetection === "stat-length") {
      if (header.length === 0) {
        ctx.source = "adf";
      } else if (header.length === 12) {
        ctx.source = "flatbed";
      } else {
        ctx.source = "adf"; // fallback for unexpected status length
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
// INIT_POLL_FIN increments initPollIteration; if below the dialect's
// target iteration count sends FS Y and loops; else sends FS X and
// moves to MODE_SWITCH.
g.state(
  "INIT_POLL_FIN",
  decision<Esci2Ctx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, 0xa000, "INIT_POLL_FIN");
    if (typeGuard) return typeGuard;
    ctx.initPollIteration += 1;
    const target = ctx.entry!.initPollIterations;
    if (ctx.initPollIteration < target) {
      return {
        next: "INIT_POLL_FS_Y",
        send: buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE),
      };
    }
    // Target iterations done — send FS X to enter extended mode → MODE_SWITCH.
    return {
      next: "MODE_SWITCH",
      send: buildPassthruPacket(buildFsX(), LEGACY_REPLY_SIZE),
    };
  }),
);

// =============================================================================
// MODE_SWITCH / POST_MODE_STAT / PARA / TRDT / IMG_META states
// =============================================================================

// Builds the PARA header + body send pair. Called once per dispatch in
// POST_MODE_STAT and POST_MODE_STAT_DRAIN; composePara + registry entry
// selects the correct blob for the detected hardware.
function buildParaSend(ctx: Esci2Ctx): Buffer[] {
  const paraSource: ParaSpec["source"] =
    ctx.source === "flatbed" ? "flatbed" : ctx.duplex ? "adf-duplex" : "adf-simplex";
  assertSourceSupported(ctx.entry!, paraSource);
  // Where the wire can't honour grayscale, the scan runs in colour and every
  // page converts to greyscale host-side at finalize (see the scanner
  // shell's resolveGrayscaleConversion, keyed on the same predicate). Say
  // so, or the colour wire traffic in a remote-triage debug log reads as
  // the setting being ignored.
  if (ctx.colorMode === "grayscale" && !supportsWireGrayscale(ctx.entry)) {
    log.info(
      `SCAN_COLOR_MODE=grayscale: ${ctx.entry!.displayName} has no greyscale ` +
        "wire support — scanning in colour and converting to greyscale host-side.",
    );
  }
  // An unverified back-rotation assumption must be visible in the log on the
  // scans it affects, or no hardware report can ever correct it (#128 showed
  // the DS-575W's sibling hardware delivers backs upright).
  if (paraSource === "adf-duplex" && ctx.entry!.duplexBackRotationUnverified) {
    log.warn(
      `${ctx.entry!.displayName}: the duplex back-page rotation compensation is ` +
        "unconfirmed on this single-pass hardware — if back sides come out " +
        "upside down, please open an issue.",
    );
  }

  // Resolve the target DPI against what the printer actually advertised in
  // CAPA — exact match, else smallest-above + host downsample, else capped
  // at the max with an info log. No advertised lists (older/unprobed
  // dialects) fall back to the profile's pinned default as the sole wire
  // DPI, so the target still gets full selection semantics instead of being
  // silently discarded.
  const pinnedDefault = baseDpiFor(ctx.entry!.paraProfile);
  const target = ctx.resolution ?? pinnedDefault;
  const advertised = ctx.capaTokens ? advertisedDpiSet(ctx.capaTokens, paraSource) : [];
  const sel = selectWireDpi(target, advertised.length > 0 ? advertised : [pinnedDefault]);
  ctx.wireDpi = sel.wireDpi;
  ctx.downsampleToDpi = sel.downsampleToDpi;
  if (sel.cappedFrom !== undefined) {
    // Explicit requests name the env var the user set; the pinned default
    // isn't something the user chose, so don't imply they configured it —
    // name the model's own ceiling instead (the warn below already makes
    // this same explicit/default distinction).
    const message =
      ctx.resolution !== undefined
        ? `SCAN_RESOLUTION=${sel.cappedFrom} exceeds this model's maximum — scanning at ${sel.wireDpi} DPI`
        : `${ctx.entry!.displayName}'s ${paraSource} maximum is ${sel.wireDpi} DPI, below the ${sel.cappedFrom} DPI pinned default — scanning at ${sel.wireDpi} DPI`;
    log.info(message);
  }
  // Only warn when the caller explicitly asked for a resolution — the
  // dialect's own pinned default running at an as-yet-unverified DPI isn't
  // actionable by the user and would just be noise on every default scan.
  if (ctx.resolution !== undefined && !ctx.entry!.verifiedWireDpis.includes(sel.wireDpi)) {
    log.warn(
      `wire DPI ${sel.wireDpi} is unverified on ${ctx.entry!.displayName} — ` +
        "please report results (issue #81)",
    );
  }

  // Clamp the requested JPEG quality to the printer's advertised #JPGRANG,
  // if it advertised one — the host-side encode still uses the unclamped
  // ctx.jpegQuality. The advertised range itself isn't trusted blindly:
  // parseNumericList accepts any dNNN/iNNNNNNN, so a malformed or
  // out-of-domain CAPA value (e.g. #JPGRANGd150d200, entirely above the
  // 1..100 JPEG quality domain) is intersected with [1,100] first. An empty
  // intersection means the advertised range is unusable — ignore it and
  // fall back to ctx.jpegQuality as-is (already config-bounded 1..100).
  const range = ctx.capaTokens?.jpgRange;
  const sanitizedRange = range
    ? { min: Math.max(range.min, 1), max: Math.min(range.max, 100) }
    : undefined;
  const quality =
    sanitizedRange && sanitizedRange.min <= sanitizedRange.max
      ? Math.min(sanitizedRange.max, Math.max(sanitizedRange.min, ctx.jpegQuality))
      : ctx.jpegQuality;
  if (quality !== ctx.jpegQuality && range) {
    log.info(
      `JPEG quality ${ctx.jpegQuality} is outside this model's advertised #JPGRANG ` +
        `(${range.min}-${range.max}) — using ${quality}`,
    );
  }

  const paraPayload = composePara(
    makeParaSpec(ctx.entry!, paraSource, ctx.action, sel.wireDpi, ctx.colorMode, quality),
  );
  return [
    buildPassthruPacket(buildParaHeader(paraPayload.length), 0),
    buildPassthruPacket(paraPayload, ESCI2_REPLY_SIZE),
  ];
}

// MODE_SWITCH: receives the FS X ack (payload[0]=0x06); sends STAT → POST_MODE_STAT.
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

// PARA: decision on the printer's acceptance of parameters — header must
// parse, cmd must be "PARA", and the body must contain #parOK. A decision
// (rather than the previous validate-based static state) so a parsed-but-
// rejected reply produces a real, actionable error instead of falling
// through to an unmatched-packet timeout.
g.state(
  "PARA",
  decision<Esci2Ctx>((ctx, packet) => {
    const typeGuard = expectIsType(packet, 0xa000, "PARA");
    if (typeGuard) return typeGuard;
    const payload = packet.payload;
    const header = parseEsci2ReplyHeader(payload);
    if (header === null || header.cmd !== "PARA") {
      return { error: new Error("PARA: unparseable reply header") };
    }
    const par = parseTokens(payload.subarray(12)).get("par")?.trim();
    if (par !== "OK") {
      // The hint is only warranted when the wire DPI actually in use is one
      // we haven't verified works on this model — that's the real suspect
      // for a rejection, whether or not the DPI came from an explicit
      // SCAN_RESOLUTION (a session can land on an unverified DPI via the
      // dialect's own pinned default too). A verified wire DPI points
      // elsewhere, so the hint would be actively misleading there.
      const hint =
        ctx.wireDpi !== undefined && !ctx.entry!.verifiedWireDpis.includes(ctx.wireDpi)
          ? ` Requested wire DPI was ${ctx.wireDpi}; this model may not accept it — ` +
            `remove SCAN_RESOLUTION or report the result (issue #81).`
          : "";
      return { error: new Error(`PARA rejected by printer (#par${par ?? "?"}).${hint}`) };
    }
    return { next: "TRDT", send: buildPassthruPacket(buildEsci2Command("TRDT"), ESCI2_REPLY_SIZE) };
  }),
);

// TRDT: transfer-data handshake; sends IMG to start the image-receive loop.
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
// pageEndKind logic:
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
      // Some printers (e.g. XP-7100) re-echo the IMG metadata reply in
      // response to the PUREREAD command before sending the actual pixel
      // data. This is a double-handshake: the engine sends PUREREAD(N),
      // the printer replies with another "IMG xNNNNNNN" (same N), then
      // sends the pixel data. Detect this by checking that the 64-byte
      // payload is a well-formed IMG header whose declared size matches
      // the one the engine already stored in ctx.imgChunkSize, and if so
      // re-issue the PUREREAD to pull the real pixel chunk.
      if (packet.payload.length === ESCI2_REPLY_SIZE) {
        const echoHeader = parseEsci2ReplyHeader(packet.payload);
        if (
          echoHeader !== null &&
          echoHeader.cmd === "IMG" &&
          echoHeader.length === ctx.imgChunkSize
        ) {
          return {
            next: "IMG_DATA",
            send: buildPurereadPacket(ctx.imgChunkSize),
          };
        }
      }
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
// Once the last page has been flushed AND the post-image FIN ack has
// been received, the remaining states are panel hygiene: ADF drain
// handshake (POSTSCAN_*) and the LOCK release (UNLOCKING). Failures
// there — printer dropping the connection, async fatal during drain,
// an unexpected reply byte on the unlock ack — should not discard
// scans already sitting in the temp dir.
//
// FIN_AFTER_IMG is intentionally NOT in this list. The legacy scanner
// only forgave failures in POSTSCAN_*/UNLOCKING; the FIN ack is the
// printer's confirmation that image transfer completed cleanly, so an
// async fatal, malformed reply, or timeout there can signal a real
// end-of-transfer protocol error and should still reject the scan.
g.cleanupStates([
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
