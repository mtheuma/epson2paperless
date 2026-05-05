import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { startScanSessionLegacy, appendImageChunk } from "./scanner-legacy.js";
import { parseIsPacket, buildIsPacket } from "./protocol.js";
import { FakeTcpSocket } from "./test-support/fake-tcp-socket.js";
import { loadFixture, driveFixture } from "./test-support/legacy-replay.js";

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
    await driveFixture(fixture, fake, sessionPromise);

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
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scan_.+\.jpg$/);
    const jpegBytes = readFileSync(path.join(outputDir, files[0]));
    // SOI marker
    expect(jpegBytes[0]).toBe(0xff);
    expect(jpegBytes[1]).toBe(0xd8);
  }, 60_000); // Sharp encodes ~104 MB raw RGB; allow up to 60 s on slow machines / CI

  it("flatbed-single-page-pdf: produces one PDF in the output dir", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "flatbed-single-page-pdf.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "flatbed",
        format: "pdf",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.pdf$/);
  }, 60_000);

  it("adf-single-page-pdf: produces one PDF in the output dir", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-single-page-pdf.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "adf-simplex",
        format: "pdf",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.pdf$/);
  }, 60_000);

  it("adf-2-page-jpeg (duplex): writes 2 JPGs with back-page Orientation=3", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-2-page-jpeg.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "adf-duplex",
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir).sort();
    expect(files).toHaveLength(2);
    expect(files.every((f) => /\.jpg$/.test(f))).toBe(true);

    const front = readFileSync(path.join(outputDir, files[0]));
    const back = readFileSync(path.join(outputDir, files[1]));

    // Front (page 1): valid JPEG SOI, NOT followed by APP1 (no EXIF inserted).
    expect(front[0]).toBe(0xff);
    expect(front[1]).toBe(0xd8);
    expect(Buffer.from([front[2], front[3]]).equals(Buffer.from([0xff, 0xe1]))).toBe(false);

    // Back (page 2): SOI immediately followed by APP1 segment inserted by setJpegOrientation.
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
    expect(back.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe1]));
    expect(back[ORIENTATION_VALUE_OFFSET]).toBe(0x03);
  }, 120_000); // 2 pages × ~8s sharp encode each = 16s + slack

  it("adf-3-page-simplex-jpeg: writes 3 JPGs, no rotation", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-3-page-simplex-jpeg.jsonl"));
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
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir).sort();
    expect(files).toHaveLength(3);
    expect(files.every((f) => /\.jpg$/.test(f))).toBe(true);
    // None of the JPGs should have an APP1 EXIF segment (no rotation in simplex)
    for (const f of files) {
      const bytes = readFileSync(path.join(outputDir, f));
      expect(Buffer.from([bytes[2], bytes[3]]).equals(Buffer.from([0xff, 0xe1]))).toBe(false);
    }
  }, 180_000);

  it("adf-3-page-simplex-pdf: writes one PDF with 3 pages, no rotation", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-3-page-simplex-pdf.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "adf-simplex",
        format: "pdf",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.pdf$/);
    const pdf = await PDFDocument.load(readFileSync(path.join(outputDir, files[0])));
    expect(pdf.getPageCount()).toBe(3);
    // Simplex: no page should have rotation
    for (let i = 0; i < pdf.getPageCount(); i++) {
      expect(pdf.getPage(i).getRotation().angle).toBe(0);
    }
  }, 180_000);

  it("adf-4-page-duplex-jpeg: writes 4 JPGs, even pages have Orientation=3", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-4-page-duplex-jpeg.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "adf-duplex",
        format: "jpg",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir).sort();
    expect(files).toHaveLength(4);
    // Front pages (1, 3): no APP1 segment.
    // Back pages (2, 4): APP1 with Orientation=3.
    for (let i = 0; i < 4; i++) {
      const bytes = readFileSync(path.join(outputDir, files[i]));
      const isBack = (i + 1) % 2 === 0;
      if (isBack) {
        expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe1]));
        // Orientation value at offset 31 (per the APP1 layout setJpegOrientation produces)
        expect(bytes[31]).toBe(0x03);
      } else {
        expect(Buffer.from([bytes[2], bytes[3]]).equals(Buffer.from([0xff, 0xe1]))).toBe(false);
      }
    }
  }, 240_000);

  it("adf-4-page-duplex-pdf: writes one PDF with 4 pages, even pages /Rotate 180", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-4-page-duplex-pdf.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "adf-duplex",
        format: "pdf",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    const pdf = await PDFDocument.load(readFileSync(path.join(outputDir, files[0])));
    expect(pdf.getPageCount()).toBe(4);
    // Front pages 1, 3 → 0; back pages 2, 4 → 180
    expect(pdf.getPage(0).getRotation().angle).toBe(0);
    expect(pdf.getPage(1).getRotation().angle).toBe(180);
    expect(pdf.getPage(2).getRotation().angle).toBe(0);
    expect(pdf.getPage(3).getRotation().angle).toBe(180);
  }, 240_000);

  it("adf-2-page-pdf (duplex): writes one PDF with back page rotated 180", async () => {
    const fixture = loadFixture(path.join(FIXTURES, "adf-2-page-pdf.jsonl"));
    const fake = new FakeTcpSocket();

    const sessionPromise = startScanSessionLegacy(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        outputDir,
        tempDir,
        source: "adf-duplex",
        format: "pdf",
        jpegQuality: 90,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.pdf$/);
    // Verify the PDF has 2 pages and the second (back) page has /Rotate 180.
    // pdf-lib uses object streams (compressed by default), so plain-text search is unreliable;
    // load the document and query the rotation programmatically.
    const pdfBytes = readFileSync(path.join(outputDir, files[0]));
    const doc = await PDFDocument.load(pdfBytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    expect(doc.getPage(1).getRotation().angle).toBe(180);
  }, 120_000);
});

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

describe("startScanSessionLegacy failure-mode matrix", () => {
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
    const scanPromise = startScanSessionLegacy(
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
    fake.emit("error", new Error("ECONNREFUSED"));
    await expect(scanPromise).rejects.toThrow(/socket error|ECONNREFUSED/i);
  });

  it("rejects on protocol violation (welcome with wrong packet type)", async () => {
    const fake = new FakeTcpSocket();
    const scanPromise = startScanSessionLegacy(
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
    // WELCOME state expects type 0x8000 (scanner-legacy.ts:247).
    // Feed type 0xa000 — fail() rejects with "expected welcome (0x8000), got 0xa000".
    // (Raw garbage that doesn't form a valid IS header would just buffer until timeout.)
    fake.feed(buildIsPacket(0xa000, Buffer.alloc(0)));
    await expect(scanPromise).rejects.toThrow(/expected welcome \(0x8000\)/);
  });
});
