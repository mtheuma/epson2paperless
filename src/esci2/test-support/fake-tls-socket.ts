import { EventEmitter } from "node:events";
import type * as tls from "node:tls";

/**
 * Minimal duplex-ish object that looks enough like a `tls.TLSSocket` to
 * drive `scanner.ts`'s state machine in tests. Captures every `.write()`
 * call as a Buffer; tests feed receive data via `feed()`. No TLS, no real
 * socket.
 *
 * Casting: `socketFactory` in scanner.ts expects a `tls.TLSSocket`. We
 * return this via `as unknown as tls.TLSSocket` in tests.
 */
export class FakeTlsSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  private onSecureConnect?: () => void;
  private peerCertFingerprint: string | null = null;

  /** Set the fingerprint that getPeerCertificate() returns. Use null to simulate a missing cert. */
  setPeerCertificate(fingerprint: string | null): void {
    this.peerCertFingerprint = fingerprint;
  }

  getPeerCertificate(_detailed?: boolean): tls.PeerCertificate {
    return { fingerprint256: this.peerCertFingerprint } as unknown as tls.PeerCertificate;
  }

  destroy(): void {
    this.emit("close");
  }

  /** Called by the factory to register the scanner's connect callback. */
  setOnConnect(cb?: () => void): void {
    this.onSecureConnect = cb;
  }

  /** Fire the secure-connect callback — simulates TLS handshake completing. */
  simulateConnect(): void {
    this.onSecureConnect?.();
  }

  private pendingChunks: Buffer[] = [];
  private pendingError: Error | null = null;

  /**
   * Feed bytes as if the remote side sent them. If no `"data"` listener is
   * attached yet, buffer the chunk and replay synchronously when one
   * attaches via `on("data", ...)`. This matches real TCP/TLS socket
   * behaviour where bytes received in the connecting state are buffered
   * until the application starts reading. Without this, tests that call
   * `simulateConnect(); feed(...)` synchronously would drop the first
   * packet because the engine's `transport.on("data", ...)` registration
   * happens on the next microtask after `await transportFactory()`.
   */
  feed(chunk: Buffer): void {
    if (this.listenerCount("data") > 0) {
      this.emit("data", chunk);
    } else {
      this.pendingChunks.push(chunk);
    }
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === "data" && this.pendingChunks.length > 0) {
      const chunks = this.pendingChunks;
      this.pendingChunks = [];
      // Defer the replay to the microtask queue. Two reasons:
      //   1. The engine declares `let dispatching = false` AFTER
      //      `transport.on("data", ...)` registers, so a synchronous
      //      replay would call `tryDispatch()` while `dispatching` is
      //      still in the temporal dead zone.
      //   2. We need the replay to run BEFORE the test's next
      //      `await new Promise(r => setImmediate(r))` resolves —
      //      otherwise live feeds on the next iteration arrive in
      //      `recvChunks` ahead of the buffered chunks, scrambling
      //      packet order. queueMicrotask runs in the microtask phase
      //      (immediately after the engine's setup body completes,
      //      before any setImmediate fires), which preserves order.
      queueMicrotask(() => {
        for (const chunk of chunks) this.emit("data", chunk);
      });
    }
    if (event === "error" && this.pendingError !== null) {
      const err = this.pendingError;
      this.pendingError = null;
      queueMicrotask(() => this.emit("error", err));
    }
    return this;
  }

  /**
   * Override emit() so that an "error" emitted before any non-once listener
   * is registered (e.g., the test calls `fake.emit("error", ...)` between
   * simulateConnect and the engine attaching its error listener via
   * `transport.on("error", ...)` after `await transportFactory()` resolves)
   * gets buffered and replayed when the listener attaches. Mirrors the data
   * buffering above, for the same reason: real sockets buffer errors during
   * the connecting state too.
   */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error" && args.length > 0) {
      // Count listeners EXCLUDING the factory's `once("error", reject)` which
      // is attached pre-handshake. Heuristic: if the only listener is one
      // attached via `once()` (we can't distinguish reliably), the error may
      // still be lost on the engine. Simplest robust check: if listener
      // count drops to 0 after emit (because once removes itself), buffer
      // for replay when a future on() registers.
      const before = this.listenerCount("error");
      const result = super.emit(event, ...args);
      const after = this.listenerCount("error");
      if (before > 0 && after === 0) {
        // Only `once` listeners were present; the engine hasn't attached
        // its persistent listener yet. Buffer the error for replay.
        this.pendingError = args[0] as Error;
      }
      return result;
    }
    return super.emit(event, ...args);
  }

  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }

  /**
   * Resolves once `this.writes.length >= target`. Polls per setImmediate
   * until the target is reached or `timeoutMs` elapses (default 1000 ms).
   *
   * Why a predicate-based wait instead of a fixed `await setImmediate(r)`?
   * The engine's flushPage barrier is genuinely multi-microtask (await
   * encode → optionally async file I/O → unpause → write staged send →
   * enter next state). Tests that assert "FIN follows the page-end feed"
   * shouldn't hard-code a tick count — they should wait for the wire-level
   * promise. This also turns "scanner is stuck" into a useful timeout
   * error instead of an opaque assertion failure.
   */
  async waitForWriteCount(target: number, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 1000;
    const start = Date.now();
    while (this.writes.length < target) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `waitForWriteCount: expected ${target} writes within ${timeoutMs}ms, got ${this.writes.length}`,
        );
      }
      await new Promise((r) => setImmediate(r));
    }
  }

  end(): void {
    this.emit("close");
  }

  /**
   * Create a `tls.connect`-compatible factory that hands out this fake.
   * Use in tests: `runEsci2Scan(session, fake.asFactory())`.
   */
  asFactory(): (options: tls.ConnectionOptions, cb?: () => void) => tls.TLSSocket {
    return (_options, cb) => {
      this.setOnConnect(cb);
      return this as unknown as tls.TLSSocket;
    };
  }
}
