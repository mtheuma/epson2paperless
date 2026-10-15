// src/esci2/test-support/replay.ts
//
// Replay-fixture driver for the ESC/I-2-over-plain-TCP path. Mirrors
// `src/esci/test-support/replay.ts`'s shape (loadFixture + driveFixture)
// but uses the ESC/I-2 `FakePlainSocket` and the ESC/I-2 fixture format.
//
// The pcap-extract JSONL events come in two shapes:
//   - { dir: "h>p" | "p>h"; ts; hex }  — concrete bytes
//   - { dir: "p>h"; ts; summary: "image-stream"; ... }  — synthesised
//     image-stream record (only emitted for ESC/I 0xa200 traffic; the
//     ESC/I-2 IMG cycle wraps pixels in 0xa000 IS frames so this branch
//     is never reached for ET-2750 fixtures, but we keep the type guard
//     so a future ESC/I-2 fixture with the summary shape doesn't crash
//     this driver).

import { readFileSync } from "node:fs";
import type { FakePlainSocket } from "./fake-plain-socket.js";

export type { FixtureEvent } from "../../../tools/pcap-extract/extract.js";

import type { FixtureEvent } from "../../../tools/pcap-extract/extract.js";

export function loadFixture(path: string): FixtureEvent[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FixtureEvent);
}

/**
 * Drive a fixture replay: connect the fake socket, feed all printer→host
 * events in order (with a setImmediate yield before each to let the state
 * machine process the previous reply), then await the session promise.
 *
 * Image-stream summary records are deliberately rejected — ET-2750
 * fixtures shouldn't contain them, and a future ESC/I-2 fixture that
 * does would need a paired chunk-synthesiser like the legacy ESC/I
 * driver has. Surface the unsupported shape as a hard test failure
 * rather than silently skipping events.
 */
export async function driveFixture(
  fixture: FixtureEvent[],
  fake: FakePlainSocket,
  sessionPromise: Promise<void>,
): Promise<void> {
  fake.simulateConnect();
  for (const event of fixture) {
    if (event.dir !== "p>h") continue;
    await new Promise((r) => setImmediate(r));
    if ("hex" in event) {
      fake.feed(Buffer.from(event.hex, "hex"));
      continue;
    }
    throw new Error(`driveFixture (esci2-plain): unsupported event shape ${JSON.stringify(event)}`);
  }
  await sessionPromise;
}

// Recover the PARA body bytes the scanner emitted, by searching the fake
// socket's accumulated writes for the same "PARAx0000NNN" header and
// peeling off the body wrapper.
export function extractScannerParaWrite(fake: FakePlainSocket): Buffer {
  const PARA_HDR = Buffer.from("PARAx", "ascii");
  for (let i = 0; i < fake.writes.length; i++) {
    const w = fake.writes[i];
    const idx = w.indexOf(PARA_HDR);
    if (idx < 0) continue;
    // PARA header is "PARAx" + 7 ASCII hex chars; the size is encoded there.
    const lenAscii = w.subarray(idx + 5, idx + 12).toString("ascii");
    const declared = parseInt(lenAscii, 16);
    // Body wrapper is the next write. Skip 12-byte IS header + 8-byte preamble.
    const bodyWrite = fake.writes[i + 1];
    if (!bodyWrite) throw new Error("extractScannerParaWrite: body write missing");
    return bodyWrite.subarray(20, 20 + declared);
  }
  throw new Error("extractScannerParaWrite: PARA header write not found");
}
