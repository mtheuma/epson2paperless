import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import {
  runScanSession,
  socketAsTransport,
  type SessionTransport,
  type SessionTransportFactory,
} from "../scan-session.js";
import { resolveSessionTimestamp } from "../output.js";
import { esci2Graph, type Esci2Ctx } from "./graph.js";
import { withEsci2UnlockOnDestroy, withTlsErrorLabels } from "./transport.js";
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
 * Factory for the plain TCP socket used by the ET-2750 (`esci2-plain`)
 * variant. Defaults to a lambda over `net.connect(port, host, cb)`.
 * Tests inject a fake here; see src/esci2/test-support/fake-plain-socket.ts.
 */
export type PlainSocketFactory = (host: string, port: number, onConnect?: () => void) => net.Socket;

function validateTempBase(session: ScanSession): void {
  // Stat the temp-dir base before opening any socket so a bad path fails
  // fast — no waiting until first flushPage (which a no-data scan would
  // never reach). One stat-level syscall, no probe directory created.
  const tempBase = session.tempDir || os.tmpdir();
  try {
    fs.accessSync(tempBase, fs.constants.W_OK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create session temp dir under ${tempBase}: ${msg}`);
  }
}

function buildInitialCtx(session: ScanSession, profile: "esci2-tls" | "esci2-plain"): Esci2Ctx {
  return {
    duplex: session.duplex,
    // ET-2750 hardware is flatbed-only; pre-set the source so INIT_POLL's
    // first iteration can still run its source-detect logic, but the
    // graph's flatbed branch is the only valid outcome under
    // `esci2-plain`. ET-4950 keeps the legacy "adf" default which the
    // INIT_POLL_STAT decision overrides per fixture.
    source: profile === "esci2-plain" ? "flatbed" : "adf",
    profile,
    action: session.action,
    initPollIteration: 0,
    imgChunkSize: 0,
    pageEndKind: "none",
    pageSide: "front",
    zeroImgRetries: 0,
    imageChunks: [],
    tprDeclaredLength: 0,
    infoBody: Buffer.alloc(0),
    capaBody: Buffer.alloc(0),
    dialect: undefined,
  };
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
        // Composition order matters: the unlock wrapper is OUTER so its
        // destroy-time `inner.end(buildUnlockPacket())` flows through the
        // TLS-error wrapper's `end(data?)`, setting that wrapper's
        // `endCalled = true` before the bytes leave the host. Without that
        // ordering, a printer-side RST during the close handshake could
        // surface as a labelled error instead of being swallowed.
        resolve(withEsci2UnlockOnDestroy(withTlsErrorLabels(socketAsTransport(socket))));
      });
      socket.once("error", reject);
    });
}

function makePlainEsci2TransportFactory(
  session: ScanSession,
  socketFactory: PlainSocketFactory,
): SessionTransportFactory {
  return () =>
    new Promise<SessionTransport>((resolve, reject) => {
      // Plain TCP — no TLS layer to label or to swallow post-FIN resets
      // from. Compose only the unlock adapter so panel hygiene
      // (UNLOCK-on-abort, polite end before destroy) still works the
      // same as the TLS path. Cert fingerprint is meaningless here and
      // is rejected at config-time when paired with `esci2-plain`.
      const socket = socketFactory(session.printerIp, session.port, () => {
        resolve(withEsci2UnlockOnDestroy(socketAsTransport(socket)));
      });
      socket.once("error", reject);
    });
}

/**
 * Run an ESC/I-2 scan over TLS (port 1865, ET-4950 family).
 */
export async function runEsci2Scan(
  session: ScanSession,
  socketFactory: TlsSocketFactory = tls.connect,
): Promise<void> {
  validateTempBase(session);

  const result = await runScanSession<Esci2Ctx>({
    graph: esci2Graph,
    initialCtx: buildInitialCtx(session, "esci2-tls"),
    transportFactory: makeTlsTransportFactory(session, socketFactory),
    outputDir: session.outputDir,
    tempDir: session.tempDir,
    sessionTs: resolveSessionTimestamp(new Date(), session.outputDir),
    action: session.action,
    paperless: session.paperless,
  });
  if (!result.ok) throw result.reason;
}

/**
 * Run an ESC/I-2 scan over plain TCP (port 1865, ET-2750). Same
 * graph and command vocabulary as `runEsci2Scan`; the only differences
 * are at the socket layer (no TLS) and in the PARA payload (selected
 * by `ctx.profile = "esci2-plain"`). ET-2750 is flatbed-only hardware,
 * so the graph's ADF branches are unreachable under this entry point.
 */
export async function runEsci2ScanOverPlain(
  session: ScanSession,
  socketFactory: PlainSocketFactory = (host, port, cb) => net.connect(port, host, cb),
): Promise<void> {
  validateTempBase(session);

  const result = await runScanSession<Esci2Ctx>({
    graph: esci2Graph,
    initialCtx: buildInitialCtx(session, "esci2-plain"),
    transportFactory: makePlainEsci2TransportFactory(session, socketFactory),
    outputDir: session.outputDir,
    tempDir: session.tempDir,
    sessionTs: resolveSessionTimestamp(new Date(), session.outputDir),
    action: session.action,
    paperless: session.paperless,
  });
  if (!result.ok) throw result.reason;
}
