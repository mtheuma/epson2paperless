import { IS_HEADER_SIZE } from "./protocol.js";

export interface IsFrame {
  type: number;
  payload: Buffer; // bytes after the 12-byte IS header
  frame: Buffer; // the complete frame (header + payload) — lets consumers re-emit losslessly
}
export interface IsFrameReader {
  feed(bytes: Buffer, onFrame: (f: IsFrame) => void): void;
  finish(): void;
}

/** Streaming IS-frame reader: accumulates bytes across feed() calls and emits
 *  each COMPLETE IS frame (walking by declared payload length, never scanning
 *  for magic — so `49 53` inside a pixel payload can't false-trigger). finish()
 *  throws on any leftover partial bytes rather than silently accepting a
 *  truncated/corrupt stream. */
export function createIsFrameReader(): IsFrameReader {
  let pending: Buffer = Buffer.alloc(0);
  return {
    feed(bytes, onFrame) {
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
      let off = 0;
      while (pending.length - off >= IS_HEADER_SIZE) {
        if (pending[off] !== 0x49 || pending[off + 1] !== 0x53) {
          throw new Error(
            `is-frame-stream: lost framing at offset ${off} (0x${pending[off].toString(16)})`,
          );
        }
        const type = pending.readUInt16BE(off + 2);
        const size = pending.readUInt32BE(off + 6);
        const frameLen = IS_HEADER_SIZE + size;
        if (pending.length - off < frameLen) break; // wait for more bytes
        const frame = pending.subarray(off, off + frameLen);
        onFrame({ type, payload: frame.subarray(IS_HEADER_SIZE), frame });
        off += frameLen;
      }
      pending = pending.subarray(off);
    },
    finish() {
      if (pending.length > 0) {
        throw new Error(
          `is-frame-stream: ${pending.length} leftover bytes at finish (truncated stream?)`,
        );
      }
    },
  };
}
