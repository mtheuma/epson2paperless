// src/esci2/graph.ts

import { createGraph, type Graph } from "../scan-session.js";
// TODO(T22): decision, GraphBuilder, SendSpec used in T22+ state helpers
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

// Suppress unused-import warnings for identifiers used in T22-T26 state helpers.
void buildLockPacket;
void buildUnlockPacket;
void buildPassthruPacket;
void buildPurereadPacket;
void buildFsY;
void buildFsX;
void buildFsZ;
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
// Graph builder (states populated in T22-T27)
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

// Placeholder WELCOME state — replaced by the real lock-and-await flow in T22.
g.state("WELCOME", { on: {} });

// =============================================================================
// Helpers (extended in T22-T26)
// =============================================================================

// awaitAck — defined in T22.
// statThenDrain — defined in T23.

// =============================================================================
// Export the built graph
// =============================================================================

export const esci2Graph: Graph<Esci2Ctx> = g.build();
