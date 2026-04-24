import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PDFDocument } from "pdf-lib";
import { startScanSession } from "./scanner.js";
import { buildIsPacket } from "./protocol.js";
import { parseEsci2ReplyHeader } from "./esci.js";
import { FakeTlsSocket } from "./test-support/fake-tls-socket.js";

// Fixed capability-body packets used by driveScannerToPara for both init cycles.
// Scanner discards the body content (it just needs N bytes matching the declared
// length); filler = 0x2d ('-'). Hoisted so each test run shares one allocation.
const INFO_BODY_PACKET = buildIsPacket(0xa000, Buffer.alloc(244, 0x2d));
const CAPA_BODY_PACKET = buildIsPacket(0xa000, Buffer.alloc(336, 0x2d));
const RESA_BODY_PACKET = buildIsPacket(0xa000, Buffer.alloc(164, 0x2d));

/**
 * Drive a fresh scanner session from CONNECTING through to just after
 * POST_MODE_STAT is acked — the scanner has sent PARA header + body and
 * is waiting for the PARA reply. Callers continue by either capturing the
 * PARA body write (source detection tests) or feeding PARA / TRDT / IMG
 * replies to exercise later states (IMG-loop, post-scan tests).
 *
 * If `firstStatReplyHex` declares a non-zero length (flatbed path), the
 * helper automatically feeds the matching pure-read-drain response.
 *
 * Caller owns teardown — either feed a 0x9000 fatal async and await
 * `sessionPromise`, or drive through to a natural UNLOCK.
 */
async function driveScannerToPara(args: {
  outputDir: string;
  firstStatReplyHex: string;
  duplex?: boolean;
  action?: "jpg" | "pdf";
}): Promise<{
  fake: FakeTlsSocket;
  sessionPromise: Promise<void>;
  feedEsci2Reply: (bodyHex: string) => Promise<void>;
  feedLegacyAck: () => Promise<void>;
}> {
  const { outputDir, firstStatReplyHex, duplex = false, action = "jpg" } = args;
  const fake = new FakeTlsSocket();
  const sessionPromise = startScanSession(
    { printerIp: "1.2.3.4", port: 1865, destId: 0x02, outputDir, tempDir: "", duplex, action },
    fake.asFactory(),
  );
  fake.simulateConnect();

  const feedEsci2Reply = async (bodyHex: string) => {
    fake.feed(buildIsPacket(0xa000, Buffer.alloc(0)));
    await new Promise((r) => setImmediate(r));
    fake.feed(buildIsPacket(0xa000, Buffer.from(bodyHex, "ascii")));
    await new Promise((r) => setImmediate(r));
  };
  const feedLegacyAck = async () => {
    fake.feed(buildIsPacket(0xa000, Buffer.from([0x06])));
    await new Promise((r) => setImmediate(r));
  };

  // Welcome + LOCK
  fake.feed(buildIsPacket(0x8000));
  await new Promise((r) => setImmediate(r));
  fake.feed(buildIsPacket(0xa100, Buffer.from([0x06])));
  await new Promise((r) => setImmediate(r));

  // Cycle 1: FS Y ACK, @INFO hdr+body, @CAPA hdr+body, FIN
  await feedLegacyAck();
  await feedEsci2Reply("INFOx00000F4");
  fake.feed(INFO_BODY_PACKET);
  await new Promise((r) => setImmediate(r));
  await feedEsci2Reply("CAPAx0000150");
  fake.feed(CAPA_BODY_PACKET);
  await new Promise((r) => setImmediate(r));
  await feedEsci2Reply("FIN x0000000");

  // Cycle 2: FS Z ACK, @INFO, @CAPA, @RESA, FIN
  await feedLegacyAck();
  await feedEsci2Reply("INFOx00000F4");
  fake.feed(INFO_BODY_PACKET);
  await new Promise((r) => setImmediate(r));
  await feedEsci2Reply("CAPAx0000150");
  fake.feed(CAPA_BODY_PACKET);
  await new Promise((r) => setImmediate(r));
  await feedEsci2Reply("RESAx00000A4");
  fake.feed(RESA_BODY_PACKET);
  await new Promise((r) => setImmediate(r));
  await feedEsci2Reply("FIN x0000000");

  // INIT_POLL cycle 1 with the test-provided STAT reply; drain if length > 0
  await feedLegacyAck();
  await feedEsci2Reply(firstStatReplyHex);
  const firstStatLength =
    parseEsci2ReplyHeader(Buffer.from(firstStatReplyHex, "ascii"))?.length ?? 0;
  if (firstStatLength > 0) {
    fake.feed(buildIsPacket(0xa000, Buffer.alloc(0)));
    await new Promise((r) => setImmediate(r));
    fake.feed(buildIsPacket(0xa000, Buffer.alloc(firstStatLength, 0x2d)));
    await new Promise((r) => setImmediate(r));
  }
  await feedEsci2Reply("FIN x0000000");

  // INIT_POLL cycles 2 + 3 (length-0 STATs, no drain)
  for (let i = 0; i < 2; i++) {
    await feedLegacyAck();
    await feedEsci2Reply("STATx0000000");
    await feedEsci2Reply("FIN x0000000");
  }

  // MODE_SWITCH + POST_MODE_STAT (length-0, no drain)
  await feedLegacyAck();
  await feedEsci2Reply("STATx0000000");

  return { fake, sessionPromise, feedEsci2Reply, feedLegacyAck };
}

/**
 * Drive further past PARA through a minimal 1-page IMG loop ending in a
 * terminal #pen without #lft — the ADF-vs-flatbed distinction under test.
 * Returned `sessionPromise` is still live; caller owns teardown.
 */
async function drivePastImgTerminator(
  outputDir: string,
  firstStatReplyHex: string,
): Promise<{
  fake: FakeTlsSocket;
  sessionPromise: Promise<void>;
  feedEsci2Reply: (bodyHex: string) => Promise<void>;
}> {
  const { fake, sessionPromise, feedEsci2Reply } = await driveScannerToPara({
    outputDir,
    firstStatReplyHex,
  });
  // PARA reply
  fake.feed(buildIsPacket(0xa000, Buffer.alloc(0)));
  await new Promise((r) => setImmediate(r));
  fake.feed(buildIsPacket(0xa000, Buffer.from("PARAx0000000#parOK", "ascii")));
  await new Promise((r) => setImmediate(r));
  await feedEsci2Reply("TRDTx0000000");
  // One IMG packet with a 4-byte JPEG body, then a terminal #pen-without-#lft
  await feedEsci2Reply("IMG x0000004#pst");
  fake.feed(buildIsPacket(0xa000, Buffer.from("ffd8ffd9", "hex")));
  await new Promise((r) => setImmediate(r));
  await feedEsci2Reply("IMG x0000000#peni0002481i0003506#typIMGA#---#---#---#---#---");
  return { fake, sessionPromise, feedEsci2Reply };
}

export interface CaptureRecord {
  hook: "startup" | "waiting" | "send" | "recv" | "error" | "async_event";
  type_hex?: string;
  payload_hex?: string;
  payload_size?: number;
}

/**
 * Trim the driver's variable STAT-cycle count to a fixed `keep`, matching the
 * scanner. The driver runs ~12 STAT heartbeat cycles after two capability-
 * discovery cycles; our scanner runs 3. Each STAT cycle is exactly 9 capture
 * records (3 sends + 6 recvs: envelope header + body per send). We keep the
 * first `keep` driver STAT cycles, drop the rest, and resume at FS X.
 *
 * Pre-STAT sends: LOCK (1) + cycle 1 (6) + cycle 2 (8) = 15 sends. The STAT
 * loop begins at the 16th send → sendIndices[15].
 */
export function trimStatCycles(records: CaptureRecord[], keep: number): CaptureRecord[] {
  const sendIndices = records.map((r, i) => (r.hook === "send" ? i : -1)).filter((i) => i !== -1);
  if (sendIndices.length < 16) {
    throw new Error(`trimStatCycles: capture has only ${sendIndices.length} sends, expected ≥ 16`);
  }
  const statLoopStart = sendIndices[15];
  const fsXRecord = records.findIndex((r) => r.hook === "send" && r.payload_hex?.endsWith("1c58"));
  if (fsXRecord === -1) {
    throw new Error("trimStatCycles: no FS X send found (payload ending 1c58)");
  }
  // Detect cycle size by measuring from the first STAT-cycle send (sendIndices[15])
  // to the second STAT-cycle send (sendIndices[16 + sendsPerCycle - 1]).
  // Each cycle starts with a FS Y send; count total records until the next FS Y
  // send to determine recordsPerStatCycle. FS Y payload ends in "1c59".
  const fsYPayload = records[statLoopStart].payload_hex ?? "";
  const nextCycleStart = records.findIndex(
    (r, i) => i > statLoopStart && r.hook === "send" && (r.payload_hex ?? "") === fsYPayload,
  );
  if (nextCycleStart === -1) {
    throw new Error(
      "trimStatCycles: could not detect STAT cycle boundary (no second FS Y matching first)",
    );
  }
  const recordsPerStatCycle = nextCycleStart - statLoopStart;
  const trimmedStatEnd = statLoopStart + keep * recordsPerStatCycle;
  return [...records.slice(0, trimmedStatEnd), ...records.slice(fsXRecord)];
}

describe("trimStatCycles", () => {
  it("keeps LOCK + cycles 1+2, trims the STAT loop, and resumes at FS X", () => {
    // Build a minimal capture: 15 pre-STAT sends (LOCK + 6 cycle-1 + 8 cycle-2),
    // 5 STAT cycles (45 records), then an FS X send, then a post-FS-X send.
    const pre = Array.from({ length: 15 }, (_, i) => ({
      hook: "send" as const,
      payload_hex: `aa${i.toString(16).padStart(2, "0")}`,
    }));
    const oneStatCycle: CaptureRecord[] = [
      { hook: "send", payload_hex: "bb01" },
      { hook: "recv" },
      { hook: "recv" },
      { hook: "send", payload_hex: "bb02" },
      { hook: "recv" },
      { hook: "recv" },
      { hook: "send", payload_hex: "bb03" },
      { hook: "recv" },
      { hook: "recv" },
    ];
    const statLoop = Array.from({ length: 5 }, () => oneStatCycle).flat();
    const fsX: CaptureRecord = {
      hook: "send",
      payload_hex: "49532000000c0000000a000000000002000000011c58",
    };
    const post: CaptureRecord = { hook: "send", payload_hex: "ffff" };
    const all: CaptureRecord[] = [...pre, ...statLoop, fsX, post];

    const trimmed = trimStatCycles(all, 3);

    // 15 pre + (3 × 9) STAT + 2 post (FS X + post) = 44 records
    expect(trimmed.length).toBe(15 + 27 + 2);
    expect(trimmed[15 + 27].payload_hex).toBe(fsX.payload_hex);
    expect(trimmed[15 + 27 + 1].payload_hex).toBe("ffff");
  });

  it("throws if capture has fewer than 16 sends", () => {
    const tooShort: CaptureRecord[] = Array.from({ length: 10 }, () => ({
      hook: "send",
      payload_hex: "aa",
    }));
    expect(() => trimStatCycles(tooShort, 3)).toThrow(/expected ≥ 16/);
  });

  it("throws if no FS X send is present", () => {
    const noFsX: CaptureRecord[] = Array.from({ length: 20 }, () => ({
      hook: "send",
      payload_hex: "aa",
    }));
    expect(() => trimStatCycles(noFsX, 3)).toThrow(/no FS X send/);
  });
});

function readJsonl(filePath: string): CaptureRecord[] {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CaptureRecord);
}

/**
 * Drive the scanner through a (pre-trimmed) captured session.
 * Feeds every `recv` record as bytes, asserts every `send` record matches
 * the scanner's nth write. Returns after the records are exhausted.
 */
async function replayCapture(
  records: CaptureRecord[],
  outputDir: string,
  duplex: boolean,
  action: "jpg" | "pdf",
): Promise<{
  totalDriverSends: number;
  scannerWrites: Buffer[];
  sessionPromise: Promise<void>;
}> {
  const filtered = records.filter((r) => r.hook === "send" || r.hook === "recv");
  const fake = new FakeTlsSocket();

  const sessionPromise = startScanSession(
    { printerIp: "192.0.2.58", port: 1865, destId: 0x02, outputDir, tempDir: "", duplex, action },
    fake.asFactory(),
  );
  fake.simulateConnect();

  let expectedSendIdx = 0;
  for (const rec of filtered) {
    if (rec.hook === "recv") {
      fake.feed(Buffer.from(rec.payload_hex ?? "", "hex"));
      await new Promise((r) => setImmediate(r));
    } else {
      if (expectedSendIdx >= fake.writes.length) {
        throw new Error(
          `At driver-send #${expectedSendIdx}: scanner hasn't written anything yet. ` +
            `Last driver send type=${rec.type_hex} payload=${rec.payload_hex?.slice(0, 40)}…`,
        );
      }
      const actual = fake.writes[expectedSendIdx].toString("hex");
      const expected = rec.payload_hex ?? "";
      expect(actual, `send #${expectedSendIdx} (driver type=${rec.type_hex})`).toBe(expected);
      expectedSendIdx++;
    }
  }

  // Let finalizeScan's deferred writeFileSync run to completion.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const totalDriverSends = filtered.filter((r) => r.hook === "send").length;
  return { totalDriverSends, scannerWrites: fake.writes, sessionPromise };
}

describe("scanner replay — full Windows-driver session", () => {
  // True if a JPEG buffer contains an EXIF APP1 (FF E1) marker within the
  // first ~1 KB. Good enough for these assertions — if we're injecting
  // EXIF, it lives immediately after the SOI.
  function hasExifApp1(buf: Buffer): boolean {
    for (let i = 0; i < Math.min(1024, buf.length - 1); i++) {
      if (buf[i] === 0xff && buf[i + 1] === 0xe1) return true;
    }
    return false;
  }

  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "scanner-test-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  const fixtures = [
    {
      label: "1p simplex",
      path: "tools/frida-capture/captures/2026-04-24T08-56-07-adf-1p-simplex.jsonl",
      expectedFilenamePattern: /^scan_\d{4}-\d{2}-\d{2}_\d{6}\.jpg$/,
      expectedFileCount: 1,
      duplex: false,
      action: "jpg" as const,
    },
    {
      label: "3p simplex",
      path: "tools/frida-capture/captures/2026-04-24T08-59-52-adf-3p-simplex.jsonl",
      expectedFilenamePattern: /^scan_\d{4}-\d{2}-\d{2}_\d{6}_0[123]\.jpg$/,
      expectedFileCount: 3,
      duplex: false,
      action: "jpg" as const,
    },
    {
      label: "1p duplex",
      path: "tools/frida-capture/captures/2026-04-24T08-58-29-adf-1p-duplex.jsonl",
      expectedFilenamePattern: /^scan_\d{4}-\d{2}-\d{2}_\d{6}_0[12]\.jpg$/,
      expectedFileCount: 2,
      duplex: true,
      action: "jpg" as const,
    },
    {
      label: "1p flatbed",
      path: "tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl",
      expectedFilenamePattern: /^scan_\d{4}-\d{2}-\d{2}_\d{6}\.jpg$/,
      expectedFileCount: 1,
      duplex: false,
      action: "jpg" as const,
    },
  ];

  it.each(fixtures)(
    "replays $label byte-for-byte and writes the expected JPG files",
    async ({ path: fixturePath, expectedFilenamePattern, expectedFileCount, duplex, action }) => {
      const raw = readJsonl(fixturePath);
      const trimmed = trimStatCycles(raw, 3);
      const result = await replayCapture(trimmed, outputDir, duplex, action);
      expect(result.scannerWrites.length).toBe(result.totalDriverSends);
      await expect(result.sessionPromise).resolves.toBeUndefined();

      const files = readdirSync(outputDir).sort();
      expect(files.length).toBe(expectedFileCount);
      for (const name of files) {
        expect(name).toMatch(expectedFilenamePattern);
        const contents = readFileSync(path.join(outputDir, name));
        // JPEG SOI marker
        expect(contents.subarray(0, 3).toString("hex")).toBe("ffd8ff");

        // EXIF-presence expectation per fixture:
        //   Simplex fixtures → no EXIF on any file.
        //   Duplex fixtures  → front pages (_01, _03, …) have no EXIF;
        //                      back pages  (_02, _04, …) have EXIF.
        const pageSuffixMatch = /_(\d{2})\.jpg$/.exec(name);
        const pageNum = pageSuffixMatch ? parseInt(pageSuffixMatch[1], 10) : 0;
        const isBackPage = duplex && pageNum > 0 && pageNum % 2 === 0;
        expect(hasExifApp1(contents)).toBe(isBackPage);
      }

      // Multi-page files must share the same timestamp prefix.
      if (expectedFileCount > 1) {
        const prefixes = new Set(files.map((n) => n.slice(0, "scan_YYYY-MM-DD_HHMMSS".length)));
        expect(prefixes.size).toBe(1);
      }
    },
  );

  // PDF replays — reuse the JPG fixtures (wire protocol is byte-identical
  // for PDF mode). We drive the scanner with action="pdf" and assert the
  // composed output structure rather than per-page JPG files.
  const pdfFixtures = [
    {
      label: "1p simplex PDF",
      path: "tools/frida-capture/captures/2026-04-24T08-56-07-adf-1p-simplex.jsonl",
      expectedPageCount: 1,
      duplex: false,
      expectedBackPages: [] as number[],
    },
    {
      label: "3p simplex PDF",
      path: "tools/frida-capture/captures/2026-04-24T08-59-52-adf-3p-simplex.jsonl",
      expectedPageCount: 3,
      duplex: false,
      expectedBackPages: [] as number[],
    },
    {
      label: "1p duplex PDF",
      path: "tools/frida-capture/captures/2026-04-24T08-58-29-adf-1p-duplex.jsonl",
      expectedPageCount: 2,
      duplex: true,
      expectedBackPages: [2],
    },
    {
      label: "1p flatbed PDF",
      path: "tools/frida-capture/captures/2026-04-24T09-06-37-flatbed-1p-pdf.jsonl",
      expectedPageCount: 1,
      duplex: false,
      expectedBackPages: [] as number[],
    },
  ];

  it.each(pdfFixtures)(
    "replays $label and writes a single composed PDF",
    async ({ path: fixturePath, expectedPageCount, duplex, expectedBackPages }) => {
      const raw = readJsonl(fixturePath);
      const trimmed = trimStatCycles(raw, 3);
      const result = await replayCapture(trimmed, outputDir, duplex, "pdf");
      expect(result.scannerWrites.length).toBe(result.totalDriverSends);
      await expect(result.sessionPromise).resolves.toBeUndefined();

      // Poll for PDF file to appear — composePdfFromJpegs is async inside
      // a setImmediate callback, so we need to yield to the event loop and
      // allow Promise microtasks to settle. Use short setTimeout ticks so
      // the async composition chain can complete.
      for (
        let i = 0;
        i < 50 && readdirSync(outputDir).filter((f) => f.endsWith(".pdf")).length === 0;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const files = readdirSync(outputDir);
      const pdfs = files.filter((f) => f.endsWith(".pdf"));
      const jpgs = files.filter((f) => f.endsWith(".jpg"));

      expect(jpgs).toEqual([]); // temp dir got cleaned; no stragglers
      expect(pdfs.length).toBe(1);
      expect(pdfs[0]).toMatch(/^scan_\d{4}-\d{2}-\d{2}_\d{6}\.pdf$/);

      const pdfPath = path.join(outputDir, pdfs[0]);
      const pdfBuf = readFileSync(pdfPath);
      expect(pdfBuf.subarray(0, 5).toString()).toBe("%PDF-");

      const doc = await PDFDocument.load(pdfBuf);
      expect(doc.getPageCount()).toBe(expectedPageCount);

      // Assert /Rotate on back pages and its absence on front pages.
      for (let i = 0; i < doc.getPageCount(); i++) {
        const pageIndex1Based = i + 1;
        const expected = expectedBackPages.includes(pageIndex1Based) ? 180 : 0;
        expect(doc.getPage(i).getRotation().angle, `page ${pageIndex1Based}`).toBe(expected);
      }
    },
  );
});

describe("scanner targeted tests — error paths", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "scanner-test-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("aborts and attempts unlock when a 0x9000 ServerError arrives", async () => {
    const fake = new FakeTlsSocket();
    const sessionPromise = startScanSession(
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
    fake.feed(buildIsPacket(0x8000));
    await new Promise((r) => setImmediate(r));
    fake.feed(buildIsPacket(0x9000, Buffer.from([0xa0])));
    await new Promise((r) => setImmediate(r));

    const lastWrite = fake.writes[fake.writes.length - 1];
    expect(lastWrite.readUInt16BE(2)).toBe(0x2101); // UNLOCK packet type

    fake.emit("close");
    await expect(sessionPromise).resolves.toBeUndefined();
  });

  it("aborts on unexpected IS type received mid-session", async () => {
    const fake = new FakeTlsSocket();
    const sessionPromise = startScanSession(
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
    fake.feed(buildIsPacket(0x8000));
    await new Promise((r) => setImmediate(r));
    const lockWriteIdx = fake.writes.length;
    fake.feed(buildIsPacket(0xffff));
    await new Promise((r) => setImmediate(r));

    const postErrorWrites = fake.writes.slice(lockWriteIdx);
    const sawUnlock = postErrorWrites.some((w) => w.length >= 4 && w.readUInt16BE(2) === 0x2101);
    expect(sawUnlock).toBe(true);

    fake.emit("close");
    await expect(sessionPromise).resolves.toBeUndefined();
  });

  it("socket 'error' event triggers transitionToError and resolves the promise", async () => {
    const fake = new FakeTlsSocket();
    const sessionPromise = startScanSession(
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
    fake.feed(buildIsPacket(0x8000));
    await new Promise((r) => setImmediate(r));
    // Simulate a mid-scan socket error (e.g., printer reboots).
    fake.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    await new Promise((r) => setImmediate(r));
    // Simulate the socket's subsequent close event.
    fake.emit("close");
    // The promise should resolve (not reject) after close.
    await expect(sessionPromise).resolves.toBeUndefined();
    // Last write should be the UNLOCK packet, proving transitionToError ran.
    const lastWrite = fake.writes[fake.writes.length - 1];
    expect(lastWrite.readUInt16BE(2)).toBe(0x2101);
  });
});

describe("scanner source detection from first @STAT reply", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "scanner-src-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  async function drivePastParaWith(firstStatReplyHex: string): Promise<Buffer> {
    const { fake, sessionPromise } = await driveScannerToPara({
      outputDir,
      firstStatReplyHex,
    });
    // PARA body is the only send > 500 bytes so far (PARA header is ~32B;
    // everything before it is shorter). Capture it before teardown.
    const paraBodyWrite = [...fake.writes].reverse().find((w) => w.length > 500);
    if (!paraBodyWrite) {
      throw new Error("scanner hasn't written a PARA body yet");
    }
    fake.feed(buildIsPacket(0x9000, Buffer.from([0xa0])));
    await sessionPromise;
    return paraBodyWrite;
  }

  it("detects source='adf' when first STAT returns length 0", async () => {
    const paraBody = await drivePastParaWith("STATx0000000");
    // ADF simplex PARA body: IS-framing 12B + inner 8B + 936-byte data body = 956 total bytes.
    expect(paraBody.length).toBe(12 + 8 + 936);
    // Confirm the source token is #ADF (byte offset 20 after the IS framing + inner header).
    expect(paraBody.subarray(20, 24).toString("ascii")).toBe("#ADF");
  });

  it("detects source='flatbed' when first STAT returns length 12", async () => {
    const paraBody = await drivePastParaWith("STATx000000C");
    // Flatbed PARA body: IS-framing 12B + inner 8B + 928-byte data body = 948 total.
    expect(paraBody.length).toBe(12 + 8 + 928);
    // Source token is #FB (trailing space).
    expect(paraBody.subarray(20, 24).toString("ascii")).toBe("#FB ");
  });

  it("defaults to ADF when first STAT has an unexpected length", async () => {
    const paraBody = await drivePastParaWith("STATx000002A"); // 42 — unexpected
    expect(paraBody.length).toBe(12 + 8 + 936);
    expect(paraBody.subarray(20, 24).toString("ascii")).toBe("#ADF");
  });
});

describe("scanner IMG-loop termination", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "scanner-img-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("treats any #pen as terminal when source=flatbed (no #lftd000 on that path)", async () => {
    const { fake, sessionPromise } = await drivePastImgTerminator(outputDir, "STATx000000C");
    // Outgoing packet structure: IS header (12B) + 8B inner header + ESC/I-2
    // name at bytes 20-23. @FIN = "FIN "; @IMG = "IMG ".
    const lastName = fake.writes[fake.writes.length - 1].subarray(20, 24).toString("ascii");
    expect(lastName).toBe("FIN ");
    fake.feed(buildIsPacket(0x9000, Buffer.from([0xa0])));
    await sessionPromise;
  });

  it("still treats #pen without #lft as a page boundary for ADF", async () => {
    // Regression: multi-page simplex ADF depends on #pen-without-#lft meaning
    // "page boundary, fetch next page". The flatbed branch must not leak.
    const { fake, sessionPromise } = await drivePastImgTerminator(outputDir, "STATx0000000");
    const lastName = fake.writes[fake.writes.length - 1].subarray(20, 24).toString("ascii");
    expect(lastName).toBe("IMG ");
    fake.feed(buildIsPacket(0x9000, Buffer.from([0xa0])));
    await sessionPromise;
  });
});

describe("scanner post-scan sequencing", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "scanner-post-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("sends UNLOCK directly after FIN_AFTER_IMG when source=flatbed (no POSTSCAN drain)", async () => {
    const { fake, sessionPromise, feedEsci2Reply } = await drivePastImgTerminator(
      outputDir,
      "STATx000000C",
    );
    await feedEsci2Reply("FIN x0000000"); // FIN_AFTER_IMG ack
    // Scanner's next write should be UNLOCK (IS type 0x2101), not an FS Y
    // leading into POSTSCAN #1 (which would be type 0x2000).
    const typeBytes = fake.writes[fake.writes.length - 1].subarray(2, 4).toString("hex");
    expect(typeBytes).toBe("2101");
    fake.feed(buildIsPacket(0xa101, Buffer.alloc(0)));
    await sessionPromise;
  });
});

describe("startScanSession — printer cert pinning", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "epson-pin-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("connects when fingerprint matches", () => {
    const fake = new FakeTlsSocket();
    const FP =
      "AB:CD:EF:01:23:45:67:89:0A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78";
    fake.setPeerCertificate(FP);

    void startScanSession(
      {
        printerIp: "192.0.2.58",
        port: 1865,
        destId: 0x02,
        outputDir: tempDir,
        tempDir: tempDir,
        duplex: false,
        action: "jpg",
        printerCertFingerprint: FP,
      },
      fake.asFactory(),
    );

    fake.simulateConnect();
    // Feed the Welcome packet so the scanner can send the first protocol record (LOCK).
    fake.feed(buildIsPacket(0x8000));
    // After secureConnect with matching fp, scanner sends the first protocol record.
    expect(fake.writes.length).toBeGreaterThan(0);
  });

  it("aborts before any send when fingerprint mismatches", async () => {
    const fake = new FakeTlsSocket();
    fake.setPeerCertificate(
      "11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11",
    );

    const done = startScanSession(
      {
        printerIp: "192.0.2.58",
        port: 1865,
        destId: 0x02,
        outputDir: tempDir,
        tempDir: tempDir,
        duplex: false,
        action: "jpg",
        printerCertFingerprint:
          "AB:CD:EF:01:23:45:67:89:0A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78",
      },
      fake.asFactory(),
    );

    fake.simulateConnect();
    await done;
    expect(fake.writes.length).toBe(0);
  });
});
