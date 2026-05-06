// src/scan-session.ts

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
  | { kind: "static"; on: Record<number, StaticTransition<Ctx>> }
  | { kind: "decision"; decide: DecisionFn<Ctx> };

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

export type StateDef<Ctx> = { on: Record<number, StaticTransition<Ctx>> } | DecisionDef<Ctx>;

export interface DecisionDef<Ctx> {
  __decision: true;
  decide: DecisionFn<Ctx>;
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
        states[name] = { kind: "decision", decide: def.decide };
      } else {
        states[name] = { kind: "static", on: def.on };
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
      }) as Graph<Ctx>;
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
  _opts: RunScanSessionOpts<Ctx>,
): Promise<RunScanSessionResult<Ctx>> {
  // Implemented in subsequent tasks.
  throw new Error("runScanSession not yet implemented");
}
