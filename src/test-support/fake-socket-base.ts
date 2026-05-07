import { EventEmitter } from "node:events";

/**
 * Shared base for FakeTcpSocket / FakeTlsSocket. Captures the buffering
 * and replay logic that both fakes need to compensate for the engine's
 * factory-await-yield gap:
 *
 *   - `feed(chunk)` buffers when no `data` listener is attached yet, then
 *     replays via queueMicrotask on first `.on("data", ...)`. Real sockets
 *     buffer received bytes during the connecting state too; without this,
 *     a `simulateConnect(); feed(...)` pair would drop the first packet
 *     because the engine attaches `transport.on("data", ...)` only AFTER
 *     `await transportFactory()` yields a microtask.
 *
 *   - `emit("error", ...)` buffers when only `once`-listeners are present
 *     (e.g. the factory's `socket.once("error", reject)`), then replays
 *     when a persistent listener attaches.
 *
 * Subclasses add the protocol-specific surface: `write` capture,
 * `simulateConnect` shape, `asFactory` signature, and any TLS-only bits
 * (peer-cert pinning, `end(buf)` half-close-with-payload).
 */
export class FakeSocketBase extends EventEmitter {
  readonly writes: Buffer[] = [];

  private pendingChunks: Buffer[] = [];
  private pendingError: Error | null = null;

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
      // Defer to microtask: the engine declares `let dispatching = false`
      // immediately AFTER transport.on("data", ...) registers, so a
      // synchronous replay would dispatch while `dispatching` is still in
      // the temporal dead zone. queueMicrotask also runs before any test
      // setImmediate, preserving ordering vs. live feeds on later iterations.
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

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error" && args.length > 0) {
      const before = this.listenerCount("error");
      const result = super.emit(event, ...args);
      const after = this.listenerCount("error");
      // If the only listener was a `once` (factory's pre-handshake
      // `socket.once("error", reject)`), `before > 0 && after === 0`.
      // The engine's persistent listener hasn't attached yet — buffer for
      // replay on next .on("error", ...) registration. Only a single
      // pre-listener error is buffered; tests don't exercise multi-error
      // races, but if they ever do, this is the place to extend.
      if (before > 0 && after === 0) {
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
}
