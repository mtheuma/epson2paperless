/**
 * Legacy ESC/I command builders for the WF-3620 protocol generation.
 * Byte literals from .reference/wireshark-captures/wf-3620/protocol-decode.md.
 *
 * These return only the command opcode bytes; parameter bytes (e.g. the
 * source-byte argument to ESC e, or the channel tag + LUT body for ESC z)
 * travel as separate writes through the IS passthru envelope.
 */

import { extractPid } from "../printer-ids.js";

export function buildEscInit(): Buffer {
  return Buffer.from([0x1b, 0x40]);
}

export function buildFsI(): Buffer {
  return Buffer.from([0x1c, 0x49]);
}

export function buildFsF(): Buffer {
  return Buffer.from([0x1c, 0x46]);
}

export function buildEscE(): Buffer {
  return Buffer.from([0x1b, 0x65]);
}

export function buildEscZ(): Buffer {
  return Buffer.from([0x1b, 0x7a]);
}

export function buildFsW(): Buffer {
  return Buffer.from([0x1c, 0x57]);
}

export function buildFsG(): Buffer {
  return Buffer.from([0x1c, 0x47]);
}

/** ESC ( — sent before source-set to check if scanner is ready; returns 0x06 (ready) or 0x80 (busy). */
export function buildEscParen(): Buffer {
  return Buffer.from([0x1b, 0x28]);
}

export function buildEscCleanup(): Buffer {
  return Buffer.from([0x1b, 0x29]);
}

/** Sent after each ADF page's image stream completes. Flatbed never emits this. */
export function buildPageEject(): Buffer {
  return Buffer.from([0x0c, 0x00]);
}

export type Source = "flatbed" | "adf-simplex" | "adf-duplex";
export type Format = "jpg" | "pdf";
export interface ScanMode {
  source: Source;
  format: Format;
}

export const SOURCE_BYTE: Record<Source, number> = {
  flatbed: 0x00,
  "adf-simplex": 0x01,
  "adf-duplex": 0x02,
};

/**
 * Scanlines per transfer block (FS W byte 28) for each WF-3620 format. The
 * format only matters through its resolution: 4 lines at 600 dpi (JPG) and
 * 8 at 300 dpi (PDF) both make a 59472-byte block, which the FS G reply then
 * reports as its block size.
 */
const LINES_PER_BLOCK: Record<Format, number> = {
  jpg: 4,
  pdf: 8,
};

export interface ScanGeometry {
  dpi: number;
  widthPx: number;
  heightPx: number;
  topYOffsetPx: number;
}

/**
 * Returns the geometry the firmware uses for a given (format, source).
 * Values reproduced verbatim from the captured FS W blocks.
 *
 * Only A4 is captured. Adding US Letter or other sizes requires a fresh
 * capture (the panel triggers different byte values for each).
 */
function geometryFor(source: Source, format: Format): ScanGeometry {
  const dpi = format === "jpg" ? 600 : 300;
  const scale = dpi / 600;
  const widthPx = Math.round(4956 * scale);
  const heightPx = Math.round(7002 * scale);
  const adfTopY = format === "jpg" ? 142 : 71;
  const topYOffsetPx = source === "flatbed" ? 0 : adfTopY;
  return { dpi, widthPx, heightPx, topYOffsetPx };
}

/**
 * Build the 64-byte parameter block sent immediately after FS W.
 * Layout (all little-endian):
 *   bytes 0-3   : X DPI
 *   bytes 4-7   : Y DPI
 *   bytes 8-11  : top-Y offset (ADF only)
 *   bytes 12-15 : left-X offset (constant 0)
 *   bytes 16-19 : width  (px)
 *   bytes 20-23 : height (px)
 *   bytes 24-25 : 0x0813 (constant)
 *   byte  26    : source (0=flatbed, 1=ADF simplex, 2=ADF duplex)
 *   byte  27    : 0x00 (constant)
 *   byte  28    : scanlines per transfer block (4 at 600 dpi JPEG, 8 at 300 dpi PDF)
 *   bytes 29-31 : 0x04 0x00 0x01 (constant)
 *   bytes 32-63 : zero pad
 */
export function buildFsWBlock(mode: ScanMode): Buffer {
  const { dpi, widthPx, heightPx, topYOffsetPx } = geometryFor(mode.source, mode.format);
  const buf = Buffer.alloc(64);
  buf.writeUInt32LE(dpi, 0);
  buf.writeUInt32LE(dpi, 4);
  buf.writeUInt32LE(topYOffsetPx, 8);
  buf.writeUInt32LE(0, 12);
  buf.writeUInt32LE(widthPx, 16);
  buf.writeUInt32LE(heightPx, 20);
  buf.writeUInt16LE(0x0813, 24);
  buf.writeUInt8(SOURCE_BYTE[mode.source], 26);
  buf.writeUInt8(0x00, 27);
  buf.writeUInt8(LINES_PER_BLOCK[mode.format], 28);
  buf.writeUInt8(0x04, 29);
  buf.writeUInt8(0x00, 30);
  buf.writeUInt8(0x01, 31);
  return buf;
}

export function geometry(mode: ScanMode): ScanGeometry {
  return geometryFor(mode.source, mode.format);
}

/**
 * The 14-byte FS G reply describes how the page's image data will be split
 * into blocks: `blockCount` full blocks of `chunkSize` bytes each, then one
 * last block of `lastBlockBytes`. A full block holds the FS W block's
 * lines-per-block count of scanlines (byte 28); the last block holds the
 * lines left over. Each block arrives as one IS-0xa200 chunk carrying one
 * extra trailing status byte, so a page is `blockCount + 1` chunks.
 */
export interface FsGReply {
  /** First 2 bytes — status flags. We don't decode bits; just preserve. */
  statusWord: number;
  /**
   * LE u32 at bytes 2-5: byte count of each full block (lines per block ×
   * bytes per scanline). Zero means the printer is not ready to stream yet.
   */
  chunkSize: number;
  /** LE u32 at bytes 6-9: number of full blocks before the last block. */
  blockCount: number;
  /** LE u32 at bytes 10-13: byte count of the last block (the leftover scanlines). */
  lastBlockBytes: number;
}

export function parseFsGReply(buf: Buffer): FsGReply {
  if (buf.length !== 14) {
    throw new Error(`FS G reply must be 14 bytes, got ${buf.length}`);
  }
  return {
    statusWord: buf.readUInt16BE(0),
    chunkSize: buf.readUInt32LE(2),
    blockCount: buf.readUInt32LE(6),
    lastBlockBytes: buf.readUInt32LE(10),
  };
}

export interface FsIIdentity {
  /**
   * Canonical `PID XXXX` from the product field, in the same form as the
   * push-scan `ProductNameIn`; the trimmed raw text when the field holds no
   * PID token; null when it is blank.
   */
  productName: string | null;
  /** Firmware version text, e.g. "1.20"; null when blank. */
  firmware: string | null;
}

/**
 * Decode a space/NUL-padded ASCII field; blank → null. Bytes outside
 * printable ASCII come back as `\xNN`, so an unfamiliar layout can't put
 * control characters into a log line.
 */
function asciiField(buf: Buffer, start: number, end: number): string | null {
  const text = buf
    .toString("latin1", start, end)
    .replace(/[\s\0]+$/, "")
    .replace(/[^\x20-\x7e]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return text.length > 0 ? text : null;
}

/**
 * Decode the identity fields of the 80-byte FS I reply: a 16-byte product
 * field at offset 46 and a 4-byte firmware field at offset 62. Every legacy
 * capture fills them the same way, e.g. the WF-3620's `PID 08B8` + `1.20`,
 * the XP-620's `PID 08C8` + `1.10`, the ET-2550's `PID 1106` + `1.40`.
 */
export function parseFsIReply(buf: Buffer): FsIIdentity {
  if (buf.length !== 80) {
    throw new Error(`FS I reply must be 80 bytes, got ${buf.length}`);
  }
  const product = asciiField(buf, 46, 62);
  return {
    productName: extractPid(product) ?? product,
    firmware: asciiField(buf, 62, 66),
  };
}

const STREAM_CONFIG_TERMINATOR = 0x06;

/**
 * The last block's byte count for each WF-3620 format at its fixed A4
 * geometry: the scanlines left over after the full blocks, times the bytes
 * per scanline. 600 dpi JPEG: 7002 lines = 1750 × 4 + 2, so 2 × 4956 × 3.
 * 300 dpi PDF: 3501 lines = 437 × 8 + 5, so 5 × 2478 × 3. Each equals the
 * `lastBlockBytes` the FS G reply reports for that geometry.
 */
const LAST_BLOCK_BYTES: Record<Format, number> = {
  jpg: 29736,
  pdf: 37170,
};

/**
 * The 38-byte payload of the IS-0x2200 packet the host sends immediately
 * after FS G's reply. It restates the FS G block layout back to the printer.
 *
 * Layout (big-endian u32s):
 *   bytes 0-3   : 30 (length of the trailing sub-payload, bytes 8-37)
 *   bytes 4-7   : zero
 *   --- end of 8-byte preamble ---
 *   bytes 8-11  : FS G block count (full blocks before the last one)
 *   bytes 12-15 : zero
 *   bytes 16-19 : FS G block size + 1 (each block plus its trailing status byte)
 *   bytes 20-23 : 1
 *   bytes 24-27 : FS G block size + 1 (again)
 *   byte  28    : 0x06 terminator
 *   bytes 29-32 : 1
 *   bytes 33-36 : the last block's byte count + 1
 *   byte  37    : 0x06 terminator
 */
export function buildStreamConfigPayload(reply: FsGReply, format: Format): Buffer {
  const buf = Buffer.alloc(38);
  buf.writeUInt32BE(30, 0);
  buf.writeUInt32BE(reply.blockCount, 8);
  buf.writeUInt32BE(reply.chunkSize + 1, 16);
  buf.writeUInt32BE(1, 20);
  buf.writeUInt32BE(reply.chunkSize + 1, 24);
  buf.writeUInt8(STREAM_CONFIG_TERMINATOR, 28);
  buf.writeUInt32BE(1, 29);
  buf.writeUInt32BE(LAST_BLOCK_BYTES[format] + 1, 33);
  buf.writeUInt8(STREAM_CONFIG_TERMINATOR, 37);
  return buf;
}

export type DetectSourceResult = { ok: true; source: Source } | { ok: false; byte: number };

/**
 * Map the legacy FS F status byte (byte 0 of the 16-byte STATUS_2 reply)
 * to a scan source. The Windows driver's Wireshark captures show two known
 * values:
 *   - 0x81 → flatbed (no ADF paper / no ADF present)
 *   - 0x01 → ADF has paper; duplex flag from the panel disambiguates
 *            simplex vs duplex
 * Other values (jam, mid-feed, panel-vs-paper conflict, empty-tray for
 * ADF-equipped models with paperless trays) are not yet captured. Return
 * { ok: false, byte } so the caller can route through fail() with a
 * compatibility-issue message.
 */
export function legacyDetectSource(fsfByte: number, duplex: boolean): DetectSourceResult {
  if (fsfByte === 0x81) return { ok: true, source: "flatbed" };
  if (fsfByte === 0x01) return { ok: true, source: duplex ? "adf-duplex" : "adf-simplex" };
  return { ok: false, byte: fsfByte };
}

export function buildEscI(): Buffer {
  return Buffer.from([0x1b, 0x49]);
}

export function buildEscLowerI(): Buffer {
  return Buffer.from([0x1b, 0x69]);
}

export function buildEscE2(): Buffer {
  return Buffer.from([0x1b, 0xe2]);
}
