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
 * Wraps a tls.TLSSocket so that `destroy()` first attempts a polite UNLOCK
 * write (engine doesn't know about ESC/I-2 protocol cleanup; this keeps the
 * printer's panel from staying in a locked state after a mid-session abort).
 * Best-effort: write errors are swallowed since the socket is being destroyed.
 */
function withUnlockOnDestroy(socket: tls.TLSSocket): SessionTransport {
  let unlockSent = false;
  let lockSent = false;
  const wrapped: SessionTransport = {
    write(buf: Buffer) {
      // Track LOCK / UNLOCK sends by IS type byte (header byte 2-3).
      if (buf.length >= 4 && buf[2] === 0x21) {
        if (buf[3] === 0x00) lockSent = true;
        if (buf[3] === 0x01) unlockSent = true;
      }
      return socket.write(buf);
    },
    end: () => socket.end(),
    destroy(err?: Error) {
      if (lockSent && !unlockSent) {
        try {
          socket.write(buildUnlockPacket());
        } catch {
          /* socket already closed; nothing to do */
        }
      }
      socket.destroy(err);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void) {
      if (event === "error") {
        // Wrap raw socket errors with a "TLS connection error" prefix so
        // operators (and tests) get a recognisable category instead of a
        // bare ECONNRESET / EPIPE / etc. Mirrors the pre-engine scanner.
        socket.on(event, (err: Error) => {
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
