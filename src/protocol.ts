export const IS_HEADER_SIZE = 12;
const IS_MAGIC = Buffer.from("IS", "ascii");

export interface IsPacket {
  type: number;
  payloadSize: number;
  payload: Buffer;
  totalSize: number;
}

export function parseIsPacket(data: Buffer): IsPacket | null {
  if (data.length < IS_HEADER_SIZE) return null;
  if (data[0] !== IS_MAGIC[0] || data[1] !== IS_MAGIC[1]) return null;

  const type = data.readUInt16BE(2);
  const payloadSize = data.readUInt32BE(6);
  const totalSize = IS_HEADER_SIZE + payloadSize;

  if (data.length < totalSize) return null;

  const payload = data.subarray(IS_HEADER_SIZE, totalSize);
  return { type, payloadSize, payload, totalSize };
}

/**
 * Builds an IS packet. The 2-byte offset field at bytes 4-5 is always 0x000C
 * (confirmed by the Frida capture against the Windows driver's output).
 */
export function buildIsPacket(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const packet = Buffer.alloc(IS_HEADER_SIZE + payload.length);
  packet.write("IS", 0, "ascii");
  packet.writeUInt16BE(type, 2);
  packet.writeUInt16BE(0x000c, 4);
  packet.writeUInt32BE(payload.length, 6);
  payload.copy(packet, IS_HEADER_SIZE);
  return packet;
}

/**
 * Lock packet (type 0x2100). No data header needed.
 */
export function buildLockPacket(): Buffer {
  const payload = Buffer.from([0x01, 0xa0, 0x04, 0x00, 0x00, 0x01, 0x2c]);
  return buildIsPacket(0x2100, payload);
}

/**
 * Unlock packet (type 0x2101). Header only, no payload.
 */
export function buildUnlockPacket(): Buffer {
  return buildIsPacket(0x2101, Buffer.alloc(0));
}

/**
 * Passthru envelope (IS type 0x2000) with an 8-byte preamble.
 * Format: IS header + [cmd_size_BE (4 bytes)] + [reply_size_BE (4 bytes)] + command bytes.
 * `command` may be legacy 2-byte raw bytes (FS Y, FS X), ESC/I-2 headers
 * (12-byte "NAMEx0000000"), or raw parameter bytes (PARA phase-2 payload).
 */
export function buildPassthruPacket(esciCommand: Buffer, replySize: number): Buffer {
  const dataHeader = Buffer.alloc(8);
  dataHeader.writeUInt32BE(esciCommand.length, 0);
  dataHeader.writeUInt32BE(replySize, 4);
  const payload = Buffer.concat([dataHeader, esciCommand]);
  return buildIsPacket(0x2000, payload);
}

/**
 * Pure-read passthru (IS type 0x2000 with cmd_size=0). Pulls `replySize`
 * bytes of queued data from the printer without sending a command.
 * Used in the IMG loop to fetch image-chunk bytes after IMG's metadata
 * reply declares the chunk size.
 */
export function buildPurereadPacket(replySize: number): Buffer {
  const dataHeader = Buffer.alloc(8);
  dataHeader.writeUInt32BE(0, 0);
  dataHeader.writeUInt32BE(replySize, 4);
  return buildIsPacket(0x2000, dataHeader);
}
