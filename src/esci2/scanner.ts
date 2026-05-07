import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import {
  runScanSession,
  type SessionTransport,
  type SessionTransportFactory,
} from "../scan-session.js";
import { resolveSessionTimestamp } from "../output.js";
import { buildUnlockPacket } from "../protocol.js";
import { esci2Graph, type Esci2Ctx } from "./graph.js";
import type { PaperlessUploadOptions } from "../paperless-upload.js";

export interface ScanSession {
  printerIp: string;
  port: number;
  destId: number;
  outputDir: string;
  /** Base directory for per-session temp spill; "" means `os.tmpdir()` at runtime. */
  tempDir: string;
  duplex: boolean;
  /** Effective output format, already resolved against PREVIEW_ACTION. */
  action: "jpg" | "pdf";
  paperless?: PaperlessUploadOptions;
  printerCertFingerprint?: string;
}

/**
 * Factory for the TLS socket. Defaults to `tls.connect`. Tests inject a
 * fake here; see src/esci2/test-support/fake-tls-socket.ts.
 */
export type TlsSocketFactory = (
  options: tls.ConnectionOptions,
  onSecureConnect?: () => void,
) => tls.TLSSocket;

/**
 * Wraps a tls.TLSSocket with three protocol-aware concerns the generic
 * engine doesn't know about:
 *
 * 1. **Unlock on abort.** If the engine destroys the transport mid-session
 *    (after LOCK was sent but before the graph reached UNLOCKING),
 *    politely send the UNLOCK packet via `socket.end(unlock)` so the bytes
 *    actually leave the host before the socket closes — `socket.destroy()`
 *    can otherwise discard queued writes or send a TCP reset.
 *
 * 2. **TLS-error wrapping.** Bare ECONNRESET / EPIPE / etc. surfaces as
 *    "TLS connection error: <msg>" so operators (and tests) get a
 *    recognisable category.
 *
 * 3. **Suppress benign post-end errors.** Once the engine has called
 *    `transport.end()` (which only happens on entering DONE), the printer
 *    may still RST or EPIPE before its FIN reaches the host. Forwarding
 *    that to the engine would turn a successful scan into a rejection.
 *    The wrapper swallows those benign codes after end() has been called.
 */
export function withUnlockOnDestroy(socket: tls.TLSSocket): SessionTransport {
  let unlockSent = false;
  let lockSent = false;
  // Tracks any teardown so post-close ECONNRESET / EPIPE noise can be
  // swallowed. Set by both end() and destroy().
  let endCalled = false;
  // Tracks specifically whether we already initiated a graceful close
  // via end(). The engine calls transport.destroy() from settle even on
  // healthy DONE (after end()), and a socket.destroy() there would RST
  // the connection mid-TLS-close_notify and cancel the FIN we politely
  // queued — reintroducing timing-dependent panel errors. When this is
  // true, destroy() is a no-op and the graceful close completes on its
  // own clock.
  let politelyClosed = false;
  const wrapped: SessionTransport = {
    write(buf: Buffer) {
      // Track LOCK / UNLOCK sends by IS type byte (header byte 2-3).
      if (buf.length >= 4 && buf[2] === 0x21) {
        if (buf[3] === 0x00) lockSent = true;
        if (buf[3] === 0x01) unlockSent = true;
      }
      return socket.write(buf);
    },
    end: () => {
      endCalled = true;
      politelyClosed = true;
      socket.end();
    },
    destroy(err?: Error) {
      if (politelyClosed) return;
      endCalled = true;
      if (lockSent && !unlockSent) {
        // Mid-session error: send unlock then half-close, so the bytes
        // actually leave the host. Plain `write` + immediate `destroy`
        // can discard queued bytes or send TCP RST.
        try {
          socket.end(buildUnlockPacket());
        } catch {
          socket.destroy(err);
        }
      } else if (lockSent && unlockSent) {
        // Cleanup-state error after UNLOCK was already on the wire
        // (e.g., bad ack on the unlock reply, timeout in UNLOCKING,
        // async fatal during POSTSCAN drain). Application-layer
        // protocol close has happened — graceful TCP/TLS close
        // preserves close_notify timing, which the legacy scanner
        // relied on for panel hygiene.
        try {
          socket.end();
        } catch {
          socket.destroy(err);
        }
      } else {
        // Never locked — straight destroy is fine, no protocol state
        // to preserve.
        socket.destroy(err);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void) {
      if (event === "error") {
        socket.on(event, (err: Error & { code?: string }) => {
          // Suppress benign post-end resets so a printer that closes the
          // connection between our FIN and its FIN doesn't fail an
          // otherwise-successful scan. Mirrors the pre-engine scanner's
          // post-DONE error tolerance.
          if (endCalled && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
            return;
          }
          cb(new Error(`TLS connection error: ${err.message}`));
        });
      } else {
        socket.on(event, cb);
      }
      return wrapped;
    },
  };
  return wrapped;
}

function makeTlsTransportFactory(
  session: ScanSession,
  socketFactory: TlsSocketFactory,
): SessionTransportFactory {
  return () =>
    new Promise<SessionTransport>((resolve, reject) => {
      const opts: tls.ConnectionOptions = {
        host: session.printerIp,
        port: session.port,
        rejectUnauthorized: false,
        // Epson ScanSmart picks the SNI name from the destination ID byte.
        // Real printers refuse the handshake without it; the fake ignores
        // these options so replay tests pass either way.
        servername: String.fromCharCode(session.destId),
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
      };
      const socket = socketFactory(opts, () => {
        // Manual fingerprint pin (TLS's `checkServerIdentity` isn't fired by
        // the fake socket used in tests). Mirrors the pre-engine scanner's
        // pattern: read the peer cert, compare to the configured pin, reject
        // the factory Promise on mismatch — engine then settles { ok: false,
        // reason } per spec §3.6.
        if (session.printerCertFingerprint) {
          const peer = socket.getPeerCertificate?.();
          const actual = peer?.fingerprint256;
          if (actual !== session.printerCertFingerprint) {
            socket.destroy();
            reject(
              new Error(
                `Printer cert fingerprint mismatch — expected ${session.printerCertFingerprint}, got ${actual ?? "(none)"}`,
              ),
            );
            return;
          }
        }
        resolve(withUnlockOnDestroy(socket));
      });
      socket.once("error", reject);
    });
}

export async function runEsci2Scan(
  session: ScanSession,
  socketFactory: TlsSocketFactory = tls.connect,
): Promise<void> {
  // Validate the temp dir base before opening the TLS connection so a bad
  // path fails fast (rather than waiting until first flushPage, which a
  // no-data scan would never reach). One stat-level syscall — no probe
  // directory is created.
  const tempBase = session.tempDir || os.tmpdir();
  try {
    fs.accessSync(tempBase, fs.constants.W_OK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create session temp dir under ${tempBase}: ${msg}`);
  }

  const result = await runScanSession<Esci2Ctx>({
    graph: esci2Graph,
    initialCtx: {
      duplex: session.duplex,
      source: "adf",
      initPollIteration: 0,
      imgChunkSize: 0,
      pageEndKind: "none",
      pageSide: "front",
      zeroImgRetries: 0,
      imageChunks: [],
      tprDeclaredLength: 0,
    },
    transportFactory: makeTlsTransportFactory(session, socketFactory),
    outputDir: session.outputDir,
    tempDir: session.tempDir,
    sessionTs: resolveSessionTimestamp(new Date(), session.outputDir),
    action: session.action,
    paperless: session.paperless,
  });
  if (!result.ok) throw result.reason;
}
