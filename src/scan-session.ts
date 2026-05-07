// src/scan-session.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IS_HEADER_SIZE } from "./protocol.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";

// =============================================================================
// Transport
// =============================================================================

export type SessionTransportFactory = () => Promise<SessionTransport>;

export interface SessionTransport {
  write(buf: Buffer): boolean | void;
  /** Polite close after normal completion. */
  end(): void;
  /** Fail-fast destroy for error paths. */
  destroy(err?: Error): void;

  on(event: "data", cb: (chunk: Buffer) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  on(event: "close", cb: (hadError?: boolean) => void): this;
}

// =============================================================================
// Graph
// =============================================================================

export interface Graph<Ctx> {
  initial: string;
  states: Record<string, GraphState<Ctx>>;
  /** Per-scanner default rolling timeout, in ms. */
  timeoutMs: number;
  /**
   * Pre-state-dispatch abort handlers, keyed by IS packet type. Used for
   * protocol meta-events (e.g. ESC/I-2 0x9000). Returns Error to fail;
   * returns null to ignore.
   */
  globalAbortHandlers?: Record<
    number,
    (ctx: Ctx, packet: { type: number; payload: Buffer }) => Error | null
  >;
  /**
   * Pre-dispatch packet filter — returns true to discard. Used for the
   * "wait for body" empty-envelope pattern (ESC/I-2 empty 0xa000).
   */
  globalIgnoreFilter?: (packet: { type: number; payload: Buffer }) => boolean;
}

/** Single write spec — concrete bytes or a ctx-thunk resolved at dispatch time. */
export type SendSpec<Ctx> = Buffer | ((ctx: Ctx) => Buffer);

export type GraphState<Ctx> =
  | {
      kind: "static";
      on: Record<number, StaticTransition<Ctx>>;
      onEnter?: (ctx: Ctx) => Buffer | null;
    }
  | {
      kind: "decision";
      decide: DecisionFn<Ctx>;
      onEnter?: (ctx: Ctx) => Buffer | null;
    };

export interface StaticTransition<Ctx> {
  next: string;
  /**
   * Bytes to write when this transition fires. Single-value form for
   * one-shot commands; array form for back-to-back multi-write patterns
   * where wire ordering matters (e.g. legacy ESC e: opcode and parameter
   * packet sent back-to-back, host then waits for two ACKs — delaying
   * the parameter write changes wire order and breaks replay tests).
   * Engine writes are sequential in array order; thunks resolve against
   * current ctx at dispatch time.
   */
  send?: SendSpec<Ctx> | SendSpec<Ctx>[];
  /**
   * Payload validator. The graph's `on:` table is keyed by IS packet
   * *type*; for protocols that further validate a payload byte (notably
   * ESC/I: every passthru reply is a `0x2000` envelope whose payload
   * byte 0 carries the protocol-level ACK / NAK), the transition
   * specifies a validator. Engine semantics: packet type matches → run
   * `validate(payload)`; true → apply; false → fail the session with a
   * state-tagged error. Use `globalIgnoreFilter` for "discard this
   * packet quietly" semantics — `validate` is for hard protocol errors.
   */
  validate?: (payload: Buffer) => boolean;
  flushPage?: PageFlush;
}

export type DecisionFn<Ctx> = (
  ctx: Ctx,
  packet: { type: number; payload: Buffer },
) => TransitionResult<Ctx>;

/**
 * Decision-fn return shape. Generic over Ctx so decisions can return
 * the same SendSpec types static transitions accept (concrete Buffer,
 * (ctx) => Buffer thunk, or arrays of either). The engine's resolveSend
 * + writeAll handle all shapes uniformly, so unifying the type here
 * keeps decision call sites aligned with static-transition call sites.
 */
export type TransitionResult<Ctx> =
  | { next: string; send?: SendSpec<Ctx> | SendSpec<Ctx>[]; flushPage?: PageFlush }
  | { error: Error };

export interface PageFlush {
  /** Returns finished JPEG bytes. */
  encode: () => Promise<Buffer>;
  side: "front" | "back";
}

// =============================================================================
// Builder (authoring-only)
// =============================================================================

export interface GraphBuilder<Ctx> {
  state(name: string, def: StateDef<Ctx>): this;
  /** Set the graph's global abort handlers (preempt state dispatch). */
  globalAbortHandlers(
    handlers: Record<number, (ctx: Ctx, packet: { type: number; payload: Buffer }) => Error | null>,
  ): this;
  /** Set the graph's pre-dispatch packet filter. */
  globalIgnoreFilter(filter: (packet: { type: number; payload: Buffer }) => boolean): this;
  build(): Graph<Ctx>;
}

export type StateDef<Ctx> =
  | { on: Record<number, StaticTransition<Ctx>>; onEnter?: (ctx: Ctx) => Buffer | null }
  | DecisionDef<Ctx>;

export interface DecisionDef<Ctx> {
  __decision: true;
  decide: DecisionFn<Ctx>;
  onEnter?: (ctx: Ctx) => Buffer | null;
}

export function createGraph<Ctx>(initial: string, timeoutMs: number): GraphBuilder<Ctx> {
  const states: Record<string, GraphState<Ctx>> = {};
  let abortHandlers: Graph<Ctx>["globalAbortHandlers"];
  let ignoreFilter: Graph<Ctx>["globalIgnoreFilter"];
  return {
    state(name, def) {
      if (name === "DONE") {
        throw new Error(
          '"DONE" is reserved as the engine terminal state; do not define a g.state("DONE", ...)',
        );
      }
      if (states[name]) throw new Error(`Duplicate state name: ${name}`);
      if ("__decision" in def) {
        states[name] = { kind: "decision", decide: def.decide, onEnter: def.onEnter };
      } else {
        states[name] = { kind: "static", on: def.on, onEnter: def.onEnter };
      }
      return this;
    },
    globalAbortHandlers(handlers) {
      abortHandlers = handlers;
      return this;
    },
    globalIgnoreFilter(filter) {
      ignoreFilter = filter;
      return this;
    },
    build() {
      if (!states[initial]) throw new Error(`Initial state '${initial}' not defined`);
      return Object.freeze({
        initial,
        states: Object.freeze(states),
        timeoutMs,
        globalAbortHandlers: abortHandlers,
        globalIgnoreFilter: ignoreFilter,
      });
    },
  };
}

export function decision<Ctx>(decide: DecisionFn<Ctx>): DecisionDef<Ctx> {
  return { __decision: true, decide };
}

// =============================================================================
// Engine
// =============================================================================

export interface RunScanSessionOpts<Ctx> {
  graph: Graph<Ctx>;
  initialCtx: Ctx;
  transportFactory: SessionTransportFactory;
  outputDir: string;
  tempDir: string;
  sessionTs: Date;
  action: "jpg" | "pdf";
  paperless?: PaperlessUploadOptions;
  /**
   * Test-only: allow reaching DONE without any flushPage having fired.
   * Production paths must never set this — zero-page completion is a
   * real failure mode (printer-side error that aborted before pixel
   * transfer started). Carries over the v0.3.0 §3.3 zero-image-rejection
   * contract.
   */
  allowZeroPages?: boolean;
}

export type RunScanSessionResult<Ctx> =
  | { ok: true; finalCtx: Ctx }
  | { ok: false; reason: Error; finalCtx?: Ctx };

export async function runScanSession<Ctx>(
  opts: RunScanSessionOpts<Ctx>,
): Promise<RunScanSessionResult<Ctx>> {
  const { graph, initialCtx, transportFactory } = opts;
  const ctx = { ...initialCtx }; // engine owns mutability

  // Factory failures (TLS handshake, cert-fingerprint mismatch, plain TCP
  // connect refusal) must surface as { ok: false, reason } to keep the
  // engine's Result contract honest.
  let transport: SessionTransport;
  try {
    transport = await transportFactory();
  } catch (err) {
    const reason = err instanceof Error ? err : new Error(String(err));
    return { ok: false, reason, finalCtx: ctx };
  }

  let currentState = "";
  // Set during a flushPage barrier — pauses the pump while encode/persist runs.
  let paused = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const recvChunks: Buffer[] = [];
  let recvBytes = 0;
  let pageIndex = 0;
  const backPageIndices: number[] = [];
  let sessionTempDir: string | null = null;

  return new Promise<RunScanSessionResult<Ctx>>((resolve) => {
    let settled = false;
    // Set true once any path has called finalizeSession (or is about to).
    // Prevents the post-scan-save fallback in settle from re-entering
    // finalize after doFinalize has already attempted (and failed) it.
    let finalizeAttempted = false;

    function armTimeout(): void {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        const reason = new Error(
          `Timeout in state ${currentState} — no response in ${graph.timeoutMs}ms`,
        );
        settle({ ok: false, reason, finalCtx: ctx });
      }, graph.timeoutMs);
    }

    function clearTimeoutTimer(): void {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    }

    const settle = (result: RunScanSessionResult<Ctx>) => {
      if (settled) return; // idempotent — close handler may also call this
      settled = true;
      clearTimeoutTimer(); // (T15)
      try {
        transport.destroy();
      } catch {
        /* swallow — destroy may throw on already-closed sockets */
      }

      // Post-scan-save fallback (v0.3.0 §3.3). If pages were already
      // flushed before this failure fired, the failure is happening in
      // post-image cleanup territory (panel hygiene — UNLOCK ack, async
      // event, peer close mid-handshake). Promote the captured pages to
      // outputDir and resolve as success. Discarding scans the user
      // already got out of the printer is the worse outcome here.
      // finalizeAttempted gates the doFinalize → settle({ok:false}) loop:
      // if doFinalize already tried and failed, surface the original error
      // instead of retrying.
      if (!result.ok && sessionTempDir !== null && pageIndex > 0 && !finalizeAttempted) {
        finalizeAttempted = true;
        const tempDirAtSettle = sessionTempDir;
        void (async () => {
          try {
            const { finalizeSession } = await import("./output-tail.js");
            await finalizeSession({
              sessionTempDir: tempDirAtSettle,
              outputDir: opts.outputDir,
              sessionTs: opts.sessionTs,
              action: opts.action,
              backPageIndices,
              paperless: opts.paperless,
            });
            resolve({ ok: true, finalCtx: ctx });
          } catch {
            // Finalize itself failed — surface original error.
            resolve(result);
          }
        })();
        return;
      }

      resolve(result);
    };

    /**
     * Advances to a new state, fires its onEnter hook (which may write the
     * initial command for that state), and handles the DONE terminal.
     * Called synchronously on initial entry and after every transition.
     * Re-arms the rolling timeout on each state entry.
     *
     * On entering DONE: calls transport.end() (polite FIN) and schedules
     * finalize/zero-page-rejection via setImmediate — does NOT wait for
     * the 'close' event, mirroring the ESC/I-2 scanner's "logical completion"
     * pattern. The close handler then only handles unexpected closes.
     */
    function enterState(name: string): void {
      currentState = name;
      if (currentState === "DONE") {
        transport.end(); // polite close request; peer may ACK late or never
        // Schedule logical finalize independently — do NOT block on socket
        // close. setImmediate gives any in-flight microtasks (e.g. flushPage's
        // last file-write) a tick to settle before we run finalize.
        setImmediate(() => {
          void doFinalize();
        });
        return;
      }
      const state = graph.states[currentState];
      if (state.onEnter) {
        const bytes = state.onEnter(ctx);
        if (bytes) transport.write(bytes);
      }
      armTimeout(); // (T15)
    }

    /**
     * Logical completion handler — runs after DONE is entered (via setImmediate).
     * Handles zero-page rejection and finalizeSession. Idempotent via `settled`.
     */
    async function doFinalize(): Promise<void> {
      if (settled) return; // already settled (race with unexpected close)

      // Zero-page rejection (spec §3.6). A graph reaching DONE without any
      // flushPage having fired is a real failure mode in production — typically
      // a printer-side error that aborted before pixel transfer started, or a
      // protocol mis-script. Test-only escape via opts.allowZeroPages.
      if (pageIndex === 0 && !opts.allowZeroPages) {
        settle({
          ok: false,
          reason: new Error("Scan completed with zero image chunks"),
          finalCtx: ctx,
        });
        return;
      }

      if (sessionTempDir) {
        finalizeAttempted = true;
        try {
          const { finalizeSession } = await import("./output-tail.js");
          await finalizeSession({
            sessionTempDir,
            outputDir: opts.outputDir,
            sessionTs: opts.sessionTs,
            action: opts.action,
            backPageIndices,
            paperless: opts.paperless,
          });
        } catch (err) {
          const reason = err instanceof Error ? err : new Error(String(err));
          settle({ ok: false, reason, finalCtx: ctx });
          return;
        }
      }
      settle({ ok: true, finalCtx: ctx });
    }

    transport.on("error", (err) => {
      settle({ ok: false, reason: err, finalCtx: ctx });
    });

    // Close handler — only handles unexpected closes. The DONE path settles
    // via doFinalize (scheduled by enterState via setImmediate) independently
    // of socket close. Two reasons this handler is a no-op on the DONE path:
    // 1. If close fires after doFinalize has run, settled === true → return.
    // 2. If close fires synchronously during transport.end() (e.g. FakeTransport
    //    emits close in end()), currentState === "DONE" → return; doFinalize
    //    will still run on the next tick and settle the promise.
    transport.on("close", () => {
      if (settled) return;
      if (currentState === "DONE") return; // doFinalize handles this path
      settle({
        ok: false,
        reason: new Error(`Transport closed unexpectedly in state ${currentState}`),
        finalCtx: ctx,
      });
    });

    transport.on("data", (chunk: Buffer) => {
      recvChunks.push(chunk);
      recvBytes += chunk.length;
      void tryDispatch();
    });

    /**
     * Resolves a transition `send` field — Buffer | function | array of
     * either — against the current ctx into a flat array of byte buffers
     * to write in order. Empty array means "no writes."
     */
    function resolveSend(send: SendSpec<Ctx> | SendSpec<Ctx>[] | Buffer | undefined): Buffer[] {
      if (!send) return [];
      const items = Array.isArray(send) ? send : [send];
      return items.map((s) => (typeof s === "function" ? s(ctx) : s));
    }

    function writeAll(buffers: Buffer[]): void {
      for (const buf of buffers) transport.write(buf);
    }

    let dispatching = false;

    /**
     * Async pump loop. Reentrancy is prevented by the `dispatching` guard:
     * concurrent calls (from `'data'` events that fire while the loop is
     * awaiting an applyTransition) short-circuit; the active loop drains
     * any chunks they buffered on its next iteration.
     *
     * The loop checks `paused`, `settled`, and `currentState === "DONE"` at
     * every step — set during a flushPage barrier or after the session is
     * finalized — so a buffered second packet in the same TCP chunk doesn't
     * keep dispatching after the session has already completed or errored.
     *
     * Hook exceptions (from validate, decision, onEnter, send thunks, etc.)
     * are caught here and routed through settle so they surface as
     * { ok: false, reason } rather than unhandled Promise rejections.
     */
    async function tryDispatch(): Promise<void> {
      if (dispatching) return;
      dispatching = true;
      try {
        while (true) {
          if (paused || settled || currentState === "DONE") return;
          const packet = tryParseHead();
          if (!packet) return;
          try {
            await dispatchPacket(packet);
          } catch (err) {
            // Hook threw — route through settle rather than letting the
            // rejection escape through the `void tryDispatch()` call site.
            const reason = err instanceof Error ? err : new Error(String(err));
            if (!settled) {
              settle({
                ok: false,
                reason: new Error(`Engine error in state ${currentState}: ${reason.message}`),
                finalCtx: ctx,
              });
            }
            return;
          }
          if (paused || settled || currentState === "DONE") return;
        }
      } finally {
        dispatching = false;
      }
    }

    /**
     * Parse one IS packet at the head of recvChunks if a complete one is
     * present. Reads payloadSize directly from header bytes 6-9 (rather
     * than calling parseIsPacket on a partial buffer, which would return
     * null for any packet whose payload exceeds the peek window).
     */
    function tryParseHead(): { type: number; payload: Buffer; totalSize: number } | null {
      if (recvBytes < IS_HEADER_SIZE) return null;

      // Ensure first chunk has at least IS_HEADER_SIZE bytes so we can read
      // the header fields without re-concatenating each time.
      if (recvChunks[0].length < IS_HEADER_SIZE) {
        const merged = Buffer.concat(recvChunks, recvBytes);
        recvChunks.length = 0;
        recvChunks.push(merged);
      }

      const head = recvChunks[0];
      // Validate magic
      if (head[0] !== 0x49 /* 'I' */ || head[1] !== 0x53 /* 'S' */) {
        settle({
          ok: false,
          reason: new Error(
            `Invalid IS magic at packet head: 0x${head[0]?.toString(16)} 0x${head[1]?.toString(16)}`,
          ),
          finalCtx: ctx,
        });
        return null;
      }
      const type = head.readUInt16BE(2);
      const payloadSize = head.readUInt32BE(6);
      const totalSize = IS_HEADER_SIZE + payloadSize;

      if (recvBytes < totalSize) return null; // need more bytes

      // We have the full packet — materialize and peel
      const merged = recvChunks.length === 1 ? recvChunks[0] : Buffer.concat(recvChunks, recvBytes);
      recvChunks.length = 0;
      const payload = merged.subarray(IS_HEADER_SIZE, totalSize);
      const remainder = merged.subarray(totalSize);
      recvBytes = remainder.length;
      if (remainder.length > 0) recvChunks.push(remainder);
      return { type, payload, totalSize };
    }

    async function dispatchPacket(packet: { type: number; payload: Buffer }): Promise<void> {
      // Step 1: globalIgnoreFilter — silently discard packets the protocol
      // wants to filter pre-dispatch (e.g. ESC/I-2 empty 0xa000 envelopes).
      if (graph.globalIgnoreFilter && graph.globalIgnoreFilter(packet)) {
        return;
      }

      // Step 2: globalAbortHandlers — protocol meta-events that preempt
      // state-specific dispatch (e.g. ESC/I-2 0x9000 fatal/cancel/info).
      // Returns Error → fail; null → continue (info-only event).
      const handler = graph.globalAbortHandlers?.[packet.type];
      if (handler) {
        const err = handler(ctx, packet);
        if (err) {
          settle({ ok: false, reason: err, finalCtx: ctx });
          return;
        }
        return; // null → handler consumed the packet, no state change
      }

      // Step 3: state-specific dispatch
      const state = graph.states[currentState];
      if (state.kind === "static") {
        const transition = state.on[packet.type];
        if (!transition) {
          settle({
            ok: false,
            reason: new Error(
              `Unexpected packet type 0x${packet.type.toString(16).padStart(4, "0")} in state ${currentState}`,
            ),
            finalCtx: ctx,
          });
          return;
        }
        if (transition.validate && !transition.validate(packet.payload)) {
          settle({
            ok: false,
            reason: new Error(
              `Validation failed in state ${currentState} for packet type 0x${packet.type.toString(16).padStart(4, "0")}`,
            ),
            finalCtx: ctx,
          });
          return;
        }
        await applyTransition(transition);
      } else {
        // decision
        const result = state.decide(ctx, packet);
        if ("error" in result) {
          settle({ ok: false, reason: result.error, finalCtx: ctx });
          return;
        }
        await applyTransition(result);
      }
    }

    async function createSessionTempDir(baseDir: string): Promise<string> {
      const base = baseDir || os.tmpdir();
      return fs.promises.mkdtemp(path.join(base, "epson2paperless-"));
    }

    /**
     * Applies a resolved transition: handles the flushPage barrier (encode +
     * persist while pump is paused), then writes any staged send bytes and
     * advances currentState. On the non-flush path writes and enters state
     * immediately. Accepts both StaticTransition and TransitionResult shapes —
     * resolveSend handles both uniformly.
     */
    async function applyTransition(t: {
      next: string;
      send?: SendSpec<Ctx> | SendSpec<Ctx>[] | Buffer | Buffer[];
      flushPage?: PageFlush;
    }): Promise<void> {
      if (t.flushPage) {
        // Spec §3.5 barrier order:
        // pause → encode/persist → unpause → write staged send → enter staged next.
        const stagedNext = t.next;
        const stagedSend = t.send;

        paused = true;
        clearTimeoutTimer(); // suspend timeout during barrier (spec §3.6)

        pageIndex += 1;
        const myPageIndex = pageIndex;

        try {
          const jpegBytes = await t.flushPage.encode();

          // Track back-page index regardless of action (PDF mode needs it for
          // pdf-lib /Rotate=180 in finalizeSession).
          if (t.flushPage.side === "back") {
            backPageIndices.push(myPageIndex);
          }

          // EXIF action-gating (spec §3.5 step 5).
          let outputBytes = jpegBytes;
          if (t.flushPage.side === "back" && opts.action === "jpg") {
            const { setJpegOrientation } = await import("./exif.js");
            outputBytes = setJpegOrientation(jpegBytes, 3);
          }

          // Write to temp file.
          if (!sessionTempDir) {
            sessionTempDir = await createSessionTempDir(opts.tempDir);
          }
          const filename = `page_${String(myPageIndex).padStart(2, "0")}.jpg`;
          await fs.promises.writeFile(path.join(sessionTempDir, filename), outputBytes);
        } catch (err) {
          const reason = err instanceof Error ? err : new Error(String(err));
          settle({ ok: false, reason, finalCtx: ctx });
          return;
        }

        paused = false;
        // Apply staged send after barrier resolves (spec §3.5 step 8).
        writeAll(resolveSend(stagedSend));
        enterState(stagedNext);
        // Do NOT call tryDispatch() recursively. The outer pump loop is awaiting
        // this very applyTransition call — the next loop pass picks up any
        // buffered packets and dispatches them with the new state.
        return;
      }

      // Non-flush path — write and enter state immediately.
      writeAll(resolveSend(t.send));
      enterState(t.next);
    }

    // Enter the initial state. This fires onEnter for the initial state
    // (which may write the first command) synchronously inside the Promise
    // body, after all listeners are wired, so the first setImmediate
    // microtask queued by tests sees the writes.
    //
    // Wrap in try/catch: if the initial onEnter hook throws, we route through
    // settle rather than letting the Promise reject (which would violate the
    // RunScanSessionResult contract and become an unhandled rejection at the
    // call site, since callers await the result, not a thrown error).
    try {
      enterState(graph.initial);
    } catch (err) {
      const reason = err instanceof Error ? err : new Error(String(err));
      settle({
        ok: false,
        reason: new Error(
          `Engine error entering initial state ${graph.initial}: ${reason.message}`,
        ),
        finalCtx: ctx,
      });
    }
  });
}
