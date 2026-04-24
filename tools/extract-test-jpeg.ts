// One-shot utility: replay the 1p-simplex Frida capture through the real
// scanner state machine and copy the resulting JPEG to
// test-fixtures/sample-page.jpg. Using the scanner (rather than naive
// body-concatenation) ensures the output contains only IMG_DATA chunks,
// not ESC/I-2 metadata replies interleaved between them.
//
// Run with: npx tsx tools/extract-test-jpeg.ts

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startScanSession } from "../src/scanner.js";
import { FakeTlsSocket } from "../src/test-support/fake-tls-socket.js";

const CAPTURE = "tools/frida-capture/captures/2026-04-24T08-56-07-adf-1p-simplex.jsonl";
const OUT = "test-fixtures/sample-page.jpg";

interface CaptureRecord {
  hook: "startup" | "waiting" | "send" | "recv" | "error" | "async_event";
  type_hex?: string;
  payload_hex?: string;
  payload_size?: number;
}

/**
 * Trim the driver's variable STAT-cycle count to 3, matching the scanner.
 * Mirrors the logic in src/scanner.test.ts::trimStatCycles.
 */
function trimStatCycles(records: CaptureRecord[], keep: number): CaptureRecord[] {
  const sendIndices = records.map((r, i) => (r.hook === "send" ? i : -1)).filter((i) => i !== -1);
  if (sendIndices.length < 16) {
    throw new Error(`trimStatCycles: capture has only ${sendIndices.length} sends, expected ≥ 16`);
  }
  const statLoopStart = sendIndices[15];
  const fsXRecord = records.findIndex((r) => r.hook === "send" && r.payload_hex?.endsWith("1c58"));
  if (fsXRecord === -1) {
    throw new Error("trimStatCycles: no FS X send found (payload ending 1c58)");
  }
  const recordsPerStatCycle = 9;
  const trimmedStatEnd = statLoopStart + keep * recordsPerStatCycle;
  return [...records.slice(0, trimmedStatEnd), ...records.slice(fsXRecord)];
}

const records: CaptureRecord[] = fs
  .readFileSync(CAPTURE, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-jpeg-"));

async function main() {
  const trimmed = trimStatCycles(records, 3);
  const filtered = trimmed.filter((r) => r.hook === "send" || r.hook === "recv");

  const fake = new FakeTlsSocket();
  void startScanSession(
    {
      printerIp: "192.0.2.58",
      port: 1865,
      destId: 0x02,
      outputDir,
      tempDir: "",
      duplex: false,
      action: "jpg",
    },
    fake.asFactory(),
  );
  fake.simulateConnect();

  for (const rec of filtered) {
    if (rec.hook === "recv") {
      fake.feed(Buffer.from(rec.payload_hex ?? "", "hex"));
      await new Promise((r) => setImmediate(r));
    }
  }

  // Let async write + promote complete.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }

  const files = fs.readdirSync(outputDir).filter((n) => n.endsWith(".jpg"));
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly 1 JPEG in ${outputDir}, got ${files.length}: ${files.join(", ")}`,
    );
  }

  const produced = fs.readFileSync(path.join(outputDir, files[0]));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, produced);

  const soi = produced.slice(0, 3).toString("hex");
  const eoi = produced.slice(-2).toString("hex");
  console.log(`Wrote ${OUT} (${produced.length} bytes, SOI=${soi}, EOI=${eoi})`);

  fs.rmSync(outputDir, { recursive: true, force: true });
}

main().catch((err) => {
  fs.rmSync(outputDir, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
