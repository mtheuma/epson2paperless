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
    return this;
  }

  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data));
    return true;
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
