import { readFileSync } from "node:fs";
import { buildIsPacket } from "../../protocol.js";
import type { FakeTcpSocket } from "./fake-tcp-socket.js";

export type { FixtureEvent } from "../../../tools/pcap-extract/extract.js";

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
 * Drive a fixture replay: connect the fake socket, feed all printer→host events in
 * order (with a setImmediate yield before each to let the state machine process the
 * previous reply), then await the session promise.
 *
 * Synthesised image streams yield between every packet, not just between events.
 * Without that, fake.feed() is synchronous (emit → handler → recvChunks.push), the
 * engine pump's re-entrancy guard short-circuits subsequent void tryDispatch() calls
 * while the first await is suspended, and the whole stream accumulates in recvChunks
 * before the pump gets a chance to drain. Per-packet yields keep peak bounded.
 */
export async function driveFixture(
  fixture: FixtureEvent[],
  fake: FakeTcpSocket,
  sessionPromise: Promise<void>,
): Promise<void> {
  fake.simulateConnect();
  for (const event of fixture) {
    if (event.dir !== "p>h") continue;
    await new Promise((r) => setImmediate(r));
    if ("hex" in event) {
      fake.feed(Buffer.from(event.hex, "hex"));
    } else {
      for (const p of synthesiseImageStream(event.totalBytes, event.chunkSize)) {
        fake.feed(p);
        await new Promise((r) => setImmediate(r));
      }
    }
  }
  await sessionPromise;
}

/**
 * Synthesise an IS-0xa200 image stream of `totalBytes` total bytes from
 * fixed-fill chunks of `chunkSize` (last chunk may be short).
 *
 * Used by replay tests to substitute for the real ~108 MB pixel stream
 * that we never commit. The fill byte is 0xb0 — a mid-grey RGB triplet
 * that yields a recognisable JPEG when sharp encodes it (useful for
 * eyeballing test failures).
 */
function* synthesiseImageStream(totalBytes: number, chunkSize: number): Generator<Buffer> {
  if (chunkSize > MAX_CHUNK_SIZE) {
    throw new Error(`synthesiseImageStream: chunkSize ${chunkSize} exceeds MAX_CHUNK_SIZE`);
  }
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    yield buildIsPacket(0xa200, FILL_BUFFER.subarray(0, size));
    remaining -= size;
  }
}
