import { buildPassthruPacket } from "../../protocol.js";

/**
 * Wraps an ESC/I command in the IS passthru envelope. `replySize` is part of
 * the wire transcript (e.g. `ESC I` is sent with reply size 4) — callers must
 * pass the size the capture shows, not a computed guess.
 */
export function passthru(cmd: Buffer, replySize: number): Buffer {
  return buildPassthruPacket(cmd, replySize);
}
