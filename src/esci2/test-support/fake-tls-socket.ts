import type * as tls from "node:tls";
import { FakeSocketBase } from "../../test-support/fake-socket-base.js";

/**
 * Minimal `tls.TLSSocket`-shaped fake driving the ESC/I-2 scanner in
 * tests. Inherits buffering for `data` / `error` events from
 * FakeSocketBase. Adds peer-cert pinning, `end(buf)` half-close-with-
 * payload, and a `waitForWriteCount` predicate the engine's flushPage
 * barrier needs (multi-microtask wire-level wait, not a fixed tick count).
 */
export class FakeTlsSocket extends FakeSocketBase {
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

  end(data?: Buffer): void {
    // tls.TLSSocket.end(data?) writes the buffer (if any) before half-closing.
    // The fake mirrors this so callers can rely on `end(buf)` recording the
    // write for assertions (e.g. unlock-on-abort tests).
    if (data) this.writes.push(Buffer.from(data));
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
