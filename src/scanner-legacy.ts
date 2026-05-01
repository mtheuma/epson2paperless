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
  buildPageEject,
  buildFsWBlock,
  buildStreamConfigPayload,
  parseFsGReply,
  geometry,
  SOURCE_BYTE,
  type Source,
  type Format,
} from "./esci-legacy.js";
import { GAMMA_LUT_R, GAMMA_LUT_G, GAMMA_LUT_B } from "./esci-legacy-luts.js";
import { encodeRawGbrToJpeg } from "./raw-to-jpeg.js";
import { setJpegOrientation } from "./exif.js";
import { resolveSessionTimestamp } from "./output.js";
import { finalizeSession } from "./output-tail.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";

const log = createLogger("scanner-legacy");

const GAMMA_CHANNELS = [
  { tag: 0x52, lut: GAMMA_LUT_R },
  { tag: 0x47, lut: GAMMA_LUT_G },
  { tag: 0x42, lut: GAMMA_LUT_B },
] as const;

// The Windows driver always sends source byte 0x01 (ADF-simplex) as the initial probe,
// regardless of the user's intended source. It gets a 0x81 busy reply, resets, then
// sends the actual source byte. Matching this behaviour ensures the busy cycle fires on
// real flatbed hardware where sending 0x00 as the probe could skip the reset entirely.
const PROBE_SOURCE_BYTE = 0x01;

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
  // ADF-only pre-reset cycle: re-probe source before ESC ( reset
  // (fixture: adf-single-page-jpeg.jsonl lines 32-43; STATUS_2 returns 0x01 for ADF,
  //  driver re-sends ESC e + source param + FS F before entering the ESC ( reset cycle)
  | "ADF_PRESRC_CMD"
  | "ADF_PRESRC_PARAM"
  | "ADF_STATUS_3"
  | "RESET_PAREN"
  | "RESET_INIT"
  | "RESET_SRC_CMD"
  | "RESET_SRC_PARAM"
  | "STATUS_READY"
  // ADF-only post-reset identity reads: FS I is sent twice after STATUS_READY for ADF
  // (fixture: adf-single-page-jpeg.jsonl lines 64-71)
  | "ADF_IDENTITY_A"
  | "ADF_IDENTITY_B"
  // ADF+PDF only: extra ESC e + source param after ADF_IDENTITY_B, before gamma phase
  // (fixture: adf-single-page-pdf.jsonl lines 72-79)
  | "ADF_PDF_SRC_CMD"
  | "ADF_PDF_SRC_PARAM"
  | "GAMMA_CMD"
  | "GAMMA_DATA"
  | "WINDOW_CMD"
  | "WINDOW_DATA"
  | "STATUS_PRESCAN"
  | "START"
  // ADF FS G not-ready retry: when FS G returns chunkSize=0, poll FS F until ready,
  // then re-send FS G. Seen in the 4-page duplex PDF capture where the ADF had not
  // finished feeding paper by the time the host issued FS G.
  // START_POLL: keep sending FS F; on first status=0x01 → START_POLL_READY.
  // START_POLL_READY: send one more FS F confirmation; then send FS G and go to START.
  | "START_POLL"
  | "START_POLL_READY"
  | "IMG_RECEIVING"
  | "PAGE_ENCODING"  // async JPEG encoding in progress; absorbs trailing image chunks
  // ADF-only page eject: 0x0c 0x00 sent after image stream, before FS F status check
  // (fixture: adf-single-page-jpeg.jsonl lines 117-120)
  | "PAGE_EJECT_WAIT"
  | "POST_STATUS"
  | "CLEANUP_1"
  // ADF-only cleanup: after ESC ) NAK, driver re-sends ESC e + source + FS F before 2nd ESC )
  // (fixture: adf-single-page-jpeg.jsonl lines 127-138)
  | "ADF_CLEANUP_SRC_CMD"
  | "ADF_CLEANUP_SRC_PARAM"
  | "ADF_CLEANUP_STATUS"
  | "CLEANUP_2"
  | "UNLOCKING"
  | "DONE"
  | "ERROR";

const TIMEOUT_MS = 60_000;
const ACK_BYTE = 0x06;

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
    let imageBufferOffset = 0;
    let expectedBytes = 0;
    const pageJpegPaths: string[] = [];
    let gammaChannelIdx = 0;
    const backPageIndices: number[] = [];
    // Set to true when looping back for the back side of a duplex sheet; controls
    // STATUS_1B and ADF_IDENTITY_B to skip the initial source-set / PDF ESC e steps.
    // Cleared at:
    //   - STATUS_1A's 0x81 branch (ADF empty → cleanup)
    //   - ADF_IDENTITY_B's enter-gamma transition
    let inInterPageLoop = false;
    // Non-image packets that arrive during PAGE_ENCODING are deferred and replayed after encoding.
    const encodingDeferred: Array<{ type: number; payload: Buffer }> = [];
    // IS-0xa200 image chunks that arrive during PAGE_ENCODING are buffered here and fed into
    // imageBuffer when the state machine re-enters IMG_RECEIVING for the next page.
    // (In single-page scans these are trailing overflow chunks and are harmless to buffer;
    // in duplex scans they carry the second page's pixel data.)
    const deferredImageChunks: Buffer[] = [];

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

    // Defeat TypeScript's control-flow narrowing: after `state = "POST_STATUS"`, tsc infers
    // state is literally "POST_STATUS" and flags subsequent `state === "ERROR"` checks as
    // impossible. The accessor opaque-ifies the read so narrowing doesn't apply.
    const getState = (): State => state;

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
      gammaChannelIdx = 0;
      state = "GAMMA_CMD";
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
          // First FS F status reply (16 bytes); driver reads it twice.
          // In the inter-page loop, byte 0 of the status reply discriminates:
          //   0x01 → ADF still has paper, continue setup for next page
          //   0x81 → ADF empty, skip identity/gamma/window and go to cleanup
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status, got ${pkt.payload.length}`);
          }
          if (inInterPageLoop && pkt.payload[0] === 0x81) {
            inInterPageLoop = false;
            state = "CLEANUP_1";
            sendCmd(buildEscCleanup(), 1);
            return;
          }
          state = "STATUS_1B";
          sendCmd(buildFsF(), 16);
          return;

        case "STATUS_1B":
          // Second FS F status reply.
          // Initial setup: initiate source-set (ESC e + probe param).
          // Inter-page loop (duplex back side): skip source-set; go straight to ADF identity reads.
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status, got ${pkt.payload.length}`);
          }
          if (inInterPageLoop) {
            state = "ADF_IDENTITY_A";
            sendCmd(buildFsI(), 80);
            return;
          }
          state = "SOURCE_CMD";
          sendCmd(buildEscE(), 1);
          // Send param in same tick as separate passthru (driver sends opcode + param as two writes).
          // Always probe with PROBE_SOURCE_BYTE (0x01/ADF-simplex) regardless of intended source —
          // this matches the Windows driver's behaviour and ensures the 0x81 busy cycle fires.
          sendCmd(Buffer.from([PROBE_SOURCE_BYTE]), 1);
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
          // Status after source-set probe.
          // - 0x81: scanner busy/probing ADF (flatbed fixture) → standard reset cycle.
          // - Other (e.g. 0x01 for ADF simplex): ADF extended setup — re-probe source,
          //   check status again, then do the ESC ( reset cycle, then read identity twice.
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status in STATUS_2, got ${pkt.payload.length}`);
          }
          const statusByte = pkt.payload[0];
          if (statusByte === 0x81) {
            // Scanner signalled busy — initiate reset cycle
            log.debug("STATUS_2: scanner busy (0x81), starting reset cycle");
            state = "RESET_PAREN";
            sendCmd(buildEscParen(), 1);
          } else if (session.source !== "flatbed") {
            // ADF source: re-probe with ESC e before entering the reset cycle.
            // The ADF fixture shows an extra ESC e + source-param + FS F sequence
            // before ESC ( / ESC @ (lines 32-43 of adf-single-page-jpeg.jsonl).
            log.debug(
              `STATUS_2: ADF status 0x${statusByte.toString(16)}, starting ADF pre-reset probe`,
            );
            state = "ADF_PRESRC_CMD";
            sendCmd(buildEscE(), 1);
            sendCmd(Buffer.from([PROBE_SOURCE_BYTE]), 1);
          } else {
            // Flatbed scanner ready — proceed to gamma phase
            log.debug(
              `STATUS_2: scanner ready (0x${statusByte.toString(16)}), entering gamma phase`,
            );
            enterGammaPhase();
          }
          return;
        }

        case "ADF_PRESRC_CMD":
          // ACK for the re-probe ESC e opcode sent in the ADF branch of STATUS_2.
          if (!isAck(pkt)) return fail(`expected ACK for ADF pre-reset ESC e opcode`);
          state = "ADF_PRESRC_PARAM";
          return;

        case "ADF_PRESRC_PARAM":
          // ACK for the re-probe source param byte (0x01).
          if (!isAck(pkt)) return fail(`expected ACK for ADF pre-reset source param`);
          state = "ADF_STATUS_3";
          sendCmd(buildFsF(), 16);
          return;

        case "ADF_STATUS_3":
          // Third FS F status check (ADF only); flows into the ESC ( reset cycle.
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status in ADF_STATUS_3, got ${pkt.payload.length}`);
          }
          log.debug(`ADF_STATUS_3: status byte 0x${pkt.payload[0].toString(16)}`);
          state = "RESET_PAREN";
          sendCmd(buildEscParen(), 1);
          return;

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
          sendCmd(Buffer.from([SOURCE_BYTE[session.source]]), 1);
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
          // Status after reset cycle; should be ready now.
          // ADF sources read identity (FS I) twice before entering gamma phase; flatbed goes straight to gamma.
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status in STATUS_READY, got ${pkt.payload.length}`);
          }
          log.debug(`STATUS_READY: status byte 0x${pkt.payload[0].toString(16)}`);
          if (session.source !== "flatbed") {
            state = "ADF_IDENTITY_A";
            sendCmd(buildFsI(), 80);
          } else {
            enterGammaPhase();
          }
          return;

        case "ADF_IDENTITY_A":
          // First FS I identity read after ADF reset cycle.
          if (pkt.payload.length !== 80) {
            return fail(`expected 80-byte identity in ADF_IDENTITY_A, got ${pkt.payload.length}`);
          }
          state = "ADF_IDENTITY_B";
          sendCmd(buildFsI(), 80);
          return;

        case "ADF_IDENTITY_B":
          // Second FS I identity read after ADF reset cycle (or inter-page loop).
          // JPEG initial setup: proceed directly to gamma phase.
          // PDF initial setup: an extra ESC e + source param follows before gamma.
          // Inter-page loop (duplex): always enter gamma directly — no ESC e for PDF here.
          if (pkt.payload.length !== 80) {
            return fail(`expected 80-byte identity in ADF_IDENTITY_B, got ${pkt.payload.length}`);
          }
          if (session.format === "pdf" && !inInterPageLoop) {
            state = "ADF_PDF_SRC_CMD";
            sendCmd(buildEscE(), 1);
            sendCmd(Buffer.from([SOURCE_BYTE[session.source]]), 1);
          } else {
            // Inter-page loop: flag has been consumed by STATUS_1B and now here;
            // reset it so it's not stuck true for any future multi-sheet iterations.
            inInterPageLoop = false;
            enterGammaPhase();
          }
          return;

        case "ADF_PDF_SRC_CMD":
          // ACK for ESC e opcode in the ADF+PDF post-identity source re-set.
          if (!isAck(pkt)) return fail(`expected ACK for ADF+PDF post-identity ESC e opcode`);
          state = "ADF_PDF_SRC_PARAM";
          return;

        case "ADF_PDF_SRC_PARAM":
          // ACK for source param byte in the ADF+PDF post-identity source re-set.
          if (!isAck(pkt)) return fail(`expected ACK for ADF+PDF post-identity source param`);
          enterGammaPhase();
          return;

        case "GAMMA_CMD": {
          if (!isAck(pkt)) return fail(`expected ESC z ack (channel ${gammaChannelIdx})`);
          const ch = GAMMA_CHANNELS[gammaChannelIdx];
          state = "GAMMA_DATA";
          sendCmd(Buffer.concat([Buffer.from([ch.tag]), ch.lut]), 1);
          return;
        }

        case "GAMMA_DATA":
          if (!isAck(pkt)) return fail(`expected gamma LUT ack (channel ${gammaChannelIdx})`);
          if (gammaChannelIdx + 1 < GAMMA_CHANNELS.length) {
            gammaChannelIdx++;
            state = "GAMMA_CMD";
            sendCmd(buildEscZ(), 1);
          } else {
            gammaChannelIdx = 0;
            state = "WINDOW_CMD";
            sendCmd(buildFsW(), 1);
          }
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
          // If chunkSize=0, the scanner is not yet ready (ADF still feeding paper).
          // Poll FS F until status byte[0]=0x01 (ready), then re-send FS G.
          if (fsGReply.chunkSize === 0) {
            log.debug("START: FS G returned chunkSize=0, entering not-ready poll loop");
            state = "START_POLL";
            sendCmd(buildFsF(), 16);
            return;
          }
          expectedBytes = computeExpectedBytes(session.source, session.format);
          imageBuffer = Buffer.alloc(expectedBytes);
          imageBufferOffset = 0;
          log.debug(`START: expectedBytes=${expectedBytes}, chunkSize=${fsGReply.chunkSize}`);
          // Send stream-config IS-0x2200 immediately; no reply expected before image stream starts
          send(buildIsPacket(0x2200, buildStreamConfigPayload(fsGReply, session.format)));
          state = "IMG_RECEIVING";
          return;
        }

        case "START_POLL":
          // FS F status poll during FS G not-ready retry loop.
          // Keep polling until status byte[0]=0x01 (scanner ready), then do one more confirmation poll.
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status in START_POLL, got ${pkt.payload.length}`);
          }
          log.debug(`START_POLL: status byte 0x${pkt.payload[0].toString(16)}`);
          state = pkt.payload[0] === 0x01 ? "START_POLL_READY" : "START_POLL";
          sendCmd(buildFsF(), 16);
          return;

        case "START_POLL_READY":
          // Final FS F reply after seeing status=0x01; now re-send FS G.
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status in START_POLL_READY, got ${pkt.payload.length}`);
          }
          log.debug(
            `START_POLL_READY: status byte 0x${pkt.payload[0].toString(16)}, re-sending FS G`,
          );
          state = "START";
          sendCmd(buildFsG(), 14);
          return;

        case "IMG_RECEIVING":
          if (pkt.type !== 0xa200) {
            return fail(
              `expected IS-0xa200 image chunk, got 0x${pkt.type.toString(16)} in state IMG_RECEIVING`,
            );
          }
          imageBufferOffset = appendImageChunk(pkt.payload, imageBuffer, imageBufferOffset);
          if (imageBufferOffset >= expectedBytes) {
            // Transition to PAGE_ENCODING immediately to absorb any trailing image chunks
            // while the async JPEG encoding runs in the background.
            state = "PAGE_ENCODING";
            void onPageComplete();
          }
          return;

        case "PAGE_ENCODING":
          // Buffer IS-0xa200 image chunks for the next page (duplex) or trailing overflow
          // (single-page); they will be replayed into imageBuffer when IMG_RECEIVING re-opens.
          // Buffer all other packets and replay them once encoding completes.
          if (pkt.type === 0xa200) {
            deferredImageChunks.push(pkt.payload);
          } else {
            encodingDeferred.push({ type: pkt.type, payload: pkt.payload });
          }
          return;

        case "PAGE_EJECT_WAIT":
          // ACK for the ADF page-eject command (0x0c 0x00) sent after image stream ends.
          // Always poll ADF status after eject; STATUS_1A's handler decides whether to
          // continue the inter-page loop (status byte 0 = 0x01) or wrap up (0x81 = ADF empty).
          if (pkt.payload.length !== 1) {
            return fail(`expected 1-byte page-eject ACK, got ${pkt.payload.length}`);
          }
          log.debug(`PAGE_EJECT_WAIT: eject ACK 0x${pkt.payload[0].toString(16)}`);
          // Duplex: after an odd-numbered completed page (1, 3, ...), the next page
          // is the back side of the same sheet.
          // Pages are 1-indexed: 1 (front), 2 (back), 3 (front), 4 (back) ... so back-pages
          // are even indices. We push them as we discover them.
          if (session.source === "adf-duplex" && pageJpegPaths.length % 2 === 1) {
            backPageIndices.push(pageJpegPaths.length + 1);
            // We push speculatively (next page may not arrive on hardware fault).
            // composePdfFromJpegs uses Set.has() so a dangling index is benign.
          }
          inInterPageLoop = true;
          state = "STATUS_1A";
          sendCmd(buildFsF(), 16);
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
          // ESC ) may return 0x80 (NAK) or 0x06 (ACK).
          // ADF: after first ESC ), re-set source (ESC e + param + FS F) before 2nd ESC ).
          // Flatbed: send second ESC ) directly.
          if (pkt.payload.length !== 1) {
            return fail(`expected 1-byte CLEANUP_1 reply, got ${pkt.payload.length}`);
          }
          log.debug(`CLEANUP_1: ESC ) returned 0x${pkt.payload[0].toString(16)}`);
          if (session.source !== "flatbed") {
            state = "ADF_CLEANUP_SRC_CMD";
            sendCmd(buildEscE(), 1);
            sendCmd(Buffer.from([SOURCE_BYTE[session.source]]), 1);
          } else {
            state = "CLEANUP_2";
            sendCmd(buildEscCleanup(), 1);
          }
          return;

        case "ADF_CLEANUP_SRC_CMD":
          // ACK for ESC e opcode during ADF post-scan cleanup.
          if (!isAck(pkt)) return fail(`expected ACK for ADF cleanup ESC e opcode`);
          state = "ADF_CLEANUP_SRC_PARAM";
          return;

        case "ADF_CLEANUP_SRC_PARAM":
          // ACK for source param byte during ADF post-scan cleanup.
          if (!isAck(pkt)) return fail(`expected ACK for ADF cleanup source param`);
          state = "ADF_CLEANUP_STATUS";
          sendCmd(buildFsF(), 16);
          return;

        case "ADF_CLEANUP_STATUS":
          if (pkt.payload.length !== 16) {
            return fail(`expected 16-byte status in ADF_CLEANUP_STATUS, got ${pkt.payload.length}`);
          }
          log.debug(`ADF_CLEANUP_STATUS: status byte 0x${pkt.payload[0].toString(16)}`);
          state = "CLEANUP_2";
          sendCmd(buildEscCleanup(), 1);
          return;

        case "CLEANUP_2":
          // May return 0x80 (NAK); both values are acceptable.
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
        let jpg = await encodeRawGbrToJpeg(
          imageBuffer,
          geom.widthPx,
          geom.heightPx,
          session.jpegQuality,
        );
        if (getState() === "ERROR") return; // bail if fail() ran during the ~8s encode
        const pageNum = pageJpegPaths.length + 1;
        // Duplex: even-numbered pages (2, 4, …) are back pages and come out rotated 180° due to
        // the ADF U-turn path. Insert EXIF Orientation=3 so viewers render them right-side up.
        if (session.source === "adf-duplex" && pageNum % 2 === 0) {
          jpg = setJpegOrientation(jpg, 3);
        }
        const jpgPath = path.join(sessionTempDir, `page_${String(pageNum).padStart(2, "0")}.jpg`);
        fs.writeFileSync(jpgPath, jpg);
        pageJpegPaths.push(jpgPath);
        log.debug(`Page ${pageNum} encoded, ${jpg.length} bytes -> ${jpgPath}`);
      } catch (err) {
        fail(`raw-to-jpeg encoding failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      if (getState() === "ERROR") return; // also bail before transitioning

      // Flatbed: skip eject; go straight to POST_STATUS.
      // ADF: send 0x0c 0x00 page-eject, wait for ACK, then FS F in PAGE_EJECT_WAIT handler.
      if (session.source !== "flatbed") {
        state = "PAGE_EJECT_WAIT";
        sendCmd(buildPageEject(), 1);
      } else {
        state = "POST_STATUS";
        sendCmd(buildFsF(), 16);
      }

      // Replay non-image packets that were buffered during PAGE_ENCODING.
      // Stop as soon as the state transitions to IMG_RECEIVING — the remaining items belong
      // to the next page's post-scan phase and must wait until that page's image stream
      // has been received. Re-queue them into encodingDeferred so that the next
      // onPageComplete invocation picks them up.
      const deferred = encodingDeferred.splice(0);
      for (let i = 0; i < deferred.length; i++) {
        if (getState() === "ERROR" || getState() === "DONE") return;
        try {
          handle(deferred[i]);
        } catch (err) {
          fail(
            `deferred packet handler threw: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        // After handle(), if we transitioned to IMG_RECEIVING, the next-page image data has not
        // arrived yet. Re-queue remaining items for the next onPageComplete deferred replay.
        if (getState() === "IMG_RECEIVING") {
          for (let j = i + 1; j < deferred.length; j++) {
            encodingDeferred.push(deferred[j]);
          }
          break;
        }
      }

      // If deferred control replay brought us into IMG_RECEIVING (next page in multi-page run),
      // drain any IS-0xa200 image chunks that arrived while we were encoding the previous page.
      // Single-page final: deferredImageChunks are trailing overflow and are discarded.
      if (getState() === "IMG_RECEIVING" && deferredImageChunks.length > 0) {
        const imageChunks = deferredImageChunks.splice(0);
        for (let i = 0; i < imageChunks.length; i++) {
          if (getState() !== "IMG_RECEIVING") break;
          const chunk = imageChunks[i];
          imageBufferOffset = appendImageChunk(chunk, imageBuffer, imageBufferOffset);
          if (imageBufferOffset >= expectedBytes) {
            // Page filled. Any remaining chunks in imageChunks belong to a subsequent page —
            // put them back into deferredImageChunks so the next onPageComplete can drain them.
            for (let j = i + 1; j < imageChunks.length; j++) {
              deferredImageChunks.push(imageChunks[j]);
            }
            state = "PAGE_ENCODING";
            void onPageComplete();
            break;
          }
        }
      } else {
        // Discard any lingering image chunks (e.g. trailing overflow on the final page).
        deferredImageChunks.length = 0;
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
          action: session.format,
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

function isAck(pkt: { payload: Buffer }): boolean {
  return pkt.payload.length === 1 && pkt.payload[0] === ACK_BYTE;
}

function computeExpectedBytes(source: Source, format: Format): number {
  const geom = geometry({ source, format });
  return geom.widthPx * geom.heightPx * 3;
}

/**
 * Copy the pixel-byte tail of an IS-0xa200 chunk payload into `dest` at `offset`.
 * Each chunk's payload is [status, ...pixels]; the status byte is discarded.
 * Returns the new offset.
 */
export function appendImageChunk(payload: Buffer, dest: Buffer, offset: number): number {
  if (payload.length === 0) return offset;
  payload.copy(dest, offset, 1);
  return offset + payload.length - 1;
}
