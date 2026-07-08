// src/scan-session.ts

import * as fs from "node:fs";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type * as tls from "node:tls";
import { IS_HEADER_SIZE } from "./protocol.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";
import type { PostProcessProfile } from "./postprocess/index.js";
import type { ToneCurveName } from "./postprocess/tone-curves.js";
import { DEFAULT_JPEG_QUALITY } from "./config.js";

// =============================================================================
// Transport
// =============================================================================

export type SessionTransportFactory = () => Promise<SessionTransport>;

export interface SessionTransport {
  write(buf: Buffer): boolean | void;
  /**
   * Polite close after normal completion. The optional `data` payload is
   * written-then-half-closed in one call — `net.Socket.end(buf)` and
   * `tls.TLSSocket.end(buf)` both accept this shape, so adapters that need
   * to flush a final record (e.g. ESC/I-2's UNLOCK on destroy) can do so
   * without a separate write+end pair that could be reordered after the
   * FIN. The engine itself only ever calls `end()` with no argument (DONE
   * entry); the parameter exists for adapter composition.
   */
  end(data?: Buffer): void;
  /** Fail-fast destroy for error paths. */
  destroy(err?: Error): void;

  on(event: "data", cb: (chunk: Buffer) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  on(event: "close", cb: (hadError?: boolean) => void): this;
}

/**
 * Bridges a raw Node socket (`net.Socket` / `tls.TLSSocket`) onto the
 * engine's `SessionTransport` interface. Both socket types already
 * structurally implement `write` / `end(data?)` / `destroy(err?)` / `on`,
 * so the cast is safe; the named function makes the boundary explicit
 * and gives wrapper modules a single place to reason about "this is the
 * raw-socket leaf of the transport stack." Lives here (next to
 * `SessionTransport`) rather than in any single protocol's transport
 * module so neither protocol has to import across the boundary to
 * reach it.
 */
export function socketAsTransport(socket: net.Socket | tls.TLSSocket): SessionTransport {
  return socket as unknown as SessionTransport;
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
   * Pre-dispatch packet filter — returns true to discard. Scoped via the
   * per-state `bypassIgnoreFilter` flag below: graphs declare which states
   * treat the otherwise-filtered shape as semantically meaningful (e.g.
   * ESC/I-2 filters empty 0xa000 as a "wait for body" signal during image
   * flow, but POSTSCAN_*_STAT_DRAIN reads the same wire shape as the
   * drain-complete reply). The filter itself stays state-agnostic so it
   * can be a one-line shape predicate.
   */
  globalIgnoreFilter?: (packet: { type: number; payload: Buffer }) => boolean;
  /**
   * States in which a failure is treated as post-image cleanup and
   * recovered to success via the post-scan-save fallback (v0.3.0 §3.3) —
   * provided at least one page has already flushed. The graph declares
   * which states sit *after* the last image transfer (e.g.
   * FIN_AFTER_IMG, POSTSCAN_*, UNLOCKING). Failures in image-acquisition
   * states (IMG_META, IMG_DATA, etc.) still reject the session even on
   * page 2 of N — partial multi-page output should not be silently
   * promoted as success.
   *
   * `DONE` is implicitly excluded from the fallback because it's reserved
   * as the engine's terminal state and `g.state("DONE", ...)` throws — a
   * failure can't reach DONE through the dispatch path. The combination
   * of the reserved-name guard and the engine's `finalizeAttempted` gate
   * also ensures a finalize failure inside `doFinalize` is not retried
   * via this branch.
   */
  cleanupStates?: ReadonlySet<string>;
  /**
   * Upper bound on the `payloadSize` field of any IS frame the engine
   * will accept. A value larger than this means we've lost framing
   * synchronisation — a header byte landed at the wrong offset, or the
   * peer is sending corrupt data — and waiting for `payloadSize` more
   * bytes would manifest as a 30-second timeout-in-state instead of
   * the genuine "framing desync" diagnostic.
   *
   * Default 32 MB. Real fixtures top out around 28 KB (ESC/I-2 IMG
   * chunks); 32 MB is roughly 1000× that, so legitimate captures never
   * approach it, but a wild size field (e.g. 0xFFFFFFFF from random
   * bytes in the size slot) trips the check immediately. Override via
   * the graph builder if a future protocol genuinely sends bigger
   * payloads.
   */
  maxPayloadBytes?: number;
}

/**
 * Default upper bound on IS payload size — see `Graph.maxPayloadBytes`.
 * Exported for tests that need to assert the default applies to graphs
 * which don't override it.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** Single write spec — concrete bytes or a ctx-thunk resolved at dispatch time. */
export type SendSpec<Ctx> = Buffer | ((ctx: Ctx) => Buffer);

/**
 * Per-state flag that opts THIS state out of `Graph.globalIgnoreFilter` —
 * the filter still fires on every other state, but packets that reach a
 * state with `bypassIgnoreFilter: true` are dispatched to its handlers
 * unfiltered. Used in ESC/I-2 to let POSTSCAN_*_STAT_DRAIN observe the
 * empty-0xa000 packet that acts as the drain-complete trigger, without
 * complicating the filter itself with state-name knowledge.
 */
export interface CommonStateProps {
  bypassIgnoreFilter?: true;
}

export type GraphState<Ctx> = CommonStateProps &
  (
    | {
        kind: "static";
        on: Record<number, StaticTransition<Ctx>>;
        onEnter?: (ctx: Ctx) => Buffer | null;
      }
    | {
        kind: "decision";
        decide: DecisionFn<Ctx>;
        onEnter?: (ctx: Ctx) => Buffer | null;
      }
  );

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
  /**
   * Declare the post-image cleanup states. Failures in any of these
   * states are recovered to success via the post-scan-save fallback when
   * pages have already flushed. See `Graph.cleanupStates` for semantics.
   */
  cleanupStates(names: readonly string[]): this;
  build(): Graph<Ctx>;
}

export type StateDef<Ctx> = CommonStateProps &
  (
    | { on: Record<number, StaticTransition<Ctx>>; onEnter?: (ctx: Ctx) => Buffer | null }
    | DecisionDef<Ctx>
  );

export interface DecisionDef<Ctx> {
  __decision: true;
  decide: DecisionFn<Ctx>;
  onEnter?: (ctx: Ctx) => Buffer | null;
}

export function createGraph<Ctx>(initial: string, timeoutMs: number): GraphBuilder<Ctx> {
  const states: Record<string, GraphState<Ctx>> = {};
  let abortHandlers: Graph<Ctx>["globalAbortHandlers"];
  let ignoreFilter: Graph<Ctx>["globalIgnoreFilter"];
  let cleanup: ReadonlySet<string> | undefined;
  return {
    state(name, def) {
      if (name === "DONE") {
        throw new Error(
          '"DONE" is reserved as the engine terminal state; do not define a g.state("DONE", ...)',
        );
      }
      if (states[name]) throw new Error(`Duplicate state name: ${name}`);
      const bypass = def.bypassIgnoreFilter;
      if ("__decision" in def) {
        states[name] = {
          kind: "decision",
          decide: def.decide,
          onEnter: def.onEnter,
          ...(bypass ? { bypassIgnoreFilter: true } : {}),
        };
      } else {
        states[name] = {
          kind: "static",
          on: def.on,
          onEnter: def.onEnter,
          ...(bypass ? { bypassIgnoreFilter: true } : {}),
        };
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
    cleanupStates(names) {
      cleanup = new Set(names);
      return this;
    },
    build() {
      if (!states[initial]) throw new Error(`Initial state '${initial}' not defined`);
      if (cleanup) {
        for (const name of cleanup) {
          if (!states[name]) throw new Error(`cleanupStates references undefined state '${name}'`);
        }
      }
      return Object.freeze({
        initial,
        states: Object.freeze(states),
        timeoutMs,
        globalAbortHandlers: abortHandlers,
        globalIgnoreFilter: ignoreFilter,
        cleanupStates: cleanup,
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
  postProcess?: PostProcessProfile;
  jpegQuality?: number;
  /**
   * Resolves the pinned tone curve for the `document` profile from the final
   * context — the dialect is only known mid-scan (ESC/I-2 sets it at INIT1),
   * so the scanner shell supplies this callback and `runFinalize` reads it once
   * the scan has resolved the entry. Omitted (or returning undefined) means the
   * printer has no captured curve → white-point clip only.
   */
  resolveToneCurve?: (ctx: Ctx) => ToneCurveName | undefined;
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
    // Gates settle's post-scan-save branch against doFinalize's own finalize
    // attempt — without this, a finalize failure in doFinalize would route
    // back through settle and retry the same call.
    let finalizeAttempted = false;
    // Hoisted above listener registration so synchronous-during-on() data
    // replay doesn't TDZ this binding. Paired with the empty-state pump
    // gate below.
    let dispatching = false;

    /** Promotes pages from sessionTempDir to outputDir via the output pipeline. */
    async function runFinalize(tempDir: string): Promise<void> {
      const { finalizeSession } = await import("./output-tail.js");
      await finalizeSession({
        sessionTempDir: tempDir,
        outputDir: opts.outputDir,
        sessionTs: opts.sessionTs,
        action: opts.action,
        backPageIndices,
        paperless: opts.paperless,
        postProcess: opts.postProcess ?? "none",
        jpegQuality: opts.jpegQuality ?? DEFAULT_JPEG_QUALITY,
        toneCurve: opts.resolveToneCurve?.(ctx),
      });
    }

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
      // Always destroy — final resource cleanup is the engine's job.
      // Adapters that want to no-op a redundant destroy after a polite
      // end() (DONE path) do so via their own clean-close state
      // (e.g. withEsci2UnlockOnDestroy's politelyClosed gate). On raw
      // sockets destroy is what ensures the handle is released when the
      // peer never sends FIN — skipping it would leak one socket per
      // successful scan in the daemon.
      try {
        transport.destroy();
      } catch {
        /* swallow — destroy may throw on already-closed sockets */
      }

      // Post-scan-save fallback (v0.3.0 §3.3) — see Graph.cleanupStates
      // JSDoc for the contract. If finalize itself fails, surface the
      // original error rather than masking it with a finalize-side error.
      if (
        !result.ok &&
        sessionTempDir !== null &&
        pageIndex > 0 &&
        graph.cleanupStates?.has(currentState) &&
        !finalizeAttempted
      ) {
        finalizeAttempted = true;
        void (async () => {
          try {
            await runFinalize(sessionTempDir);
            resolve({ ok: true, finalCtx: ctx });
          } catch {
            // finalizeSession's own `finally` already removes
            // sessionTempDir before throwing — no extra cleanup here.
            resolve(result);
          }
        })();
        return;
      }

      // Non-recovery failure path — make sure flushed temp pages don't
      // outlive the session. Successful DONE goes through doFinalize →
      // finalizeSession (which rms in its own `finally`); only the
      // unrecoverable-error branches leave the dir behind. Best-effort.
      if (!result.ok && sessionTempDir !== null) {
        try {
          fs.rmSync(sessionTempDir, { recursive: true, force: true });
        } catch {
          /* swallow — best-effort cleanup */
        }
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
        // Clear any timer left armed by the prior state. Otherwise a non-flush
        // final transition (e.g. UNLOCKING → DONE) leaves the prior state's
        // timer alive; if doFinalize takes longer than timeoutMs the leftover
        // timer fires "Timeout in state DONE" mid-finalize, races settle, and
        // rms sessionTempDir while finalizeSession is still reading it.
        clearTimeoutTimer();
        // Polite close request; peer may ACK late or never. Real sockets
        // can throw on already-destroyed; swallow so doFinalize still runs.
        try {
          transport.end();
        } catch {
          /* swallow */
        }
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
          await runFinalize(sessionTempDir);
        } catch (err) {
          const reason = err instanceof Error ? err : new Error(String(err));
          settle({ ok: false, reason, finalCtx: ctx });
          return;
        }
      }
      settle({ ok: true, finalCtx: ctx });
    }

    // Error handler — symmetric with the close handler below. The DONE
    // guard matters on plain-TCP variants (ESC/I-2-over-plain ET-2750,
    // legacy ESC/I WF-3620) where the printer firmware can RST the socket
    // after our FIN — a benign post-end event from the engine's point of
    // view, since enterState("DONE") has already scheduled doFinalize.
    // Without the guard, that RST races doFinalize for settle() and would
    // fall through to the unconditional rmSync in settle's failure branch
    // mid-finalize, wiping the captured pages. The TLS path is shielded
    // by withTlsErrorLabels swallowing post-end ECONNRESET/EPIPE, but
    // that adapter doesn't apply to the plain-TCP transports.
    transport.on("error", (err) => {
      if (settled) return;
      if (currentState === "DONE") return; // doFinalize handles this path
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
    function resolveSend(send: SendSpec<Ctx> | SendSpec<Ctx>[] | undefined): Buffer[] {
      if (!send) return [];
      const items = Array.isArray(send) ? send : [send];
      return items.map((s) => (typeof s === "function" ? s(ctx) : s));
    }

    function writeAll(buffers: Buffer[]): void {
      for (const buf of buffers) transport.write(buf);
    }

    /**
     * Async pump loop. Reentrancy is prevented by the `dispatching` guard:
     * concurrent calls (from `'data'` events that fire while the loop is
     * awaiting an applyTransition) short-circuit; the active loop drains
     * any chunks they buffered on its next iteration.
     *
     * The loop checks `paused`, `settled`, `currentState === ""` (initial-
     * entry gate — handles transports that synchronously fire `data` during
     * listener registration, before enterState(graph.initial) has run), and
     * `currentState === "DONE"` at every step — set during a flushPage
     * barrier or after the session is finalized — so a buffered second
     * packet in the same TCP chunk doesn't keep dispatching after the
     * session has already completed or errored.
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
          if (paused || settled || currentState === "" || currentState === "DONE") return;
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
          if (paused || settled || currentState === "" || currentState === "DONE") return;
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
    function tryParseHead(): { type: number; payload: Buffer } | null {
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
      const cap = graph.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
      if (payloadSize > cap) {
        // Framing desync — almost certainly a header byte landed at the
        // wrong offset and we read garbage as the size. Surface the
        // diagnostic immediately so operators don't see a misleading
        // "Timeout in state X" 30 seconds later. Captures the first 32
        // bytes as hex so the report shows what we were looking at.
        const peek = head.subarray(0, Math.min(32, head.length)).toString("hex");
        const capMb = (cap / (1024 * 1024)).toFixed(0);
        settle({
          ok: false,
          reason: new Error(
            `IS payload claims ${payloadSize} bytes, exceeds ${capMb}MB cap — likely framing desync in state ${currentState}. First 32 bytes: ${peek}`,
          ),
          finalCtx: ctx,
        });
        return null;
      }
      const totalSize = IS_HEADER_SIZE + payloadSize;

      if (recvBytes < totalSize) return null; // need more bytes

      // We have the full packet — materialize and peel
      const merged = recvChunks.length === 1 ? recvChunks[0] : Buffer.concat(recvChunks, recvBytes);
      recvChunks.length = 0;
      const payload = merged.subarray(IS_HEADER_SIZE, totalSize);
      const remainder = merged.subarray(totalSize);
      recvBytes = remainder.length;
      if (remainder.length > 0) recvChunks.push(remainder);
      return { type, payload };
    }

    async function dispatchPacket(packet: { type: number; payload: Buffer }): Promise<void> {
      // Step 1: globalIgnoreFilter — silently discard packets the protocol
      // wants to filter pre-dispatch (e.g. ESC/I-2 empty 0xa000 envelopes
      // during image flow). States with `bypassIgnoreFilter: true` opt out
      // — the otherwise-filtered shape is semantically meaningful for them
      // (e.g. POSTSCAN_*_STAT_DRAIN reads the empty 0xa000 as the drain-
      // complete reply), so the filter never runs there.
      const state = graph.states[currentState];
      if (
        graph.globalIgnoreFilter &&
        !state.bypassIgnoreFilter &&
        graph.globalIgnoreFilter(packet)
      ) {
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
      send?: SendSpec<Ctx> | SendSpec<Ctx>[];
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

        // settled-bailouts after each await skip side-effects (file write,
        // staged send, ctx mutation, entering staged next state). They do
        // NOT clear `paused`: once settled is true, the pump's gate checks
        // settled before paused, and the run resolves shortly after — no
        // reader of paused remains. The catch arm below DOES clear paused
        // for flag-consistency since it can race with the pump's own
        // catch path.
        try {
          const jpegBytes = await t.flushPage.encode();
          if (settled) return;

          // Back-page index needed by both the JPG EXIF path and the PDF
          // /Rotate=180 path in finalizeSession.
          if (t.flushPage.side === "back") {
            backPageIndices.push(myPageIndex);
          }

          // EXIF action-gating (spec §3.5 step 5).
          let outputBytes = jpegBytes;
          if (t.flushPage.side === "back" && opts.action === "jpg") {
            const { setJpegOrientation } = await import("./exif.js");
            if (settled) return;
            outputBytes = setJpegOrientation(jpegBytes, 3);
          }

          if (!sessionTempDir) {
            sessionTempDir = await createSessionTempDir(opts.tempDir);
            if (settled) return;
          }
          const filename = `page_${String(myPageIndex).padStart(2, "0")}.jpg`;
          await fs.promises.writeFile(path.join(sessionTempDir, filename), outputBytes);
          if (settled) return;
        } catch (err) {
          paused = false;
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
      // Drain anything queued in recvChunks during listener registration
      // (the pump's empty-state gate held those chunks).
      void tryDispatch();
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
