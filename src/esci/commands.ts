/**
 * Legacy ESC/I command builders for the WF-3620 protocol generation.
 * Byte literals from .reference/wireshark-captures/wf-3620/protocol-decode.md.
 *
 * These return only the command opcode bytes; parameter bytes (e.g. the
 * source-byte argument to ESC e, or the channel tag + LUT body for ESC z)
 * travel as separate writes through the IS passthru envelope.
 */

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

const FORMAT_BYTE: Record<Format, number> = {
  jpg: 0x04,
  pdf: 0x08,
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
 *   byte  28    : format (0x04=JPEG, 0x08=PDF)
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
  buf.writeUInt8(FORMAT_BYTE[mode.format], 28);
  buf.writeUInt8(0x04, 29);
  buf.writeUInt8(0x00, 30);
  buf.writeUInt8(0x01, 31);
  return buf;
}

export function geometry(mode: ScanMode): ScanGeometry {
  return geometryFor(mode.source, mode.format);
}

export interface FsGReply {
  /** First 2 bytes — status flags. We don't decode bits; just preserve. */
  statusWord: number;
  /** LE u32 at bytes 2-5: per-chunk transport size used by IS-0xa200 frames. */
  chunkSize: number;
  /** LE u32 at bytes 6-9: bytes per scanline as the firmware sees it. Used in IS-0x2200 stream-config. */
  bytesPerLine: number;
  /** LE u32 at bytes 10-13: total scanlines. Used in IS-0x2200 stream-config. */
  totalLines: number;
}

export function parseFsGReply(buf: Buffer): FsGReply {
  if (buf.length !== 14) {
    throw new Error(`FS G reply must be 14 bytes, got ${buf.length}`);
  }
  return {
    statusWord: buf.readUInt16BE(0),
    chunkSize: buf.readUInt32LE(2),
    bytesPerLine: buf.readUInt32LE(6),
    totalLines: buf.readUInt32LE(10),
  };
}

/**
 * The 38-byte payload of the IS-0x2200 packet the host sends immediately
 * after FS G's reply.
 *
 * Layout:
 *   bytes 0-3   : BE u32 = 30 (length of the trailing sub-payload, bytes 8-37)
 *   bytes 4-7   : zero
 *   --- end of 8-byte preamble ---
 *   bytes 8-9   : zero
 *   bytes 10-11 : BE u16 = bytesPerLine low 16 (0x06d6 JPEG / 0x01b5 PDF)
 *   bytes 12-15 : zero
 *   bytes 16-19 : BE u32 = chunkSize + 1 (0xe851 in all six captures)
 *   bytes 20-23 : BE u32 = 1
 *   bytes 24-27 : BE u32 = chunkSize + 1 (duplicate)
 *   bytes 28-31 : LE u32 = 6 (constant; meaning unknown)
 *   byte 32     : 0x01 (constant — purpose unknown but consistent across captures)
 *   byte 33     : 0x00
 *   bytes 34-37 : LE u32 = format-keyed empirical constant
 *                  JPEG: 0x06297400 (wire bytes 00 74 29 06)
 *                  PDF:  0x06339100 (wire bytes 00 91 33 06)
 *
 * The format-keyed constant matches across flatbed/ADF/duplex captures
 * (only format affects it). We have not derived an algorithmic formula
 * from FS G fields, so we hardcode the two observed values per format.
 */
const TOTAL_BYTES_FIELD: Record<Format, number> = {
  jpg: 0x06297400,
  pdf: 0x06339100,
};

export function buildStreamConfigPayload(reply: FsGReply, format: Format): Buffer {
  const buf = Buffer.alloc(38);
  buf.writeUInt32BE(0x0000001e, 0);
  buf.writeUInt16BE(reply.bytesPerLine & 0xffff, 10);
  buf.writeUInt32BE(reply.chunkSize + 1, 16);
  buf.writeUInt32BE(1, 20);
  buf.writeUInt32BE(reply.chunkSize + 1, 24);
  buf.writeUInt32LE(6, 28);
  buf.writeUInt8(0x01, 32);
  buf.writeUInt32LE(TOTAL_BYTES_FIELD[format], 34);
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
