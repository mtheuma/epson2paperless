// src/graph-helpers.ts
//
// Shared graph-state helpers used by both `src/esci2/graph.ts` and
// `src/esci/graph.ts`. The two graphs mostly diverge on protocol-specific
// vocabulary (commands, packet semantics, page-end detection); this module
// captures the small handful of patterns that are byte-identical between
// them, so editing one no longer means remembering to mirror the change in
// the other.

/**
 * Decision-state guard: ensure the incoming packet's IS type matches what
 * this state expects. Returns an `error` TransitionResult on mismatch (the
 * engine routes it through the standard failure path); returns null to
 * continue.
 *
 * Static states already fail fast on unmatched packet types via the engine's
 * dispatch table; decision states see every packet that wasn't filtered or
 * preempted by a global abort handler, so they need their own type guard
 * to avoid acting on the wrong wire data.
 */
export function expectIsType(
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

/**
 * Decision-state guard for length-checked replies. Companion to
 * `expectIsType`. Returns an `error` TransitionResult on length mismatch
 * so the engine routes through the standard failure path; null to continue.
 *
 * `label` is included in the error message to disambiguate replies that
 * share an IS type but carry different payload sizes (e.g. ESC/I returns
 * 1-byte ACKs, 14-byte FS G replies, 16-byte FS F status, and 80-byte FS I
 * identity all under the same `0xa000` envelope).
 */
export function expectLength(
  payload: Buffer,
  expected: number,
  stateName: string,
  label: string,
): { error: Error } | null {
  if (payload.length !== expected) {
    return {
      error: new Error(`${stateName}: expected ${expected}-byte ${label}, got ${payload.length}`),
    };
  }
  return null;
}

/**
 * Static-transition payload validator: the reply's first byte must equal
 * `b`. Use as the `validate` field on an `awaitReply`-style helper to
 * encode the "reply is a single ACK byte" pattern that recurs throughout
 * both ESC/I-2's pre-extended-mode handshake and ESC/I's per-command
 * passthru replies.
 *
 *   awaitReply(g, "LOCKING", 0xa100, ackByte(0x06), "INIT", lockResponse);
 */
export const ackByte =
  (b: number) =>
  (payload: Buffer): boolean =>
    payload[0] === b;
