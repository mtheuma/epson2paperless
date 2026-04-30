import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startScanSessionLegacy } from "./scanner-legacy.js";
import { parseIsPacket } from "./protocol.js";
import { FakeTcpSocket } from "./test-support/fake-tcp-socket.js";
import { loadFixture, synthesiseImageStream } from "./test-support/legacy-replay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "tools", "pcap-extract", "captures", "wf-3620");

describe("scanner-legacy", () => {
  let outputDir: string;
  let tempDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "leg-out-"));
    tempDir = mkdtempSync(path.join(os.tmpdir(), "leg-tmp-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("adf-single-page-jpeg: replays driver bytes and writes one JPG", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-single-page-jpeg.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "adf-simplex",
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();

    for (const event of fixture) {
      if (event.dir !== "p>h") continue;
      await new Promise((r) => setImmediate(r));
      if ("hex" in event) {
        fake.feed(Buffer.from(event.hex, "hex"));
      } else {
        for (const packet of synthesiseImageStream(event.totalBytes, event.chunkSize)) {
          fake.feed(packet);
        }
      }
    }
    await sessionPromise;

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scan_.+\.jpg$/);
  }, 60_000);

  it("adf-single-page-jpeg: emits the 0x0c 0x00 page-eject after the image stream", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-single-page-jpeg.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "adf-simplex",
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();
    for (const event of fixture) {
      if (event.dir !== "p>h") continue;
      await new Promise((r) => setImmediate(r));
      if ("hex" in event) fake.feed(Buffer.from(event.hex, "hex"));
      else for (const p of synthesiseImageStream(event.totalBytes, event.chunkSize)) fake.feed(p);
    }
    await sessionPromise;

    // Flatten all writes and look for `0c 00` inside an IS-0x2000 passthru
    const allWrites = Buffer.concat(fake.writes);
    let pos = 0;
    let foundEject = false;
    while (pos < allWrites.length) {
      const pkt = parseIsPacket(allWrites.subarray(pos));
      if (!pkt) break;
      // IS-0x2000 passthru envelope: payload starts with 8-byte preamble (cmd_size + reply_size BE u32),
      // followed by the actual command bytes. The page-eject command body is `0c 00`.
      if (pkt.type === 0x2000 && pkt.payload.length >= 10) {
        const cmdSize = pkt.payload.readUInt32BE(0);
        if (cmdSize === 2) {
          const cmd = pkt.payload.subarray(8, 8 + 2);
          if (cmd[0] === 0x0c && cmd[1] === 0x00) {
            foundEject = true;
            break;
          }
        }
      }
      pos += pkt.totalSize;
    }
    expect(foundEject).toBe(true);
  }, 60_000);

  it("flatbed-single-page-jpeg: replays driver bytes and writes one JPG", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "flatbed-single-page-jpeg.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "flatbed",
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();

    // Drive the protocol by feeding each "p>h" event in fixture order
    // (the scanner's state machine emits the matching "h>p" command in response).
    for (const event of fixture) {
      if (event.dir !== "p>h") continue;
      await new Promise((r) => setImmediate(r));
      if ("hex" in event) {
        fake.feed(Buffer.from(event.hex, "hex"));
      } else if (event.summary === "image-stream") {
        for (const packet of synthesiseImageStream(event.totalBytes, event.chunkSize)) {
          fake.feed(packet);
        }
      }
    }
    await sessionPromise;

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scan_.+\.jpg$/);
    const jpegBytes = readFileSync(path.join(outputDir, files[0]));
    // SOI marker
    expect(jpegBytes[0]).toBe(0xff);
    expect(jpegBytes[1]).toBe(0xd8);
  }, 60_000); // Sharp encodes ~104 MB raw RGB; allow up to 60 s on slow machines / CI
});
