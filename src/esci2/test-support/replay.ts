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
