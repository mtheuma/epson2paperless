import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";
import {
  parseIsPacket,
  buildLockPacket,
  buildUnlockPacket,
  buildPassthruPacket,
  buildIsPacket,
} from "./protocol.js";
import {
  buildEscInit,
  buildFsI,
  buildFsF,
  buildEscE,
  buildEscParen,
  buildEscZ,
  buildFsW,
  buildFsG,
  buildEscCleanup,
  buildFsWBlock,
  buildStreamConfigPayload,
  parseFsGReply,
  geometry,
  type Source,
  type Format,
} from "./esci-legacy.js";
import { GAMMA_LUT_R, GAMMA_LUT_G, GAMMA_LUT_B } from "./esci-legacy-luts.js";
import { encodeRawRgbToJpeg } from "./raw-to-jpeg.js";
import { resolveSessionTimestamp } from "./output.js";
import { finalizeSession } from "./output-tail.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";

const log = createLogger("scanner-legacy");

export interface LegacyScanSession {
  printerIp: string;
  port: number;
  outputDir: string;
  tempDir: string;
  source: Source;
  format: Format;
  jpegQuality: number;
  paperless?: PaperlessUploadOptions;
}

export type TcpSocketFactory = (host: string, port: number, onConnect?: () => void) => net.Socket;

// prettier-ignore
type State =
  | "CONNECTING"
  | "WELCOME"
  | "LOCKING"
  | "INIT"
  | "IDENTITY"
  | "STATUS_1A"
  | "STATUS_1B"
  | "SOURCE_CMD"
  | "SOURCE_PARAM"
  | "STATUS_2"
  | "RESET_PAREN"
  | "RESET_INIT"
  | "RESET_SRC_CMD"
  | "RESET_SRC_PARAM"
  | "STATUS_READY"
  | "GAMMA_R_CMD"
  | "GAMMA_R_DATA"
  | "GAMMA_G_CMD"
  | "GAMMA_G_DATA"
  | "GAMMA_B_CMD"
  | "GAMMA_B_DATA"
  | "WINDOW_CMD"
  | "WINDOW_DATA"
  | "STATUS_PRESCAN"
  | "START"
  | "IMG_RECEIVING"
  | "PAGE_ENCODING"  // async JPEG encoding in progress; absorbs trailing image chunks
  | "POST_STATUS"
  | "CLEANUP_1"
  | "CLEANUP_2"
  | "UNLOCKING"
  | "DONE"
  | "ERROR";

const TIMEOUT_MS = 60_000;
const ACK_BYTE = 0x06;
const NAK_BYTE = 0x80;

export function startScanSessionLegacy(
  session: LegacyScanSession,
  socketFactory: TcpSocketFactory = (host, port, cb) => net.connect(port, host, cb),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sessionTs = resolveSessionTimestamp(new Date(), session.outputDir);
    const sessionTempDir = fs.mkdtempSync(
      path.join(session.tempDir || os.tmpdir(), "epson2paperless-leg-"),
    );

    let state: State = "CONNECTING";
    let buffer = Buffer.alloc(0);
    let timeoutTimer: NodeJS.Timeout | null = null;
    let resolved = false;

    let fsGReply: ReturnType<typeof parseFsGReply> | null = null;
    let imageBuffer = Buffer.alloc(0);
    let expectedBytes = 0;
    const pageJpegPaths: string[] = [];
    const backPageIndices: number[] = [];
    // Packets that arrive during PAGE_ENCODING are deferred and replayed after encoding.
    const encodingDeferred: Array<{ type: number; payload: Buffer }> = [];

    const socket = socketFactory(session.printerIp, session.port, () => {
      log.info(`Connected (TCP) to ${session.printerIp}:${session.port}`);
      state = "WELCOME";
      armTimeout();
    });

    socket.on("data", onData);
    socket.on("error", (err: Error) => fail(`socket error: ${err.message}`));
    socket.on("close", onClose);

    function resolveOnce(): void {
      if (resolved) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    }

    function fail(reason: string): void {
      if (state === "ERROR") return;
      state = "ERROR";
      log.error(`State machine error: ${reason}`);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try {
        socket.destroy();
      } catch {
        /* swallow */
      }
      try {
        fs.rmSync(sessionTempDir, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
      if (resolved) return;
      resolved = true;
      reject(new Error(reason));
    }

    function armTimeout(): void {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => fail(`state-machine timeout in ${state}`), TIMEOUT_MS);
    }

    function send(buf: Buffer): void {
      socket.write(buf);
    }

    function sendCmd(cmd: Buffer, replySize: number): void {
      send(buildPassthruPacket(cmd, replySize));
    }

    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      armTimeout();
      let pkt = parseIsPacket(buffer);
      while (pkt) {
        buffer = buffer.subarray(pkt.totalSize);
        try {
          handle(pkt);
        } catch (err) {
          fail(`packet handler threw: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (state === "ERROR" || state === "DONE") return;
        pkt = parseIsPacket(buffer);
      }
    }

    function enterGammaPhase(): void {
      state = "GAMMA_R_CMD";
      sendCmd(buildEscZ(), 1);
    }

    function handle(pkt: { type: number; payload: Buffer }): void {
      switch (state) {
        case "WELCOME":
          if (pkt.type !== 0x8000) {
            return fail(`expected welcome (0x8000), got 0x${pkt.type.toString(16)}`);
          }
          state = "LOCKING";
          send(buildLockPacket());
          return;

        case "LOCKING":
          if (pkt.type !== 0xa100) {
            return fail(`expected lock-ack (0xa100), got 0x${pkt.type.toString(16)}`);
          }
          state = "INIT";
          sendCmd(buildEscInit(), 1);
          return;

        case "INIT":
          // IS-0xa000 with payload = 0x06 (ACK for ESC @)
          if (!isAck(pkt))
            return fail(`expected ESC @ ack, got payload ${pkt.payload.toString("hex")}`);
          state = "IDENTITY";
          sendCmd(buildFsI(), 80);
          return;

        case "IDENTITY":
          // IS-0xa000 with 80-byte identity payload; we don't decode it
          if (pkt.payload.length !== 80) {
            return fail(`expected 80-byte identity reply, got ${pkt.payload.length}`);
          }
          state = "STATUS_1A";
          sendCmd(buildFsF(), 16);
          return;

        case "STATUS_1A":
          // First FS F status reply (16 bytes); driver reads it twice
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status, got ${pkt.payload.length}`);
          }
          state = "STATUS_1B";
          sendCmd(buildFsF(), 16);
          return;

        case "STATUS_1B":
          // Second FS F status reply; now initiate source-set
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status, got ${pkt.payload.length}`);
          }
          state = "SOURCE_CMD";
          sendCmd(buildEscE(), 1);
          // Send param in same tick as separate passthru (driver sends opcode + param as two writes)
          sendCmd(Buffer.from([sourceByte(session.source)]), 1);
          return;

        case "SOURCE_CMD":
          // ACK for ESC e opcode
          if (!isAck(pkt)) return fail(`expected ESC e ack`);
          state = "SOURCE_PARAM";
          return;

        case "SOURCE_PARAM":
          // ACK for ESC e param byte
          if (!isAck(pkt)) return fail(`expected ESC e param ack`);
          state = "STATUS_2";
          sendCmd(buildFsF(), 16);
          return;

        case "STATUS_2": {
          // Status after source-set. If first byte is 0x81, scanner is busy/probing ADF;
          // do a reset cycle (ESC ( + ESC @ + re-send ESC e with final source byte).
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status in STATUS_2, got ${pkt.payload.length}`);
          }
          const statusByte = pkt.payload[0];
          if (statusByte === 0x81) {
            // Scanner signalled busy — initiate reset cycle
            log.debug("STATUS_2: scanner busy (0x81), starting reset cycle");
            state = "RESET_PAREN";
            sendCmd(buildEscParen(), 1);
          } else {
            // Scanner ready — proceed to gamma phase
            log.debug(
              `STATUS_2: scanner ready (0x${statusByte.toString(16)}), entering gamma phase`,
            );
            enterGammaPhase();
          }
          return;
        }

        case "RESET_PAREN":
          // ESC ( returns 0x06 (ready) or 0x80 (busy); either way, proceed with reset
          if (pkt.payload.length !== 1) {
            return fail(`expected 1-byte ESC ( reply, got ${pkt.payload.length}`);
          }
          log.debug(`RESET_PAREN: ESC ( returned 0x${pkt.payload[0].toString(16)}`);
          state = "RESET_INIT";
          sendCmd(buildEscInit(), 1);
          return;

        case "RESET_INIT":
          if (!isAck(pkt)) return fail(`expected ESC @ ack in reset cycle`);
          state = "RESET_SRC_CMD";
          sendCmd(buildEscE(), 1);
          sendCmd(Buffer.from([sourceByte(session.source)]), 1);
          return;

        case "RESET_SRC_CMD":
          if (!isAck(pkt)) return fail(`expected ESC e ack in reset cycle`);
          state = "RESET_SRC_PARAM";
          return;

        case "RESET_SRC_PARAM":
          if (!isAck(pkt)) return fail(`expected ESC e param ack in reset cycle`);
          state = "STATUS_READY";
          sendCmd(buildFsF(), 16);
          return;

        case "STATUS_READY":
          // Status after reset cycle; should be ready now
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status in STATUS_READY, got ${pkt.payload.length}`);
          }
          log.debug(`STATUS_READY: status byte 0x${pkt.payload[0].toString(16)}`);
          enterGammaPhase();
          return;

        case "GAMMA_R_CMD":
          if (!isAck(pkt)) return fail(`expected ESC z ack (R)`);
          state = "GAMMA_R_DATA";
          sendCmd(Buffer.concat([Buffer.from([0x52]), GAMMA_LUT_R]), 1);
          return;

        case "GAMMA_R_DATA":
          if (!isAck(pkt)) return fail(`expected gamma R LUT ack`);
          state = "GAMMA_G_CMD";
          sendCmd(buildEscZ(), 1);
          return;

        case "GAMMA_G_CMD":
          if (!isAck(pkt)) return fail(`expected ESC z ack (G)`);
          state = "GAMMA_G_DATA";
          sendCmd(Buffer.concat([Buffer.from([0x47]), GAMMA_LUT_G]), 1);
          return;

        case "GAMMA_G_DATA":
          if (!isAck(pkt)) return fail(`expected gamma G LUT ack`);
          state = "GAMMA_B_CMD";
          sendCmd(buildEscZ(), 1);
          return;

        case "GAMMA_B_CMD":
          if (!isAck(pkt)) return fail(`expected ESC z ack (B)`);
          state = "GAMMA_B_DATA";
          sendCmd(Buffer.concat([Buffer.from([0x42]), GAMMA_LUT_B]), 1);
          return;

        case "GAMMA_B_DATA":
          if (!isAck(pkt)) return fail(`expected gamma B LUT ack`);
          state = "WINDOW_CMD";
          sendCmd(buildFsW(), 1);
          return;

        case "WINDOW_CMD":
          if (!isAck(pkt)) return fail(`expected FS W ack`);
          state = "WINDOW_DATA";
          sendCmd(buildFsWBlock({ source: session.source, format: session.format }), 1);
          return;

        case "WINDOW_DATA":
          if (!isAck(pkt)) return fail(`expected FS W block ack`);
          state = "STATUS_PRESCAN";
          sendCmd(buildFsF(), 16);
          return;

        case "STATUS_PRESCAN":
          // Pre-scan status; now request scan start via FS G
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status, got ${pkt.payload.length}`);
          }
          state = "START";
          sendCmd(buildFsG(), 14);
          return;

        case "START": {
          // FS G reply: 14-byte scan geometry
          if (pkt.payload.length !== 14) {
            return fail(`expected 14-byte FS G reply, got ${pkt.payload.length}`);
          }
          fsGReply = parseFsGReply(pkt.payload);
          expectedBytes = computeExpectedBytes(session.source, session.format);
          imageBuffer = Buffer.alloc(0);
          log.debug(`START: expectedBytes=${expectedBytes}, chunkSize=${fsGReply.chunkSize}`);
          // Send stream-config IS-0x2200 immediately; no reply expected before image stream starts
          send(buildIsPacket(0x2200, buildStreamConfigPayload(fsGReply, session.format)));
          state = "IMG_RECEIVING";
          return;
        }

        case "IMG_RECEIVING":
          if (pkt.type !== 0xa200) {
            return fail(
              `expected IS-0xa200 image chunk, got 0x${pkt.type.toString(16)} in state IMG_RECEIVING`,
            );
          }
          imageBuffer = Buffer.concat([imageBuffer, pkt.payload]);
          if (imageBuffer.length >= expectedBytes) {
            // Transition to PAGE_ENCODING immediately to absorb any trailing image chunks
            // while the async JPEG encoding runs in the background.
            state = "PAGE_ENCODING";
            void onPageComplete();
          }
          return;

        case "PAGE_ENCODING":
          // Absorb trailing IS-0xa200 image chunks silently.
          // Buffer all other packets and replay them once encoding completes.
          if (pkt.type !== 0xa200) {
            encodingDeferred.push({ type: pkt.type, payload: pkt.payload });
          }
          return;

        case "POST_STATUS":
          // FS F status after image stream; proceed to cleanup
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte post-scan status, got ${pkt.payload.length}`);
          }
          state = "CLEANUP_1";
          sendCmd(buildEscCleanup(), 1);
          return;

        case "CLEANUP_1":
          // ESC ) may return 0x80 (NAK) or 0x06 (ACK); either way send second cleanup
          if (pkt.payload.length !== 1) {
            return fail(`expected 1-byte CLEANUP_1 reply, got ${pkt.payload.length}`);
          }
          log.debug(`CLEANUP_1: ESC ) returned 0x${pkt.payload[0].toString(16)}`);
          state = "CLEANUP_2";
          sendCmd(buildEscCleanup(), 1);
          return;

        case "CLEANUP_2":
          // Second ESC ) — also may return 0x80; then unlock
          if (pkt.payload.length !== 1) {
            return fail(`expected 1-byte CLEANUP_2 reply, got ${pkt.payload.length}`);
          }
          log.debug(`CLEANUP_2: ESC ) returned 0x${pkt.payload[0].toString(16)}`);
          state = "UNLOCKING";
          send(buildUnlockPacket());
          return;

        case "UNLOCKING":
          // IS-0xa101 unlock ack
          if (pkt.type !== 0xa101) {
            return fail(`expected unlock ack (0xa101), got 0x${pkt.type.toString(16)}`);
          }
          state = "DONE";
          finalize();
          return;

        case "DONE":
        case "ERROR":
          return;

        default:
          fail(`unhandled state ${String(state)}`);
      }
    }

    async function onPageComplete(): Promise<void> {
      if (!fsGReply) return fail("page complete with no FS G reply");
      const geom = geometry({ source: session.source, format: session.format });
      try {
        const jpg = await encodeRawRgbToJpeg(
          imageBuffer.subarray(0, geom.widthPx * geom.heightPx * 3),
          geom.widthPx,
          geom.heightPx,
          session.jpegQuality,
        );
        const pageNum = pageJpegPaths.length + 1;
        const jpgPath = path.join(sessionTempDir, `page_${String(pageNum).padStart(3, "0")}.jpg`);
        fs.writeFileSync(jpgPath, jpg);
        pageJpegPaths.push(jpgPath);
        log.debug(`Page ${pageNum} encoded, ${jpg.length} bytes -> ${jpgPath}`);
      } catch (err) {
        fail(`raw-to-jpeg encoding failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      // Flatbed: skip eject; go straight to POST_STATUS.
      // ADF: would send page-eject here (not implemented yet — flatbed-only for now).
      state = "POST_STATUS";
      sendCmd(buildFsF(), 16);

      // Replay any packets that were buffered during PAGE_ENCODING.
      const deferred = encodingDeferred.splice(0);
      for (const pkt of deferred) {
        if (state === "ERROR" || state === "DONE") return;
        try {
          handle(pkt);
        } catch (err) {
          fail(
            `deferred packet handler threw: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
    }

    function finalize(): void {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      socket.end();
      setImmediate(() => {
        finalizeSession({
          sessionTempDir,
          outputDir: session.outputDir,
          sessionTs,
          action: session.format === "jpg" ? "jpg" : "pdf",
          backPageIndices,
          paperless: session.paperless,
        })
          .catch((err: unknown) => log.error(`finalizeSession failed: ${String(err)}`))
          .finally(() => resolveOnce());
      });
    }

    function onClose(): void {
      if (state !== "DONE" && state !== "ERROR") {
        fail(`socket closed in state ${state}`);
      }
    }
  });
}

function sourceByte(s: Source): number {
  return s === "flatbed" ? 0x00 : s === "adf-simplex" ? 0x01 : 0x02;
}

function isAck(pkt: { payload: Buffer }): boolean {
  return pkt.payload.length === 1 && pkt.payload[0] === ACK_BYTE;
}

// NAK_BYTE is defined but only used via log.debug — keep the constant for documentation.
void NAK_BYTE;

function computeExpectedBytes(source: Source, format: Format): number {
  const geom = geometry({ source, format });
  return geom.widthPx * geom.heightPx * 3;
}
