import tls from "node:tls";
import {
  runScanSession,
  type SessionTransport,
  type SessionTransportFactory,
} from "../scan-session.js";
import { resolveSessionTimestamp } from "../output.js";
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
        ...(session.printerCertFingerprint
          ? {
              checkServerIdentity: (_host, cert) => {
                const got = cert.fingerprint256;
                if (got !== session.printerCertFingerprint) {
                  return new Error(
                    `Printer cert fingerprint mismatch — expected ${session.printerCertFingerprint}, got ${got}`,
                  );
                }
                return undefined;
              },
            }
          : {}),
      };
      const socket = socketFactory(opts, () => resolve(socket as unknown as SessionTransport));
      socket.once("error", reject);
    });
}

export async function runEsci2Scan(
  session: ScanSession,
  socketFactory: TlsSocketFactory = tls.connect,
): Promise<void> {
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
      postScanCycle: 1,
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
