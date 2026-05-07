import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import {
  runScanSession,
  type SessionTransport,
  type SessionTransportFactory,
} from "../scan-session.js";
import { resolveSessionTimestamp } from "../output.js";
import { esci2Graph, type Esci2Ctx } from "./graph.js";
import { withEsci2UnlockOnDestroy } from "./transport.js";
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
        resolve(withEsci2UnlockOnDestroy(socket));
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
