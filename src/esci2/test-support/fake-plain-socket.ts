import type * as net from "node:net";
import { FakeSocketBase } from "../../test-support/fake-socket-base.js";

/**
 * Minimal `net.Socket`-shaped fake driving the ESC/I-2-over-plain-TCP
 * (`runEsci2ScanOverPlain`) path in tests. Mirrors `FakeTlsSocket`'s
 * `waitForWriteCount` predicate and `end(data?)` write-recording so the
 * unlock-on-destroy adapter's destroy-time `inner.end(buildUnlockPacket())`
 * is observable in assertions.
 *
 * Shape note: `FakeTcpSocket` (under `src/esci/test-support/`) drives
 * the WF-3620 plain-TCP path but doesn't model `end(data?)` recording —
 * the ESC/I path doesn't ride on a LOCK / UNLOCK panel-hygiene record.
 * The ESC/I-2-over-plain-TCP path does (via `withEsci2UnlockOnDestroy`),
 * so this fake exists separately rather than reusing the legacy fake.
 */
export class FakePlainSocket extends FakeSocketBase {
  private onConnect?: () => void;

  /** Called by the factory to register the scanner's connect callback. */
  setOnConnect(cb?: () => void): void {
    this.onConnect = cb;
  }

  /** Fire the connect callback — simulates the TCP handshake completing. */
  simulateConnect(): void {
    this.onConnect?.();
  }

  destroy(): void {
    this.emit("close");
  }

  end(data?: Buffer): void {
    // net.Socket.end(data?) writes the buffer (if any) before half-closing.
    // Mirroring the real shape lets unlock-on-abort tests assert that
    // `inner.end(buildUnlockPacket())` was the path taken.
    if (data) this.writes.push(Buffer.from(data));
    this.emit("close");
  }

  /**
   * Resolves once `this.writes.length >= target`. Polls per setImmediate
   * until the target is reached or `timeoutMs` elapses (default 1000 ms).
   *
   * Predicate-based wait, not a fixed `await setImmediate(r)`, because the
   * engine's flushPage barrier is genuinely multi-microtask (await encode →
   * optional async file I/O → unpause → write staged send → enter next
   * state). Tests asserting "FIN follows the page-end feed" shouldn't hard-
   * code a tick count — they wait for the wire-level signal. Also turns
   * "scanner is stuck" into a useful timeout error.
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

  /**
   * Create a `net.connect`-compatible factory that hands out this fake.
   * Use in tests: `runEsci2ScanOverPlain(session, fake.asFactory())`.
   */
  asFactory(): (host: string, port: number, cb?: () => void) => net.Socket {
    return (_host, _port, cb) => {
      this.setOnConnect(cb);
      return this as unknown as net.Socket;
    };
  }
}
