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

  /** Feed bytes as if the remote side sent them. */
  feed(chunk: Buffer): void {
    this.emit("data", chunk);
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
   * Use in tests: `startScanSession(session, fake.asFactory())`.
   */
  asFactory(): (options: tls.ConnectionOptions, cb?: () => void) => tls.TLSSocket {
    return (_options, cb) => {
      this.setOnConnect(cb);
      return this as unknown as tls.TLSSocket;
    };
  }
}
