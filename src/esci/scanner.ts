import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import {
  runScanSession,
  socketAsTransport,
  type SessionTransport,
  type SessionTransportFactory,
} from "../scan-session.js";
import { resolveSessionTimestamp } from "../output.js";
import { esciGraph, type EsciCtx } from "./graph.js";
import type { Source, Format } from "./commands.js";
import type { PaperlessUploadOptions } from "../paperless-upload.js";
import { withRawSocketCleanClose } from "./transport.js";
import type { PostProcessProfile } from "../postprocess/index.js";
import type { GrayscaleConversion } from "../config.js";
import type { LegacyDialectEntry } from "./dialects/entry.js";

export { appendImageChunk } from "./graph.js";

export interface LegacyScanSession {
  printerIp: string;
  port: number;
  outputDir: string;
  /** Base directory for per-session temp spill; "" means `os.tmpdir()` at runtime. */
  tempDir: string;
  /** Resolved per-model dialect record; see src/esci/dialects/. */
  entry: LegacyDialectEntry;
  /** Panel-side Sides selection (true → 2-Sided). Source detected from FS F. */
  duplex: boolean;
  /** Override for FS F autodetection — set via ESCI_FORCE_SOURCE env var. */
  forcedSource: Source | null;
  format: Format;
  jpegQuality: number;
  postProcess?: PostProcessProfile;
  /**
   * Finalize-time greyscale pass (default "off"). The legacy wire has no
   * greyscale request, so the dispatcher resolves SCAN_COLOR_MODE=grayscale
   * to "force" (convert every page) and =auto to "auto" (per-page verdict).
   */
  grayscaleConversion?: GrayscaleConversion;
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
      // socketAsTransport bridges net.Socket → SessionTransport (its
      // end() overload set isn't a structural subtype). withRawSocketCleanClose
      // adds the polite-close gate so the engine's mandatory post-DONE
      // destroy() doesn't RST the printer mid-FIN handshake (issue #72,
      // symmetric to the TLS path's withEsci2UnlockOnDestroy gate).
      const socket = socketFactory(session.printerIp, session.port, () => {
        resolve(withRawSocketCleanClose(socketAsTransport(socket)));
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

  // Reject an ESCI_FORCE_SOURCE the dialect can't actually service up front
  // (e.g. XP-620 has no ADF) rather than letting the wire session desync
  // partway through a command sequence the printer doesn't support.
  const fixedFlatbed = session.entry.sourcePolicy === "fixed-flatbed";
  if (session.forcedSource && !session.entry.supportedSources.includes(session.forcedSource)) {
    const supported = session.entry.supportedSources.join(", ");
    throw new Error(
      `ESCI_FORCE_SOURCE=${session.forcedSource} is not supported by ${session.entry.name} ` +
        `(supports: ${supported}). Unset ESCI_FORCE_SOURCE or set it to one of the supported sources.`,
    );
  }

  const result = await runScanSession<EsciCtx>({
    graph: esciGraph,
    initialCtx: {
      entry: session.entry,
      duplex: session.duplex,
      forcedSource: session.forcedSource,
      // Safe default — STATUS_2 overwrites this from the FS F byte (or
      // forcedSource) before any state downstream reads it, UNLESS the
      // entry is fixed-flatbed, in which case there's no FS F detection
      // to run and the source is pinned outright. The `sourceDetected`
      // flag below disambiguates "this default" from "STATUS_2 actually
      // ran" so the shell only fires onSourceDetected on success paths.
      source: fixedFlatbed ? "flatbed" : (session.forcedSource ?? "adf-simplex"),
      sourceDetected: fixedFlatbed ? true : false,
      format: session.format,
      jpegQuality: session.jpegQuality,
      diagnoseProtocol: session.diagnoseProtocol ?? false,
      inInterPageLoop: false,
      pageCount: 0,
      gammaChannelIdx: 0,
      geom: null,
      imageBuffer: Buffer.alloc(0),
      imageBufferOffset: 0,
      deferredImageChunks: [],
    },
    transportFactory: makeTcpTransportFactory(session, socketFactory),
    outputDir: session.outputDir,
    tempDir: session.tempDir,
    sessionTs: resolveSessionTimestamp(new Date(), session.outputDir),
    action: session.format === "pdf" ? "pdf" : "jpg",
    paperless: session.paperless,
    postProcess: session.postProcess ?? "none",
    jpegQuality: session.jpegQuality,
    // Known up front on this path (no dialect-dependent wire capability),
    // but the engine resolves it from the ctx like the tone curve.
    resolveGrayscaleConversion: () => session.grayscaleConversion ?? "off",
  });

  // Fire the public onSourceDetected hook only on success paths AND only
  // when STATUS_2 actually ran. Production callers don't pass this hook;
  // the replay-test matrix uses it to assert per-fixture detection.
  if (result.ok && result.finalCtx.sourceDetected) {
    session.onSourceDetected?.(result.finalCtx.source);
  }

  if (!result.ok) throw result.reason;
}
