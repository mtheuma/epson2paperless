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
  // TODO(T24): parseTokens used when parsing PARA / TRDT replies
} from "./commands.js";

// Suppress unused-import warnings for identifiers used in T23-T26 state helpers.
void decision;
void buildUnlockPacket;
void buildPurereadPacket;
void buildFsX;
void buildEsci2Command;
void buildParaHeader;
void buildParaPayload;
void parseEsci2ReplyHeader;

/**
 * Per-session mutable state threaded through every transition. The engine
 * owns the page-index + back-page-indices + sessionTempDir bookkeeping;
 * everything here is ESC/I-2-protocol-specific.
 */
export interface Esci2Ctx {
  duplex: boolean;
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
 * optionally sends bytes on transition.
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

// statThenDrain — defined in T23.

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

// INIT1_FS_Y: 0xa000 FS-Y-ack → send FIN → INIT1_FIN
// scanner.ts onInit1FsY: receives 0xa000, runs INFO+CAPA two-phase sequence,
// then sends FIN → INIT1_FIN. INFO/CAPA states added in T23.
awaitAck(
  g,
  "INIT1_FS_Y",
  0xa000,
  "INIT1_FIN",
  buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
);

// INIT1_FIN: 0xa000 FIN-ack → send FS Z → INIT2_FS_Z
// scanner.ts onInit1Fin: receives 0xa000, sends buildPassthruPacket(buildFsZ(), LEGACY_REPLY_SIZE)
awaitAck(g, "INIT1_FIN", 0xa000, "INIT2_FS_Z", buildPassthruPacket(buildFsZ(), LEGACY_REPLY_SIZE));

// INIT2_FS_Z: 0xa000 FS-Z-ack → send FIN → INIT2_FIN
// scanner.ts onInit2FsZ: receives 0xa000, runs INFO+CAPA+RESA two-phase sequence,
// then sends FIN → INIT2_FIN. INFO/CAPA/RESA states added in T23.
awaitAck(
  g,
  "INIT2_FS_Z",
  0xa000,
  "INIT2_FIN",
  buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
);

// INIT2_FIN: 0xa000 FIN-ack → advance to INIT_POLL_FS_Y (T23 territory).
// scanner.ts onInit2Fin: receives 0xa000, resets initPollIteration, sends FS Y.
// The initPollIteration reset and FS Y send are T23's responsibility;
// this state just records the transition target.
awaitAck(g, "INIT2_FIN", 0xa000, "INIT_POLL_FS_Y");

// =============================================================================
// Helpers (extended in T23-T26)
// =============================================================================

// statThenDrain — defined in T23.

// =============================================================================
// Export the built graph
// =============================================================================

export const esci2Graph: Graph<Esci2Ctx> = g.build();
