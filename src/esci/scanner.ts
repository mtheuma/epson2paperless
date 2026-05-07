import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import {
  runScanSession,
  type SessionTransport,
  type SessionTransportFactory,
} from "../scan-session.js";
import { resolveSessionTimestamp } from "../output.js";
import { esciGraph, type EsciCtx } from "./graph.js";
import type { Source, Format } from "./commands.js";
import type { PaperlessUploadOptions } from "../paperless-upload.js";

export { appendImageChunk } from "./graph.js";

export interface LegacyScanSession {
  printerIp: string;
  port: number;
  outputDir: string;
  /** Base directory for per-session temp spill; "" means `os.tmpdir()` at runtime. */
  tempDir: string;
  /** Panel-side Sides selection (true → 2-Sided). Source detected from FS F. */
  duplex: boolean;
  /** Override for FS F autodetection — set via ESCI_FORCE_SOURCE env var. */
  forcedSource: Source | null;
  format: Format;
  jpegQuality: number;
  paperless?: PaperlessUploadOptions;
  /**
   * When true, a non-ACK reply to ESC @ triggers an additional FS Y probe
   * (the ET-4950 ESC/I-2 path's first command) before the session fails.
   * Used to classify printers stuck between ESC/I and ESC/I-2.
   */
  diagnoseProtocol?: boolean;
  /**
   * Test-only hook fired once when STATUS_2 has decided the source (either
   * from the FS F byte via legacyDetectSource or from forcedSource). Lets
   * the replay-test matrix assert per-fixture detection without needing a
   * mutable return value. Production code does not pass this.
   */
  onSourceDetected?: (source: Source) => void;
}

export type TcpSocketFactory = (host: string, port: number, onConnect?: () => void) => net.Socket;

function makeTcpTransportFactory(
  session: LegacyScanSession,
  socketFactory: TcpSocketFactory,
): SessionTransportFactory {
  return () =>
    new Promise<SessionTransport>((resolve, reject) => {
      // net.Socket structurally satisfies SessionTransport; plain TCP needs
      // no app-level wrapper (no TLS pin, no unlock-on-destroy semantics
      // peculiar to ESC/I-2). If a future ESC/I quirk needs one, introduce
      // a sibling src/esci/transport.ts.
      const socket = socketFactory(session.printerIp, session.port, () => {
        resolve(socket);
      });
      socket.once("error", reject);
    });
}

export async function runEsciScan(
  session: LegacyScanSession,
  socketFactory: TcpSocketFactory = (host, port, cb) => net.connect(port, host, cb),
): Promise<void> {
  // Validate the temp-dir base before opening the TCP connection so a bad
  // path fails fast (rather than at first flushPage).
  const tempBase = session.tempDir || os.tmpdir();
  try {
    fs.accessSync(tempBase, fs.constants.W_OK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create session temp dir under ${tempBase}: ${msg}`);
  }

  const result = await runScanSession<EsciCtx>({
    graph: esciGraph,
    initialCtx: {
      duplex: session.duplex,
      forcedSource: session.forcedSource,
      // Safe default — STATUS_2 overwrites this from the FS F byte (or
      // forcedSource) before any state downstream reads it.
      source: session.forcedSource ?? "adf-simplex",
      format: session.format,
      jpegQuality: session.jpegQuality,
      diagnoseProtocol: session.diagnoseProtocol ?? false,
      onSourceDetected: session.onSourceDetected,
      inInterPageLoop: false,
      pageCount: 0,
      gammaChannelIdx: 0,
      geom: null,
      imageBuffer: Buffer.alloc(0),
      imageBufferOffset: 0,
    },
    transportFactory: makeTcpTransportFactory(session, socketFactory),
    outputDir: session.outputDir,
    tempDir: session.tempDir,
    sessionTs: resolveSessionTimestamp(new Date(), session.outputDir),
    action: session.format === "pdf" ? "pdf" : "jpg",
    paperless: session.paperless,
  });
  if (!result.ok) throw result.reason;
}
