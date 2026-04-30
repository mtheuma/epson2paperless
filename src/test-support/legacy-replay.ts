import { readFileSync } from "node:fs";
import { buildIsPacket } from "../protocol.js";

export type { FixtureEvent } from "../../tools/pcap-extract/extract.js";

export function loadFixture(path: string): FixtureEvent[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FixtureEvent);
}

const MAX_CHUNK_SIZE = 65536;
const FILL_BUFFER = Buffer.alloc(MAX_CHUNK_SIZE, 0xb0);

/**
 * Synthesise an IS-0xa200 image stream of `totalBytes` total bytes from
 * fixed-fill chunks of `chunkSize` (last chunk may be short).
 *
 * Used by replay tests to substitute for the real ~108 MB pixel stream
 * that we never commit. The fill byte is 0xb0 — a mid-grey RGB triplet
 * that yields a recognisable JPEG when sharp encodes it (useful for
 * eyeballing test failures).
 */
export function synthesiseImageStream(totalBytes: number, chunkSize: number): Buffer[] {
  if (chunkSize > MAX_CHUNK_SIZE) {
    throw new Error(`synthesiseImageStream: chunkSize ${chunkSize} exceeds MAX_CHUNK_SIZE`);
  }
  const out: Buffer[] = [];
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    out.push(buildIsPacket(0xa200, FILL_BUFFER.subarray(0, size)));
    remaining -= size;
  }
  return out;
}
