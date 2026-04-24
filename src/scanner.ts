import tls from "node:tls";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";
import {
  IS_HEADER_SIZE,
  parseIsPacket,
  buildLockPacket,
  buildUnlockPacket,
  buildPassthruPacket,
  buildPurereadPacket,
} from "./protocol.js";
import {
  buildFsY,
  buildFsX,
  buildFsZ,
  buildEsci2Command,
  buildParaHeader,
  buildParaPayload,
  parseEsci2ReplyHeader,
  parseTokens,
} from "./esci.js";
import {
  generateFilename,
  resolveSessionTimestamp,
  writeOutputFile,
  promoteTempPagesToOutput,
} from "./output.js";
import { setJpegOrientation } from "./exif.js";
import { composePdfFromJpegs } from "./pdf.js";
import { uploadAllToPaperless, type PaperlessUploadOptions } from "./paperless-upload.js";

const log = createLogger("scanner");

export interface ScanSession {
  printerIp: string;
  port: number;
  destId: number;
  outputDir: string;
  /** Base directory for per-session temp spill; "" means `os.tmpdir()` at runtime. */
  tempDir: string;
  /**
   * When true, `PARA` announces `#ADFDPLX` (940 bytes, 0x3AC) so the
   * scanner feeds both sides of each sheet through the ADF. When false,
   * the simplex `#ADF` variant is sent (936 bytes, 0x3A8). Sourced from
   * the printer panel's Sides selection, exposed by `parsePushScanRequest`.
   */
  duplex: boolean;
  /** Effective output format, already resolved against PREVIEW_ACTION. */
  action: "jpg" | "pdf";
  /**
   * Optional Paperless-ngx upload config. When present, each output file
   * is POSTed to Paperless-ngx after being written locally. Absent means
   * no upload — current default behaviour preserved.
   */
  paperless?: PaperlessUploadOptions;
}

/**
 * Factory for the TLS socket. Defaults to `tls.connect`. Tests inject a
 * fake here; see src/test-support/fake-tls-socket.ts.
 */
export type TlsSocketFactory = (
  options: tls.ConnectionOptions,
  onSecureConnect?: () => void,
) => tls.TLSSocket;

// prettier-ignore
type State =
  | "CONNECTING"
  | "WELCOME"
  | "LOCKING"
  | "INIT1_FS_Y"       // cycle 1: awaiting FS Y ACK
  | "INIT1_FIN"        // cycle 1: awaiting FIN reply
  | "INIT2_FS_Z"       // cycle 2: awaiting FS Z ACK
  | "INIT2_FIN"        // cycle 2: awaiting FIN reply
  | "INIT_POLL_FS_Y"
  | "INIT_POLL_STAT"
  | "INIT_POLL_STAT_DRAIN"  // drain queued status when STAT reply declares length > 0
  | "INIT_POLL_FIN"
  | "MODE_SWITCH"
  | "POST_MODE_STAT"
  | "POST_MODE_STAT_DRAIN"  // drain queued status when STAT reply declares length > 0
  | "PARA"
  | "TRDT"
  | "IMG_META"
  | "IMG_DATA"
  | "FIN_AFTER_IMG"
  // Post-scan drain — mimics the Windows driver's cleanup (Frida capture
  // records 4928-4956). After the post-IMG FIN, the driver runs the
  // sequence `FS Y → STAT → pure-read → FIN` TWICE, then Unlock. Without
  // the drain the printer has a pending status message (e.g. #ERRADF PE)
  // un-consumed and surfaces "Scanning Error" on its panel.
  | "POSTSCAN_FS_Y_1"    // legacy FS Y → 1-byte ACK
  | "POSTSCAN_STAT_1"    // STAT → status reply
  | "POSTSCAN_DRAIN_1"   // pure-read(12) → receives pending status
  | "POSTSCAN_FIN_1"     // FIN → ack
  | "POSTSCAN_FS_Y_2"    // second cycle starts here
  | "POSTSCAN_STAT_2"
  | "POSTSCAN_DRAIN_2"
  | "POSTSCAN_FIN_2"
  | "UNLOCKING"
  | "DONE"
  | "ERROR"
  // Two-phase ESC/I-2 read states (used by beginTwoPhaseRead helper):
  | "TPR_META"   // awaiting 64-byte reply with declared length
  | "TPR_DATA"; // awaiting N-byte data body

const INIT_POLL_ITERATIONS = 3;
const TIMEOUT_MS = 30_000;
// All ESC/I-2 passthru replies share a 64-byte envelope; legacy ESC/I acks (FS Y / FS X) are 1 byte (0x06).
const ESCI2_REPLY_SIZE = 64;
const LEGACY_REPLY_SIZE = 1;
// Windows driver capture showed 471 consecutive zero-length IMG replies
// before the first data chunk (~9.4s @ ~20ms per poll). 2000 gives us
// ~40s of headroom which accommodates slower scan starts safely.
const MAX_ZERO_IMG_RETRIES = 2000;

// Async-event dispatch bytes (type 0x9000 body[0]).
// Source: docs/research/ghidra-es2command-readflow.md
const ASYNC_FATAL = new Set([0x02 /* Disconnect */, 0x80 /* Timeout */, 0xa0 /* ServerError */]);
const ASYNC_CANCEL = new Set([0x03 /* ScanCancel */]);

export function startScanSession(
  session: ScanSession,
  socketFactory: TlsSocketFactory = tls.connect,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const resolveOnce = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    let state: State = "CONNECTING";
    // Accumulator for bytes received from the scanner. Chunks are appended as
    // they arrive and only materialized (Buffer.concat) once we have enough
    // bytes for a full IS packet — avoiding O(N²) re-copying while buffering
    // multi-MB IMG_DATA pure-reads that arrive in many TCP segments.
    const recvChunks: Buffer[] = [];
    let recvBytes = 0;
    const imageChunks: Buffer[] = [];
    const sessionTs = resolveSessionTimestamp(new Date(), session.outputDir);
    const tempBase = session.tempDir || os.tmpdir();
    let sessionTempDir: string;
    try {
      sessionTempDir = fs.mkdtempSync(path.join(tempBase, "epson2paperless-"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to create session temp dir under ${tempBase}: ${msg}. Aborting scan.`);
      resolveOnce();
      return; // never start the TLS session
    }
    log.debug(`Session temp dir: ${sessionTempDir}`);
    let pageIndex = 1;
    let initPollIteration = 0;
    let imgChunkSize = 0; // set by IMG_META → consumed by IMG_DATA
    // "none" while a page is still streaming; "more" at the page boundary when
    // another page follows (#pen without #lft); "last" at the final page end
    // (#pen with #lft). Set in IMG_META, consumed in IMG_DATA or in the same
    // handler for zero-length replies.
    let pageEndKind: "none" | "more" | "last" = "none";
    // Tracks the side emitted by the CURRENT in-progress page. Set in IMG_META
    // from the #typ token ("IMGA" / "IMGB"). Simplex scans never emit #typIMGB,
    // so this stays at "front" for them and the EXIF-injection branch naturally
    // no-ops. Consumed at flush time.
    let pageSide: "front" | "back" = "front";
    const backPageIndices: number[] = [];
    let zeroImgRetries = 0;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let source: "adf" | "flatbed" = "adf";

    // Active two-phase-read context; null outside a TPR call.
    type TprCtx = {
      command: "INFO" | "CAPA" | "RESA";
      declaredLength: number;
      onComplete: () => void;
    };
    let tprCtx: TprCtx | null = null;

    const resetTimeout = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        log.error(`Timeout in state ${state} — no response in ${TIMEOUT_MS}ms`);
        transitionToError();
      }, TIMEOUT_MS);
    };

    const clearTimeoutTimer = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    log.info(`Connecting TLS to ${session.printerIp}:${session.port}`);

    const socket = socketFactory(
      {
        host: session.printerIp,
        port: session.port,
        rejectUnauthorized: false,
        servername: String.fromCharCode(session.destId),
        maxVersion: "TLSv1.2",
        minVersion: "TLSv1.2",
      },
      () => {
        log.info("TLS connection established");
        state = "WELCOME";
        resetTimeout();
      },
    );

    const send = (data: Buffer, label: string) => {
      log.debug(
        `SEND [${label}] ${data.length} bytes: ${data.subarray(0, 48).toString("hex")}${data.length > 48 ? "..." : ""}`,
      );
      socket.write(data);
      resetTimeout();
    };

    const transitionToError = () => {
      clearTimeoutTimer();
      if (state === "ERROR" || state === "DONE") return;
      // If we've already captured a complete image (IMG loop ended with #pen
      // and we're now in the post-scan drain), save the image anyway. The
      // drain is cosmetic for the printer panel — our scan file is valid.
      const priorState = state;
      const inPostScan = priorState.startsWith("POSTSCAN_") || priorState === "UNLOCKING";
      state = "ERROR";
      if (inPostScan && imageChunks.length > 0) {
        log.warn(`Error during post-scan cleanup in ${priorState} — saving captured image anyway`);
        finalizeScan();
        return;
      }
      try {
        socket.write(buildUnlockPacket());
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(sessionTempDir, { recursive: true, force: true });
      } catch {
        /* ignore — cleanup best-effort */
      }
      socket.end();
    };

    socket.on("data", (chunk: Buffer) => {
      log.debug(
        `RECV ${chunk.length} bytes in state ${state}: ${chunk.subarray(0, 48).toString("hex")}${chunk.length > 48 ? "..." : ""}`,
      );
      recvChunks.push(chunk);
      recvBytes += chunk.length;
      processBuffer();
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (state === "DONE" && err.code === "ECONNRESET") {
        log.debug("Benign post-unlock ECONNRESET (scan already saved)");
        clearTimeoutTimer();
        return;
      }
      log.error(`TLS connection error in state ${state}`, err);
      clearTimeoutTimer();
      if (state !== "ERROR" && state !== "DONE") {
        transitionToError();
      }
    });

    socket.on("close", () => {
      clearTimeoutTimer();
      log.info("TLS connection closed");
      resolveOnce();
    });

    function processBuffer(): void {
      // Parse one IS packet at a time. Return early if we need more bytes.
      while (true) {
        if (recvBytes < IS_HEADER_SIZE) return;
        // Peek header without forcing a full concat when possible. The first
        // buffered chunk is almost always ≥ 12 bytes (TCP MSS is much larger).
        const head = recvChunks[0];
        const peek = head.length >= IS_HEADER_SIZE ? head : materializeRecv();
        const totalSize = IS_HEADER_SIZE + peek.readUInt32BE(6);
        if (recvBytes < totalSize) return;

        const buffer = materializeRecv();
        const packet = parseIsPacket(buffer);
        if (!packet) return; // header peek said yes; parseIsPacket only re-checks magic
        consumeRecv(packet.totalSize);

        // Async events (type 0x9000) are handled globally regardless of state.
        if (packet.type === 0x9000) {
          handleAsyncEvent(packet.payload);
          continue;
        }

        handlePacket(packet.type, packet.payload);
        if (state === "ERROR" || state === "DONE") return;
      }
    }

    function materializeRecv(): Buffer {
      if (recvChunks.length === 1) return recvChunks[0];
      const merged = Buffer.concat(recvChunks, recvBytes);
      recvChunks.length = 0;
      recvChunks.push(merged);
      return merged;
    }

    function consumeRecv(n: number): void {
      const buf = materializeRecv();
      const remainder = buf.subarray(n);
      recvChunks.length = 0;
      if (remainder.length > 0) recvChunks.push(remainder);
      recvBytes = remainder.length;
    }

    function handleAsyncEvent(payload: Buffer): void {
      const dispatch = payload.length > 0 ? payload[0] : -1;
      if (dispatch === 0x01) {
        log.info("Async event: ScanStart (0x01)");
      } else if (dispatch === 0x04) {
        log.info("Async event: Stop (0x04)");
      } else if (ASYNC_CANCEL.has(dispatch)) {
        log.warn(`Async event: ScanCancel (0x${dispatch.toString(16)}) — aborting`);
        transitionToError();
      } else if (ASYNC_FATAL.has(dispatch)) {
        log.error(`Async event: fatal (0x${dispatch.toString(16)}) — aborting`);
        transitionToError();
      } else {
        log.warn(`Async event: unknown dispatch byte 0x${dispatch.toString(16)}`);
      }
    }

    function handlePacket(type: number, payload: Buffer): void {
      clearTimeoutTimer();
      // Empty 0xa000 recvs are envelope-only acks (body recv follows); skip
      // uniformly here so per-state handlers only see non-empty replies.
      if (type === 0xa000 && payload.length === 0) {
        log.debug(`${state}: empty 0xa000 header, waiting for body`);
        return;
      }
      switch (state) {
        case "WELCOME":
          return onWelcome(type, payload);
        case "LOCKING":
          return onLockAck(type, payload);
        case "INIT1_FS_Y":
          return onInit1FsY(type, payload);
        case "INIT1_FIN":
          return onInit1Fin(type, payload);
        case "INIT2_FS_Z":
          return onInit2FsZ(type, payload);
        case "INIT2_FIN":
          return onInit2Fin(type, payload);
        case "INIT_POLL_FS_Y":
          return onInitFsY(type, payload);
        case "INIT_POLL_STAT":
          return onInitStat(type, payload);
        case "INIT_POLL_STAT_DRAIN":
          return onInitStatDrain(type, payload);
        case "INIT_POLL_FIN":
          return onInitFin(type, payload);
        case "MODE_SWITCH":
          return onModeSwitch(type, payload);
        case "POST_MODE_STAT":
          return onPostModeStat(type, payload);
        case "POST_MODE_STAT_DRAIN":
          return onPostModeStatDrain(type, payload);
        case "PARA":
          return onPara(type, payload);
        case "TRDT":
          return onTrdt(type, payload);
        case "IMG_META":
          return onImgMeta(type, payload);
        case "IMG_DATA":
          return onImgData(type, payload);
        case "FIN_AFTER_IMG":
          return onFinAfterImg(type, payload);
        case "POSTSCAN_FS_Y_1":
          return onPostscanFsY(1, type, payload);
        case "POSTSCAN_FS_Y_2":
          return onPostscanFsY(2, type, payload);
        case "POSTSCAN_STAT_1":
          return onPostscanStat(1, type, payload);
        case "POSTSCAN_STAT_2":
          return onPostscanStat(2, type, payload);
        case "POSTSCAN_DRAIN_1":
          return onPostscanDrain(1, type, payload);
        case "POSTSCAN_DRAIN_2":
          return onPostscanDrain(2, type, payload);
        case "POSTSCAN_FIN_1":
          return onPostscanFin(1, type, payload);
        case "POSTSCAN_FIN_2":
          return onPostscanFin(2, type, payload);
        case "UNLOCKING":
          return onUnlockAck(type, payload);
        case "TPR_META":
          return onTprMeta(type, payload);
        case "TPR_DATA":
          return onTprData(type, payload);
        default:
          log.warn(`Unexpected packet in state ${state}: type=0x${type.toString(16)}`);
      }
    }

    function ensure(condition: boolean, message: string): boolean {
      if (!condition) {
        log.error(message);
        transitionToError();
        return false;
      }
      return true;
    }

    function sanitizeAscii(buf: Buffer): string {
      return buf.toString("ascii").replace(/[^\x20-\x7e]/g, ".");
    }

    function warnIfNotJpeg(imageData: Buffer, label: string): void {
      if (
        imageData.length < 3 ||
        imageData[0] !== 0xff ||
        imageData[1] !== 0xd8 ||
        imageData[2] !== 0xff
      ) {
        log.warn(
          `${label} does not start with JPEG SOI — first bytes: ${imageData.subarray(0, 16).toString("hex")}`,
        );
      }
    }

    function flushCurrentPage(): void {
      const imageData = Buffer.concat(imageChunks);
      warnIfNotJpeg(imageData, `Page ${pageIndex} buffer`);
      const tempFilename = `page_${String(pageIndex).padStart(2, "0")}.jpg`;
      // EXIF Orientation=3 only matters for the JPG output path — PDF viewers
      // ignore JPEG EXIF and we use PDF /Rotate instead via pdf-lib.
      const needsExif = pageSide === "back" && session.action === "jpg";
      const output = needsExif ? setJpegOrientation(imageData, 3) : imageData;
      if (pageSide === "back") backPageIndices.push(pageIndex);
      fs.writeFileSync(path.join(sessionTempDir, tempFilename), output);
      log.debug(`Wrote page ${pageIndex} to ${tempFilename} (side=${pageSide})`);
      imageChunks.length = 0;
      pageIndex++;
    }

    // Shared tail for both page-end branches (zero-length + pen in IMG_META,
    // pen after data in IMG_DATA). `label` appears in the log message so the
    // two call sites remain distinguishable in logs.
    function dispatchPageEnd(label: string): void {
      if (pageEndKind === "last") {
        log.info(`IMG loop complete (${label}, terminal)`);
        state = "FIN_AFTER_IMG";
        send(buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE), "FIN_AFTER_IMG");
      } else {
        log.info(
          `Page ${pageIndex} complete (${label}, non-terminal) — flushing and requesting next page`,
        );
        flushCurrentPage();
        state = "IMG_META";
        send(buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE), "IMG_META");
      }
    }

    function onWelcome(type: number, payload: Buffer): void {
      if (!ensure(type === 0x8000, `WELCOME: expected type 0x8000, got 0x${type.toString(16)}`))
        return;
      log.info(`Welcome received (${payload.length}-byte payload)`);
      state = "LOCKING";
      send(buildLockPacket(), "LOCK");
    }

    function onLockAck(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa100, `LOCKING: expected type 0xa100, got 0x${type.toString(16)}`))
        return;
      if (!ensure(payload.length >= 1 && payload[0] === 0x06, `LOCKING: expected ACK 0x06`)) return;
      log.info("Scanner locked → cycle 1 init");
      state = "INIT1_FS_Y";
      send(buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE), "INIT1_FS_Y");
    }

    function onInit1FsY(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa000, `INIT1_FS_Y: expected 0xa000, got 0x${type.toString(16)}`))
        return;
      if (
        !ensure(
          payload[0] === 0x06,
          `INIT1_FS_Y: expected ACK 0x06, got 0x${payload[0].toString(16)}`,
        )
      )
        return;
      log.info("Cycle 1: FS Y ACK → @INFO");
      runTwoPhaseSequence(["INFO", "CAPA"], () => {
        state = "INIT1_FIN";
        send(buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE), "INIT1_FIN");
      });
    }

    function onInit1Fin(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa000, `INIT1_FIN: expected 0xa000, got 0x${type.toString(16)}`))
        return;
      log.debug(`INIT1_FIN reply: ${sanitizeAscii(payload)}`);
      log.info("Cycle 1 complete → cycle 2");
      state = "INIT2_FS_Z";
      send(buildPassthruPacket(buildFsZ(), LEGACY_REPLY_SIZE), "INIT2_FS_Z");
    }

    function onInit2FsZ(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa000, `INIT2_FS_Z: expected 0xa000, got 0x${type.toString(16)}`))
        return;
      if (
        !ensure(
          payload[0] === 0x06,
          `INIT2_FS_Z: expected ACK 0x06, got 0x${payload[0].toString(16)}`,
        )
      )
        return;
      log.info("Cycle 2: FS Z ACK → @INFO");
      runTwoPhaseSequence(["INFO", "CAPA", "RESA"], () => {
        state = "INIT2_FIN";
        send(buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE), "INIT2_FIN");
      });
    }

    function onInit2Fin(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa000, `INIT2_FIN: expected 0xa000, got 0x${type.toString(16)}`))
        return;
      log.debug(`INIT2_FIN reply: ${sanitizeAscii(payload)}`);
      log.info("Cycle 2 complete → STAT heartbeat loop");
      initPollIteration = 0;
      state = "INIT_POLL_FS_Y";
      send(buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE), "INIT_FS_Y");
    }

    function onInitFsY(type: number, payload: Buffer): void {
      if (
        !ensure(type === 0xa000, `INIT_POLL_FS_Y: expected type 0xa000, got 0x${type.toString(16)}`)
      )
        return;
      if (
        !ensure(
          payload[0] === 0x06,
          `INIT_POLL_FS_Y: expected ACK 0x06, got 0x${payload[0].toString(16)}`,
        )
      )
        return;
      state = "INIT_POLL_STAT";
      send(buildPassthruPacket(buildEsci2Command("STAT"), ESCI2_REPLY_SIZE), "INIT_STAT");
    }

    function onInitStat(type: number, payload: Buffer): void {
      if (
        !ensure(type === 0xa000, `INIT_POLL_STAT: expected type 0xa000, got 0x${type.toString(16)}`)
      )
        return;
      log.debug(`INIT_STAT reply: ${sanitizeAscii(payload)}`);

      // The printer publishes its auto-detected source in the first STAT reply
      // of the INIT_POLL loop: length 0 → ADF, length 12 → flatbed (payload is
      // filler `#---#---#---`). Later STATs (POSTSCAN cycles) can carry non-
      // zero lengths for unrelated reasons, so we only sample the first.
      // See docs/notes/2026-04-21-flatbed-protocol-analysis.md.
      const header = parseEsci2ReplyHeader(payload);
      if (initPollIteration === 0) {
        if (header) {
          if (header.length === 0) {
            source = "adf";
          } else if (header.length === 12) {
            source = "flatbed";
          } else {
            log.warn(`Unexpected INIT_STAT length ${header.length} — defaulting to ADF`);
            source = "adf";
          }
          log.info(`Source detected: ${source}`);
        } else {
          log.warn("INIT_STAT: unparseable reply header — defaulting to ADF");
        }
      }

      // When the STAT reply declares `length > 0`, the printer has queued-status
      // bytes waiting; pure-read them before any subsequent command so the next
      // reply isn't prefixed with stale bytes. Flatbed always declares 12 at
      // INIT_POLL; ADF declares 0 (the drain is skipped). Dispatch on the wire
      // signal so ADF firmwares that ever queued status here would be handled
      // without code change. Mirrors POSTSCAN_DRAIN.
      if (header && header.length > 0) {
        log.debug(`INIT_STAT: declared length ${header.length} — draining before FIN`);
        state = "INIT_POLL_STAT_DRAIN";
        send(buildPurereadPacket(header.length), "INIT_STAT_DRAIN");
      } else {
        state = "INIT_POLL_FIN";
        send(buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE), "INIT_FIN");
      }
    }

    function onInitStatDrain(type: number, payload: Buffer): void {
      if (
        !ensure(
          type === 0xa000,
          `INIT_POLL_STAT_DRAIN: expected type 0xa000, got 0x${type.toString(16)}`,
        )
      )
        return;
      log.debug(`INIT_STAT_DRAIN status: ${sanitizeAscii(payload)}`);
      state = "INIT_POLL_FIN";
      send(buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE), "INIT_FIN");
    }

    function onInitFin(type: number, payload: Buffer): void {
      if (
        !ensure(type === 0xa000, `INIT_POLL_FIN: expected type 0xa000, got 0x${type.toString(16)}`)
      )
        return;
      log.debug(`INIT_FIN reply: ${sanitizeAscii(payload)}`);
      initPollIteration++;
      if (initPollIteration < INIT_POLL_ITERATIONS) {
        log.info(`INIT_POLL iteration ${initPollIteration}/${INIT_POLL_ITERATIONS}`);
        state = "INIT_POLL_FS_Y";
        send(buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE), "INIT_FS_Y");
      } else {
        log.info(`INIT_POLL done after ${initPollIteration} iterations`);
        state = "MODE_SWITCH";
        send(buildPassthruPacket(buildFsX(), LEGACY_REPLY_SIZE), "MODE_SWITCH_FS_X");
      }
    }

    function onModeSwitch(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa000, `MODE_SWITCH: expected type 0xa000, got 0x${type.toString(16)}`))
        return;
      if (
        !ensure(
          payload[0] === 0x06,
          `MODE_SWITCH: expected ACK 0x06, got 0x${payload[0].toString(16)}`,
        )
      )
        return;
      log.info("Extended mode active");
      state = "POST_MODE_STAT";
      send(buildPassthruPacket(buildEsci2Command("STAT"), ESCI2_REPLY_SIZE), "POST_MODE_STAT");
    }

    function onPostModeStat(type: number, payload: Buffer): void {
      if (
        !ensure(type === 0xa000, `POST_MODE_STAT: expected type 0xa000, got 0x${type.toString(16)}`)
      )
        return;
      log.debug(`POST_MODE_STAT reply: ${sanitizeAscii(payload)}`);
      // When the reply declares `length > 0`, pure-read that many bytes before
      // PARA so the queued status doesn't prefix the next reply. Observed on
      // flatbed (12-byte `#ERRADF PE` status); ADF declares 0. Same wire-driven
      // dispatch as the INIT_POLL_STAT handler — see that comment for detail.
      const header = parseEsci2ReplyHeader(payload);
      if (header && header.length > 0) {
        log.debug(`POST_MODE_STAT: declared length ${header.length} — draining before PARA`);
        state = "POST_MODE_STAT_DRAIN";
        send(buildPurereadPacket(header.length), "POST_MODE_STAT_DRAIN");
      } else {
        sendParaHeaderAndBody();
      }
    }

    function onPostModeStatDrain(type: number, payload: Buffer): void {
      if (
        !ensure(
          type === 0xa000,
          `POST_MODE_STAT_DRAIN: expected type 0xa000, got 0x${type.toString(16)}`,
        )
      )
        return;
      log.debug(`POST_MODE_STAT_DRAIN status: ${sanitizeAscii(payload)}`);
      sendParaHeaderAndBody();
    }

    function sendParaHeaderAndBody(): void {
      // Transition to PARA — write BOTH phases back-to-back before waiting for reply.
      const paraPayload = buildParaPayload({ source, duplex: session.duplex });
      state = "PARA";
      send(buildPassthruPacket(buildParaHeader(paraPayload.length), 0), "PARA_HEADER");
      send(buildPassthruPacket(paraPayload, ESCI2_REPLY_SIZE), "PARA_PAYLOAD");
    }

    function beginTwoPhaseRead(command: TprCtx["command"], onComplete: () => void): void {
      tprCtx = { command, declaredLength: 0, onComplete };
      state = "TPR_META";
      send(buildPassthruPacket(buildEsci2Command(command), ESCI2_REPLY_SIZE), `${command}_META`);
    }

    function runTwoPhaseSequence(commands: readonly TprCtx["command"][], onDone: () => void): void {
      if (commands.length === 0) {
        onDone();
        return;
      }
      const [head, ...tail] = commands;
      beginTwoPhaseRead(head, () => runTwoPhaseSequence(tail, onDone));
    }

    function onTprMeta(type: number, payload: Buffer): void {
      const ctx = tprCtx!;
      if (
        !ensure(
          type === 0xa000,
          `TPR_META[${ctx.command}]: expected 0xa000, got 0x${type.toString(16)}`,
        )
      )
        return;
      const header = parseEsci2ReplyHeader(payload);
      if (
        !ensure(
          header !== null && header.cmd === ctx.command,
          `TPR_META[${ctx.command}]: bad reply header`,
        )
      )
        return;
      ctx.declaredLength = header!.length;
      log.debug(`${ctx.command}: declared ${ctx.declaredLength} bytes`);
      state = "TPR_DATA";
      send(buildPurereadPacket(ctx.declaredLength), `${ctx.command}_PULL`);
    }

    function onTprData(type: number, payload: Buffer): void {
      const ctx = tprCtx!;
      if (
        !ensure(
          type === 0xa000,
          `TPR_DATA[${ctx.command}]: expected 0xa000, got 0x${type.toString(16)}`,
        )
      )
        return;
      if (
        !ensure(
          payload.length === ctx.declaredLength,
          `TPR_DATA[${ctx.command}]: expected ${ctx.declaredLength} bytes, got ${payload.length}`,
        )
      )
        return;
      log.debug(`${ctx.command}: received ${payload.length}-byte capability body (discarded)`);
      tprCtx = null;
      ctx.onComplete();
    }

    function onPara(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa000, `PARA: expected type 0xa000, got 0x${type.toString(16)}`))
        return;
      const header = parseEsci2ReplyHeader(payload);
      if (!ensure(header !== null, `PARA: unparseable reply header`)) return;
      const tokens = parseTokens(payload.subarray(12));
      const parValue = tokens.get("par")?.trim();
      if (!ensure(parValue === "OK", `PARA: expected #parOK, got #par${parValue ?? "(missing)"}`))
        return;
      log.info("PARA accepted");
      state = "TRDT";
      send(buildPassthruPacket(buildEsci2Command("TRDT"), ESCI2_REPLY_SIZE), "TRDT");
    }

    function onTrdt(type: number, _payload: Buffer): void {
      if (!ensure(type === 0xa000, `TRDT: expected type 0xa000, got 0x${type.toString(16)}`))
        return;
      log.info("TRDT accepted, starting IMG loop");
      state = "IMG_META";
      send(buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE), "IMG_META");
    }

    function onImgMeta(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa000, `IMG_META: expected 0xa000, got 0x${type.toString(16)}`)) return;
      const header = parseEsci2ReplyHeader(payload);
      if (!ensure(header !== null, `IMG_META: unparseable reply header`)) return;
      const tokens = parseTokens(payload.subarray(12));

      // Surface any error markers from the printer.
      for (const key of tokens.keys()) {
        if (key.startsWith("ERR") || key.startsWith("err")) {
          log.error(`IMG_META: printer error token #${key}${tokens.get(key)}`);
          transitionToError();
          return;
        }
      }

      imgChunkSize = header!.length;
      // On flatbed, any #pen is terminal because the glass is inherently single-
      // page and the printer never emits #lftd000 on that path. On ADF, #lft
      // disambiguates "terminal" vs "page boundary, more coming".
      // See docs/notes/2026-04-21-flatbed-protocol-analysis.md.
      pageEndKind = tokens.has("pen")
        ? source === "flatbed" || tokens.has("lft")
          ? "last"
          : "more"
        : "none";
      pageSide = tokens.get("typ") === "IMGB" ? "back" : "front";
      log.debug(
        `IMG_META: length=${imgChunkSize}, pst=${tokens.has("pst")}, pageEnd=${pageEndKind}, side=${pageSide}`,
      );

      if (imgChunkSize === 0) {
        if (pageEndKind !== "none") {
          dispatchPageEnd("zero-length + pen");
          return;
        }
        // Zero-length with no pen: printer has nothing yet; retry IMG.
        zeroImgRetries++;
        if (
          !ensure(
            zeroImgRetries <= MAX_ZERO_IMG_RETRIES,
            `IMG_META: ${MAX_ZERO_IMG_RETRIES} consecutive zero-length replies without #pen`,
          )
        )
          return;
        log.debug(
          `IMG_META: zero-length no pen, retrying (${zeroImgRetries}/${MAX_ZERO_IMG_RETRIES})`,
        );
        send(buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE), "IMG_META");
        return;
      }

      zeroImgRetries = 0;
      state = "IMG_DATA";
      send(buildPurereadPacket(imgChunkSize), "IMG_DATA_READ");
    }

    function onImgData(type: number, payload: Buffer): void {
      if (!ensure(type === 0xa000, `IMG_DATA: expected type 0xa000, got 0x${type.toString(16)}`))
        return;
      if (
        !ensure(
          payload.length === imgChunkSize,
          `IMG_DATA: expected ${imgChunkSize} bytes, got ${payload.length}`,
        )
      )
        return;
      imageChunks.push(Buffer.from(payload));
      log.debug(
        `IMG_DATA: accumulated ${payload.length} bytes (total chunks: ${imageChunks.length})`,
      );
      if (pageEndKind !== "none") {
        dispatchPageEnd("pen after data");
      } else {
        state = "IMG_META";
        send(buildPassthruPacket(buildEsci2Command("IMG"), ESCI2_REPLY_SIZE), "IMG_META");
      }
    }

    function onFinAfterImg(type: number, _payload: Buffer): void {
      if (
        !ensure(type === 0xa000, `FIN_AFTER_IMG: expected type 0xa000, got 0x${type.toString(16)}`)
      )
        return;
      if (source === "flatbed") {
        // No ADF-empty state to drain — Windows driver goes straight from
        // FIN_AFTER_IMG to UNLOCK. Verified in
        // tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl
        // (last 5 sends: @IMG | @IMG | @FIN | UNLOCK, no POSTSCAN drain).
        log.info("FIN after IMG accepted — flatbed, skipping POSTSCAN drain");
        state = "UNLOCKING";
        send(buildUnlockPacket(), "UNLOCK");
        return;
      }
      log.info("FIN after IMG accepted, starting post-scan drain (cycle 1)");
      state = "POSTSCAN_FS_Y_1";
      send(buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE), "POSTSCAN_FS_Y_1");
    }

    // The two drain cycles are identical in shape — a `1 | 2` cycle number
    // parameterises the next-state transition. Cycle 1's FIN advances to cycle 2;
    // cycle 2's FIN advances to UNLOCKING.

    function onPostscanFsY(cycle: 1 | 2, type: number, payload: Buffer): void {
      const label = `POSTSCAN_FS_Y_${cycle}`;
      if (!ensure(type === 0xa000, `${label}: expected type 0xa000, got 0x${type.toString(16)}`))
        return;
      if (
        !ensure(
          payload[0] === 0x06,
          `${label}: expected ACK 0x06, got 0x${payload[0].toString(16)}`,
        )
      )
        return;
      const next = cycle === 1 ? "POSTSCAN_STAT_1" : "POSTSCAN_STAT_2";
      state = next;
      send(buildPassthruPacket(buildEsci2Command("STAT"), ESCI2_REPLY_SIZE), next);
    }

    function onPostscanStat(cycle: 1 | 2, type: number, payload: Buffer): void {
      const label = `POSTSCAN_STAT_${cycle}`;
      if (!ensure(type === 0xa000, `${label}: expected type 0xa000, got 0x${type.toString(16)}`))
        return;
      log.debug(`${label} reply: ${sanitizeAscii(payload)}`);
      // Wire-driven drain length, matching onInitStat / onPostModeStat. ADF
      // captures always declare 12 here (`#ERRADF PE` paper-empty status),
      // but reading from the header means a firmware variation that queues
      // a different length would still be handled correctly.
      const header = parseEsci2ReplyHeader(payload);
      const drainLength = header?.length ?? 12;
      const next = cycle === 1 ? "POSTSCAN_DRAIN_1" : "POSTSCAN_DRAIN_2";
      state = next;
      send(buildPurereadPacket(drainLength), next);
    }

    function onPostscanDrain(cycle: 1 | 2, type: number, payload: Buffer): void {
      const label = `POSTSCAN_DRAIN_${cycle}`;
      if (!ensure(type === 0xa000, `${label}: expected type 0xa000, got 0x${type.toString(16)}`))
        return;
      log.debug(`${label} status: ${sanitizeAscii(payload)}`);
      const next = cycle === 1 ? "POSTSCAN_FIN_1" : "POSTSCAN_FIN_2";
      state = next;
      send(buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE), next);
    }

    function onPostscanFin(cycle: 1 | 2, type: number, _payload: Buffer): void {
      const label = `POSTSCAN_FIN_${cycle}`;
      if (!ensure(type === 0xa000, `${label}: expected type 0xa000, got 0x${type.toString(16)}`))
        return;
      if (cycle === 1) {
        log.info("Drain cycle 1 complete, starting cycle 2");
        state = "POSTSCAN_FS_Y_2";
        send(buildPassthruPacket(buildFsY(), LEGACY_REPLY_SIZE), "POSTSCAN_FS_Y_2");
      } else {
        log.info("Post-scan drain complete, unlocking");
        state = "UNLOCKING";
        send(buildUnlockPacket(), "UNLOCK");
      }
    }

    function onUnlockAck(type: number, _payload: Buffer): void {
      if (!ensure(type === 0xa101, `UNLOCKING: expected type 0xa101, got 0x${type.toString(16)}`))
        return;
      log.info("Scanner unlocked");
      finalizeScan();
    }

    function finalizeScan(): void {
      state = "DONE";
      clearTimeoutTimer();
      // Close the TLS socket FIRST, then defer the disk write to a later tick
      // so the event loop can actually flush the TLS close_notify + TCP FIN
      // before we start a synchronous ~1 ms writeFileSync that would otherwise
      // block the close from hitting the wire. The printer RSTs (ECONNRESET)
      // if our close arrives after its own close_notify/FIN, and surfaces
      // "Scanning Error" on its panel even though the scan data is valid.
      // Verified via Wireshark: the Windows driver FINs ~27 µs after the
      // UNLOCK ack; our earlier post-unlock blocking writeFileSync delayed
      // the FIN by ~1 ms, which was enough for the printer to RST first.
      socket.end();
      if (imageChunks.length === 0) {
        log.error("Scan completed with zero image chunks");
        return;
      }
      const writeSessionOutput = async (): Promise<void> => {
        flushCurrentPage();
        try {
          if (session.action === "jpg") {
            const saved = promoteTempPagesToOutput(
              sessionTempDir,
              session.outputDir,
              sessionTs,
              "jpg",
            );
            log.info(`Scan complete — wrote ${saved.length} JPG file(s); first: ${saved[0]}`);
            if (session.paperless) {
              await uploadAllToPaperless(saved, session.paperless);
            }
          } else {
            // PDF branch
            try {
              const pdfBuf = await composePdfFromJpegs(sessionTempDir, {
                backPages: backPageIndices,
              });
              const pdfName = generateFilename(sessionTs, "pdf");
              const savedPath = writeOutputFile(session.outputDir, pdfName, pdfBuf);
              log.info(`Scan complete — saved PDF to ${savedPath}`);
              if (session.paperless) {
                await uploadAllToPaperless([savedPath], session.paperless);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.error(`PDF composition failed: ${msg}. Falling back to JPG output.`);
              const saved = promoteTempPagesToOutput(
                sessionTempDir,
                session.outputDir,
                sessionTs,
                "jpg",
              );
              log.info(`Saved ${saved.length} JPG file(s) as fallback`);
              if (session.paperless) {
                await uploadAllToPaperless(saved, session.paperless);
              }
            }
          }
        } finally {
          fs.rmSync(sessionTempDir, { recursive: true, force: true });
          resolveOnce();
        }
      };
      setImmediate(() => {
        writeSessionOutput().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Unexpected finalizeScan failure: ${msg}`);
          resolveOnce();
        });
      });
    }
  }); // end Promise executor
}
