import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { runEsciScan, appendImageChunk } from "./scanner.js";
import { parseIsPacket, buildIsPacket, IS_HEADER_SIZE } from "../protocol.js";
import { FakeTcpSocket } from "./test-support/fake-tcp-socket.js";
import { loadFixture, driveFixture, concatHostBytes } from "./test-support/replay.js";
import { WF3620_ENTRY } from "./dialects/wf3620.js";
import { XP620_ENTRY } from "./dialects/xp620.js";
import type { LegacyDialectEntry } from "./dialects/entry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "..", "tools", "pcap-extract", "captures");

// ---------------------------------------------------------------------------
// Per-fixture metadata driving the it.each replay matrix
// ---------------------------------------------------------------------------

interface FixtureSpec {
  path: string; // relative to tools/pcap-extract/captures/
  format: "jpg" | "pdf";
  duplex: boolean; // panel-side Sides selection — drives ADF source
  entry: LegacyDialectEntry;
  expectedDetectedSource: "adf-simplex" | "adf-duplex" | "flatbed";
  expectedFileCount: number;
  expectedBackPages: number[]; // 1-based page numbers; [] for non-duplex
  expectedPdfPageCount?: number; // set for multi-page or rotation-checked PDFs
}

const FIXTURE_SPECS: FixtureSpec[] = [
  // Pure-detection: no forcedSource — STATUS_2 reads FS F.
  {
    path: "wf-3620/adf-single-page-jpeg.jsonl",
    format: "jpg",
    duplex: false,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "adf-simplex",
    expectedFileCount: 1,
    expectedBackPages: [],
  },
  {
    path: "wf-3620/adf-single-page-pdf.jsonl",
    format: "pdf",
    duplex: false,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "adf-simplex",
    expectedFileCount: 1,
    expectedBackPages: [],
  },
  {
    path: "wf-3620/adf-3-page-simplex-jpeg.jsonl",
    format: "jpg",
    duplex: false,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "adf-simplex",
    expectedFileCount: 3,
    expectedBackPages: [],
  },
  {
    path: "wf-3620/adf-3-page-simplex-pdf.jsonl",
    format: "pdf",
    duplex: false,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "adf-simplex",
    expectedFileCount: 1,
    expectedBackPages: [],
    expectedPdfPageCount: 3,
  },
  {
    path: "wf-3620/adf-2-page-jpeg.jsonl",
    format: "jpg",
    duplex: true,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "adf-duplex",
    expectedFileCount: 2,
    expectedBackPages: [2],
  },
  {
    path: "wf-3620/adf-2-page-pdf.jsonl",
    format: "pdf",
    duplex: true,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "adf-duplex",
    expectedFileCount: 1,
    expectedBackPages: [2],
    expectedPdfPageCount: 2,
  },
  {
    path: "wf-3620/adf-4-page-duplex-jpeg.jsonl",
    format: "jpg",
    duplex: true,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "adf-duplex",
    expectedFileCount: 4,
    expectedBackPages: [2, 4],
  },
  {
    path: "wf-3620/adf-4-page-duplex-pdf.jsonl",
    format: "pdf",
    duplex: true,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "adf-duplex",
    expectedFileCount: 1,
    expectedBackPages: [2, 4],
    expectedPdfPageCount: 4,
  },
  {
    path: "wf-3620/flatbed-single-page-jpeg.jsonl",
    format: "jpg",
    duplex: false,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "flatbed",
    expectedFileCount: 1,
    expectedBackPages: [],
  },
  {
    path: "wf-3620/flatbed-single-page-pdf.jsonl",
    format: "pdf",
    duplex: false,
    entry: WF3620_ENTRY,
    expectedDetectedSource: "flatbed",
    expectedFileCount: 1,
    expectedBackPages: [],
  },
  {
    path: "xp-620/flatbed.jsonl",
    format: "jpg",
    duplex: false,
    entry: XP620_ENTRY,
    expectedDetectedSource: "flatbed",
    expectedFileCount: 1,
    expectedBackPages: [],
    expectedPdfPageCount: undefined,
  },
  {
    path: "xp-620/flatbed.jsonl",
    format: "pdf",
    duplex: false,
    entry: XP620_ENTRY,
    expectedDetectedSource: "flatbed",
    expectedFileCount: 1,
    expectedBackPages: [],
    expectedPdfPageCount: 1,
  },
];

// ---------------------------------------------------------------------------
// Replay matrix
// ---------------------------------------------------------------------------

describe("scanner-esci", () => {
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

  it.each(FIXTURE_SPECS)(
    "$path: detects $expectedDetectedSource and produces $expectedFileCount file(s)",
    async ({
      path: fixturePath,
      format,
      duplex,
      entry,
      expectedDetectedSource,
      expectedFileCount,
      expectedBackPages,
      expectedPdfPageCount,
    }) => {
      const fixture = loadFixture(path.join(FIXTURES, fixturePath));
      const fake = new FakeTcpSocket();
      let detectedSource: string | null = null;

      const sessionPromise = runEsciScan(
        {
          printerIp: "1.2.3.4",
          port: 1865,
          outputDir,
          tempDir,
          entry,
          duplex,
          forcedSource: null, // pure detection — no override
          format,
          jpegQuality: 90,
          onSourceDetected: (s) => {
            detectedSource = s;
          },
        },
        fake.asFactory(),
      );
      await driveFixture(fixture, fake, sessionPromise);

      // Shield: the scanner reproduced the captured host transcript exactly.
      expect(Buffer.concat(fake.writes).toString("hex")).toBe(
        concatHostBytes(fixture).toString("hex"),
      );

      // Detection assertion — captured via the onSourceDetected hook.
      expect(detectedSource).toBe(expectedDetectedSource);

      const files = readdirSync(outputDir).sort();
      expect(files).toHaveLength(expectedFileCount);

      // Format-specific suffix assertion.
      if (format === "jpg") {
        for (const f of files) expect(f).toMatch(/\.jpg$/);
      } else {
        for (const f of files) expect(f).toMatch(/\.pdf$/);
      }

      // Back-page rotation assertion.
      // JPG path: each back page has EXIF Orientation=3.
      // PDF path: composed PDF has /Rotate 180 on each back page.
      if (format === "jpg" && expectedBackPages.length > 0) {
        // files is sorted; pages are 1-based. files[0] = page 1, files[1] = page 2, …
        for (const pageNum of expectedBackPages) {
          const bytes = readFileSync(path.join(outputDir, files[pageNum - 1]));
          // Back page: SOI immediately followed by APP1 segment inserted by setJpegOrientation.
          // Layout of the 36-byte APP1 block prepended at offset 2:
          //   [0-1]  ff e1          APP1 marker
          //   [2-3]  00 22          segment length = 34
          //   [4-9]  Exif\0\0       identifier
          //   [10-13] 4d 4d 00 2a   TIFF big-endian header + magic 42
          //   [14-17] 00 00 00 08   IFD0 offset (8 bytes from start of TIFF header)
          //   [18-19] 00 01         IFD entry count = 1
          //   [20-27] 01 12 00 03 00 00 00 01  tag=0x0112, type=SHORT, count=1
          //   [28-31] 00 [orientation] 00 00   value (big-endian SHORT in 4-byte field)
          //   [32-35] 00 00 00 00   next-IFD terminator
          // In the output buffer the APP1 block starts at byte 2 (after the SOI), so:
          //   orientation value byte = 2 + 29 = 31
          const ORIENTATION_VALUE_OFFSET = 31;
          expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe1]));
          expect(bytes[ORIENTATION_VALUE_OFFSET]).toBe(0x03);
        }
        // Front pages must NOT have an APP1 segment.
        for (let i = 0; i < files.length; i++) {
          const pageNum = i + 1;
          if (!expectedBackPages.includes(pageNum)) {
            const bytes = readFileSync(path.join(outputDir, files[i]));
            expect(Buffer.from([bytes[2], bytes[3]]).equals(Buffer.from([0xff, 0xe1]))).toBe(false);
          }
        }
      }

      if (format === "pdf" && expectedPdfPageCount !== undefined) {
        // pdf-lib uses object streams (compressed by default), so plain-text search is unreliable;
        // load the document and query the rotation programmatically.
        const pdfBytes = readFileSync(path.join(outputDir, files[0]));
        const doc = await PDFDocument.load(pdfBytes);
        expect(doc.getPageCount()).toBe(expectedPdfPageCount);
        for (let i = 0; i < expectedPdfPageCount; i++) {
          const pageNum = i + 1;
          if (expectedBackPages.includes(pageNum)) {
            expect(doc.getPage(i).getRotation().angle).toBe(180);
          } else {
            expect(doc.getPage(i).getRotation().angle).toBe(0);
          }
        }
      }
    },
    240_000,
  );

  // -------------------------------------------------------------------------
  // Small targeted test: 0x0c 0x00 page-eject byte search
  // -------------------------------------------------------------------------

  it("adf-single-page-jpeg: emits the 0x0c 0x00 page-eject after the image stream", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "wf-3620/adf-single-page-jpeg.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = runEsciScan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        entry: WF3620_ENTRY,
        duplex: false,
        forcedSource: "adf-simplex",
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

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
});

// ---------------------------------------------------------------------------
// appendImageChunk unit tests
// ---------------------------------------------------------------------------

describe("appendImageChunk", () => {
  it("strips the leading status byte and copies the pixel tail", () => {
    const dest = Buffer.alloc(8, 0x00);
    const offset = appendImageChunk(Buffer.from([0x01, 0xaa, 0xbb, 0xcc]), dest, 2);
    expect(offset).toBe(5);
    expect(Array.from(dest)).toEqual([0x00, 0x00, 0xaa, 0xbb, 0xcc, 0x00, 0x00, 0x00]);
  });

  it("concatenates pixel tails from multiple chunks contiguously", () => {
    const dest = Buffer.alloc(6, 0x00);
    let offset = 0;
    offset = appendImageChunk(Buffer.from([0x01, 0x11, 0x22]), dest, offset);
    offset = appendImageChunk(Buffer.from([0x01, 0x33, 0x44, 0x55, 0x66]), dest, offset);
    expect(offset).toBe(6);
    expect(Array.from(dest)).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
  });

  it("treats a 1-byte status-only chunk as zero pixels", () => {
    const dest = Buffer.alloc(4, 0xee);
    const offset = appendImageChunk(Buffer.from([0x01]), dest, 1);
    expect(offset).toBe(1);
    expect(Array.from(dest)).toEqual([0xee, 0xee, 0xee, 0xee]);
  });
});

// ---------------------------------------------------------------------------
// Failure-mode matrix (from D.4)
// ---------------------------------------------------------------------------

describe("runEsciScan failure-mode matrix", () => {
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

  it("rejects on socket error mid-session", async () => {
    const fake = new FakeTcpSocket();
    const scanPromise = runEsciScan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        entry: WF3620_ENTRY,
        duplex: false,
        forcedSource: "adf-simplex",
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();
    fake.emit("error", new Error("ECONNREFUSED"));
    await expect(scanPromise).rejects.toThrow(/socket error|ECONNREFUSED/i);
  });

  it("rejects on protocol violation (welcome with wrong packet type)", async () => {
    const fake = new FakeTcpSocket();
    const scanPromise = runEsciScan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        entry: WF3620_ENTRY,
        duplex: false,
        forcedSource: "adf-simplex",
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();
    // WELCOME state expects IS type 0x8000. Feed type 0xa000 — engine routes
    // through its "Unexpected packet type ... in state WELCOME" failure path.
    // (Raw garbage that doesn't form a valid IS header would just buffer until timeout.)
    fake.feed(buildIsPacket(0xa000, Buffer.alloc(0)));
    await expect(scanPromise).rejects.toThrow(/Unexpected packet type 0xa000 in state WELCOME/);
  });

  it("rejects a non-flatbed ESCI_FORCE_SOURCE against a fixed-flatbed entry", async () => {
    await expect(
      runEsciScan(
        {
          printerIp: "1.2.3.4",
          port: 1865,
          outputDir,
          tempDir,
          duplex: false,
          forcedSource: "adf-simplex",
          format: "jpg",
          jpegQuality: 90,
          entry: XP620_ENTRY,
        },
        new FakeTcpSocket().asFactory(),
      ),
    ).rejects.toThrow(/ESCI_FORCE_SOURCE.*flatbed|does not support/i);
  });
});

// ---------------------------------------------------------------------------
// FS F unknown-byte handling (E.5)
// ---------------------------------------------------------------------------

describe("FS F unknown-byte handling", () => {
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

  it("rejects when the STATUS_2 FS F byte is not 0x01 or 0x81", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "wf-3620/adf-single-page-jpeg.jsonl"));
    // Each p>h IS frame is a single complete event (12-byte header + payload).
    // STATUS_n replies are IS-0xa000 with a 16-byte payload. The sequence is:
    // STATUS_1A (1st a000/16 frame), STATUS_1B (2nd a000/16 frame), then
    // STATUS_2 (3rd a000/16 frame). We mutate the payload's first byte (at
    // offset IS_HEADER_SIZE within the combined frame) of the 3rd.
    let fsFHeaderCount = 0;
    const mutated = fixture.map((event) => {
      if (event.dir !== "p>h" || !("hex" in event)) return event;
      const buf = Buffer.from(event.hex, "hex");
      if (buf.length !== IS_HEADER_SIZE + 16) return event;
      const type = buf.readUInt16BE(2);
      const length = buf.readUInt32BE(6);
      if (type !== 0xa000 || length !== 16) return event;
      fsFHeaderCount++;
      if (fsFHeaderCount !== 3) return event;
      // The 3rd a000/16 frame is STATUS_2; mutate its payload byte 0 to 0x00.
      buf[IS_HEADER_SIZE] = 0x00;
      return { ...event, hex: buf.toString("hex") };
    });

    const fake = new FakeTcpSocket();
    const sessionPromise = runEsciScan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        entry: WF3620_ENTRY,
        duplex: false,
        forcedSource: null,
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    // Attach a no-op catch to prevent Node from flagging sessionPromise as
    // unhandled before driveFixture awaits it internally.
    sessionPromise.catch(() => {});
    await expect(driveFixture(mutated, fake, sessionPromise)).rejects.toThrow(
      /Unrecognised FS F status 0x00/,
    );
  });
});
