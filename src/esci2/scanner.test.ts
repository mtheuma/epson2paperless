import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PDFDocument } from "pdf-lib";
import { runEsci2Scan, runEsci2ScanOverPlain } from "./scanner.js";
import { buildIsPacket } from "../protocol.js";
import { parseEsci2ReplyHeader } from "./commands.js";
import { FakeTlsSocket } from "./test-support/fake-tls-socket.js";
import { FakePlainSocket } from "./test-support/fake-plain-socket.js";
import { loadFixture, driveFixture } from "./test-support/replay.js";
import type { FixtureEvent } from "./test-support/replay.js";
import { readJsonl, trimStatCycles, replayCapture } from "./test-support/frida-replay.js";
import { REGISTRY } from "./dialects/registry.js";
import { makeParaSpec } from "./dialects/dispatch.js";
import { composePara, type ParaSpec } from "./para-composer.js";

const XP7100_FP = "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e";

function waitImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Recover the captured PARA body bytes from a fixture's host→printer events.
// The driver emits PARA as two consecutive h>p IS frames:
//   frame 1: 12-byte IS header + 8-byte preamble + 12-byte "PARAx0000NNN"
//   frame 2: 12-byte IS header + 8-byte preamble + <NNN bytes of PARA body>
function extractCapturedParaBody(fixture: FixtureEvent[]): Buffer {
  const PARA_HDR_HEX = Buffer.from("PARAx", "ascii").toString("hex");
  let hdrIdx = -1;
  for (let i = 0; i < fixture.length; i++) {
    const e = fixture[i];
    if (e.dir !== "h>p" || !("hex" in e)) continue;
    if (e.hex.includes(PARA_HDR_HEX)) {
      hdrIdx = i;
      break;
    }
  }
  if (hdrIdx < 0) throw new Error("extractCapturedParaBody: PARA header not found in fixture");
  const hdrHex = (fixture[hdrIdx] as { hex: string }).hex;
  const m = hdrHex.match(/5041524178([0-9a-fA-F]{14})/);
  if (!m) throw new Error("extractCapturedParaBody: PARA header malformed");
  const declared = parseInt(Buffer.from(m[1], "hex").toString("ascii"), 16);
  // Body wrapper is the very next h>p event. Skip its 12-byte IS header +
  // 8-byte cmd_size/reply_size preamble = 20 bytes (40 hex chars).
  let bodyHex = "";
  let isFirst = true;
  for (let j = hdrIdx + 1; j < fixture.length && bodyHex.length / 2 < declared; j++) {
    const e = fixture[j];
    if (e.dir !== "h>p" || !("hex" in e)) continue;
    bodyHex += isFirst ? e.hex.slice(40) : e.hex;
    isFirst = false;
  }
  return Buffer.from(bodyHex.slice(0, declared * 2), "hex");
}

// Recover the PARA body bytes the scanner emitted, by searching the fake
// socket's accumulated writes for the same "PARAx0000NNN" header and
// peeling off the body wrapper.
function extractScannerParaWrite(fake: FakePlainSocket): Buffer {
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

// Defensive poll for the composed .pdf. finalizeSession awaits the PDF compose
// + write before the session promise settles, so the file is normally already on
// disk once callers await that promise; this loop only guards against scheduler/
// filesystem lag. Bounded at 50×10ms; callers assert the .pdf count afterwards,
// so a miss fails loudly.
async function waitForPdf(outputDir: string): Promise<void> {
  for (
    let i = 0;
    i < 50 && readdirSync(outputDir).filter((f) => f.endsWith(".pdf")).length === 0;
    i++
  ) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Fixed capability-body packets used by driveScannerToPara for both init cycles.
// INFO_BODY_PACKET and RESA_BODY_PACKET stay synthetic — the scanner only
// checks the declared length. CAPA_BODY_PACKET must use the real ET-4950 body
// because INIT1_CAPA fingerprints it and resolves the matching dialect.
const INFO_BODY_PACKET = buildIsPacket(0xa000, Buffer.alloc(244, 0x2d));
const RESA_BODY_PACKET = buildIsPacket(0xa000, Buffer.alloc(164, 0x2d));

// Real ET-4950 CAPA#1 body, extracted from the committed Frida fixture.
// Synthetic filler (Buffer.alloc(336, 0x2d)) would fingerprint to a value not
// in DIALECTS and abort every helper-driven test at INIT1 CAPA. Loading the
// real body keeps these tests resolving to the ET-4950 family registry entry.
function loadEt4950CapaBody(): Buffer {
  const fixturePath = path.join(
    "tools",
    "frida-capture",
    "captures",
    "2026-04-24T09-05-08-flatbed-1p-jpg.jsonl",
  );
  const lines = readFileSync(fixturePath, "utf8").split("\n").filter(Boolean);
  const events = lines.map(
    (l) => JSON.parse(l) as { hook?: string; type_hex?: string; payload_hex?: string },
  );
  // CAPA preamble is a recv event whose payload starts with "CAPA" (ASCII 43 41 50 41).
  const idx = events.findIndex(
    (e) => e.hook === "recv" && !!e.payload_hex && e.payload_hex.startsWith("43415041"),
  );
  if (idx < 0) throw new Error("ET-4950 CAPA preamble not found in fixture");
  const lenStr = Buffer.from(events[idx].payload_hex!.slice(10, 24), "hex").toString("ascii");
  const declared = parseInt(lenStr, 16);

  // Body follows as recv events. Frida emits IS headers and IS payloads in
  // separate events: header events have `type_hex` set to the IS type
  // (`"0xa000"` for body wrappers), payload events have `type_hex: "0x0000"`.
  // We want only the payloads — header events would corrupt the body.
  let body = Buffer.alloc(0);
  for (let j = idx + 1; j < events.length && body.length < declared; j++) {
    const e = events[j];
    if (e.hook !== "recv" || !e.payload_hex) continue;
    if (e.type_hex !== "0x0000") continue;
    body = Buffer.concat([body, Buffer.from(e.payload_hex, "hex")]);
  }
  const out = body.subarray(0, declared);

  // Defensive sanity checks: the body should be exactly 336 bytes and start
  // with `#` (0x23). If either fails, the extractor walked the events wrong.
  if (out.length !== 336) {
    throw new Error(`loadEt4950CapaBody: expected 336 bytes, got ${out.length}`);
  }
  if (out[0] !== 0x23) {
    throw new Error(
      `loadEt4950CapaBody: body should start with '#' (0x23), got 0x${out[0].toString(16)} — extractor likely included an IS header`,
    );
  }
  return out;
}

const ET4950_CAPA_BODY = loadEt4950CapaBody();
const CAPA_BODY_PACKET = buildIsPacket(0xa000, ET4950_CAPA_BODY);

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
  const sessionPromise = runEsci2Scan(
    { printerIp: "1.2.3.4", port: 1865, destId: 0x02, outputDir, tempDir: "", duplex, action },
    fake.asFactory(),
  );
  fake.simulateConnect();

  const feedEsci2Reply = async (bodyHex: string) => {
    fake.feed(buildIsPacket(0xa000, Buffer.alloc(0)));
    await waitImmediate();
    fake.feed(buildIsPacket(0xa000, Buffer.from(bodyHex, "ascii")));
    await waitImmediate();
  };
  const feedLegacyAck = async () => {
    fake.feed(buildIsPacket(0xa000, Buffer.from([0x06])));
    await waitImmediate();
  };

  // Welcome + LOCK
  fake.feed(buildIsPacket(0x8000));
  await waitImmediate();
  fake.feed(buildIsPacket(0xa100, Buffer.from([0x06])));
  await waitImmediate();

  // Cycle 1: FS Y ACK, @INFO hdr+body, @CAPA hdr+body, FIN
  await feedLegacyAck();
  await feedEsci2Reply("INFOx00000F4");
  fake.feed(INFO_BODY_PACKET);
  await waitImmediate();
  await feedEsci2Reply("CAPAx0000150");
  fake.feed(CAPA_BODY_PACKET);
  await waitImmediate();
  await feedEsci2Reply("FIN x0000000");

  // Cycle 2: FS Z ACK, @INFO, @CAPA, @RESA, FIN
  await feedLegacyAck();
  await feedEsci2Reply("INFOx00000F4");
  fake.feed(INFO_BODY_PACKET);
  await waitImmediate();
  await feedEsci2Reply("CAPAx0000150");
  fake.feed(CAPA_BODY_PACKET);
  await waitImmediate();
  await feedEsci2Reply("RESAx00000A4");
  fake.feed(RESA_BODY_PACKET);
  await waitImmediate();
  await feedEsci2Reply("FIN x0000000");

  // INIT_POLL cycle 1 with the test-provided STAT reply; drain if length > 0
  await feedLegacyAck();
  await feedEsci2Reply(firstStatReplyHex);
  const firstStatLength =
    parseEsci2ReplyHeader(Buffer.from(firstStatReplyHex, "ascii"))?.length ?? 0;
  if (firstStatLength > 0) {
    fake.feed(buildIsPacket(0xa000, Buffer.alloc(0)));
    await waitImmediate();
    fake.feed(buildIsPacket(0xa000, Buffer.alloc(firstStatLength, 0x2d)));
    await waitImmediate();
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
  await waitImmediate();
  fake.feed(buildIsPacket(0xa000, Buffer.from("PARAx0000000#parOK", "ascii")));
  await waitImmediate();
  await feedEsci2Reply("TRDTx0000000");
  // One IMG packet with a 4-byte JPEG body, then a terminal #pen-without-#lft
  await feedEsci2Reply("IMG x0000004#pst");
  fake.feed(buildIsPacket(0xa000, Buffer.from("ffd8ffd9", "hex")));
  await waitImmediate();
  // Snapshot writes before the page-end feed; wait for the engine's response
  // (FIN for flatbed-terminal, IMG for ADF-more) before returning.
  const writesBeforePageEnd = fake.writes.length;
  await feedEsci2Reply("IMG x0000000#peni0002481i0003506#typIMGA#---#---#---#---#---");
  await fake.waitForWriteCount(writesBeforePageEnd + 1);
  return { fake, sessionPromise, feedEsci2Reply };
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
      // Byte-for-byte shield: every scanner write must equal the captured
      // driver `send` bytes, in order. Lifted out of replayCapture (which is
      // expect-free for reuse) and re-asserted here.
      const sends = trimmed.filter((r) => r.hook === "send");
      expect(result.scannerWrites.length).toBe(sends.length);
      for (let i = 0; i < sends.length; i++) {
        expect(
          result.scannerWrites[i].toString("hex"),
          `send #${i} (type=${sends[i].type_hex})`,
        ).toBe(sends[i].payload_hex ?? "");
      }
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
      // Byte-for-byte shield: every scanner write must equal the captured
      // driver `send` bytes, in order. Lifted out of replayCapture (which is
      // expect-free for reuse) and re-asserted here.
      const sends = trimmed.filter((r) => r.hook === "send");
      expect(result.scannerWrites.length).toBe(sends.length);
      for (let i = 0; i < sends.length; i++) {
        expect(
          result.scannerWrites[i].toString("hex"),
          `send #${i} (type=${sends[i].type_hex})`,
        ).toBe(sends[i].payload_hex ?? "");
      }
      await expect(result.sessionPromise).resolves.toBeUndefined();

      await waitForPdf(outputDir);

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
    const sessionPromise = runEsci2Scan(
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
    // Attach the rejection handler before feeding the fatal packet so the
    // rejection isn't momentarily unhandled (FakeTlsSocket.destroy() is sync).
    const rejectsAssertion = expect(sessionPromise).rejects.toThrow(/fatal/i);
    fake.simulateConnect();
    fake.feed(buildIsPacket(0x8000));
    await waitImmediate();
    fake.feed(buildIsPacket(0x9000, Buffer.from([0xa0])));
    await waitImmediate();

    const lastWrite = fake.writes[fake.writes.length - 1];
    expect(lastWrite.readUInt16BE(2)).toBe(0x2101); // UNLOCK packet type

    await rejectsAssertion;
  });

  it("aborts on unexpected IS type received mid-session", async () => {
    const fake = new FakeTlsSocket();
    const sessionPromise = runEsci2Scan(
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
    // Attach the rejection handler before feeding the error-causing packet.
    const rejectsAssertion = expect(sessionPromise).rejects.toThrow(
      /unexpected packet type|protocol error/i,
    );
    fake.simulateConnect();
    fake.feed(buildIsPacket(0x8000));
    await waitImmediate();
    const lockWriteIdx = fake.writes.length;
    fake.feed(buildIsPacket(0xffff));
    await waitImmediate();

    const postErrorWrites = fake.writes.slice(lockWriteIdx);
    const sawUnlock = postErrorWrites.some((w) => w.length >= 4 && w.readUInt16BE(2) === 0x2101);
    expect(sawUnlock).toBe(true);

    await rejectsAssertion;
  });

  it("socket 'error' event triggers transitionToError and rejects the promise", async () => {
    const fake = new FakeTlsSocket();
    const sessionPromise = runEsci2Scan(
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
    // Attach the rejection handler before emitting the error so the
    // rejection isn't momentarily unhandled (FakeTlsSocket.destroy() is sync).
    const rejectsAssertion = expect(sessionPromise).rejects.toThrow(/TLS connection error/i);
    fake.simulateConnect();
    fake.feed(buildIsPacket(0x8000));
    await waitImmediate();
    // Simulate a mid-scan socket error (e.g., printer reboots).
    fake.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    await waitImmediate();
    // The promise should reject with a classified error message.
    await rejectsAssertion;
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
    // Attach the rejection handler before feeding the fatal packet so the
    // rejection isn't momentarily unhandled (FakeTlsSocket.destroy() is sync).
    const settle = sessionPromise.catch(() => {
      /* expected: async fatal triggers rejection */
    });
    fake.feed(buildIsPacket(0x9000, Buffer.from([0xa0])));
    await settle;
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
    // Attach handler before feeding the fatal packet to avoid unhandled rejection.
    const settle = sessionPromise.catch(() => {
      /* expected: async fatal triggers rejection */
    });
    fake.feed(buildIsPacket(0x9000, Buffer.from([0xa0])));
    await settle;
  });

  it("still treats #pen without #lft as a page boundary for ADF", async () => {
    // Regression: multi-page simplex ADF depends on #pen-without-#lft meaning
    // "page boundary, fetch next page". The flatbed branch must not leak.
    const { fake, sessionPromise } = await drivePastImgTerminator(outputDir, "STATx0000000");
    const lastName = fake.writes[fake.writes.length - 1].subarray(20, 24).toString("ascii");
    expect(lastName).toBe("IMG ");
    // Attach handler before feeding the fatal packet to avoid unhandled rejection.
    const settle = sessionPromise.catch(() => {
      /* expected: async fatal triggers rejection */
    });
    fake.feed(buildIsPacket(0x9000, Buffer.from([0xa0])));
    await settle;
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

describe("runEsci2Scan — printer cert pinning", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "epson-pin-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("connects when fingerprint matches", async () => {
    const fake = new FakeTlsSocket();
    const FP =
      "AB:CD:EF:01:23:45:67:89:0A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78";
    fake.setPeerCertificate(FP);

    // Capture the promise so we can drive the session to a clean settle
    // before the test exits — otherwise the 30s scanner timeout stays
    // armed and may reject later as an unhandled rejection in an
    // unrelated test. Pre-attached catch swallows the expected
    // close-mid-session rejection.
    const scanPromise = runEsci2Scan(
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
    const settled = scanPromise.catch(() => {
      /* expected: we tear the session down once we've verified LOCK landed */
    });

    fake.simulateConnect();
    // Feed the Welcome packet so the scanner can send the first protocol record (LOCK).
    fake.feed(buildIsPacket(0x8000));
    await fake.waitForWriteCount(1);
    expect(fake.writes.length).toBeGreaterThan(0);

    fake.destroy(); // close socket → engine settles { ok: false }, caught above
    await settled;
  });

  it("aborts before any send when fingerprint mismatches", async () => {
    const fake = new FakeTlsSocket();
    fake.setPeerCertificate(
      "11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11",
    );

    const done = runEsci2Scan(
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
    await expect(done).rejects.toThrow(/fingerprint mismatch/i);
    expect(fake.writes.length).toBe(0);
  });
});

describe("runEsci2Scan failure-mode matrix", () => {
  it("rejects when the printer cert fingerprint does not match the pin", async () => {
    const fake = new FakeTlsSocket();
    fake.setPeerCertificate("AA:BB:CC"); // FakeTlsSocket.setPeerCertificate takes a string
    const scanPromise = runEsci2Scan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        destId: 0x02,
        outputDir: "/tmp/out-doesnotmatter",
        tempDir: "/tmp",
        duplex: false,
        action: "jpg",
        paperless: undefined,
        printerCertFingerprint: "DE:AD:BE:EF",
      },
      fake.asFactory(),
    );
    fake.simulateConnect();
    await expect(scanPromise).rejects.toThrow(/fingerprint mismatch/i);
  });

  it("rejects when the session temp dir cannot be created", async () => {
    const fake = new FakeTlsSocket();
    // tempDir points at a path that mkdtempSync cannot resolve.
    const scanPromise = runEsci2Scan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        destId: 0x02,
        outputDir: "/tmp/out-doesnotmatter",
        tempDir: "/this/path/definitely/does/not/exist",
        duplex: false,
        action: "jpg",
        paperless: undefined,
      },
      fake.asFactory(),
    );
    await expect(scanPromise).rejects.toThrow(/temp dir/i);
  });

  it("rejects on timeout (no response in TIMEOUT_MS)", async () => {
    // CRITICAL: install fake timers BEFORE runEsci2Scan runs. The scanner
    // schedules a setTimeout(TIMEOUT_MS) inside the connect callback fired by
    // simulateConnect(); if useFakeTimers is called after, the real timer is
    // already armed and advancing fake timers won't fire it.
    vi.useFakeTimers();
    try {
      const fake = new FakeTlsSocket();
      const scanPromise = runEsci2Scan(
        {
          printerIp: "1.2.3.4",
          port: 1865,
          destId: 0x02,
          outputDir: "/tmp",
          tempDir: "/tmp",
          duplex: false,
          action: "jpg",
          paperless: undefined,
        },
        fake.asFactory(),
      );
      fake.simulateConnect();
      // Attach the rejection handler before advancing fake timers so the
      // rejection isn't momentarily unhandled (FakeTlsSocket.destroy() is sync,
      // so the close event fires inside advanceTimersByTimeAsync).
      const rejectsAssertion = expect(scanPromise).rejects.toThrow(/timeout/i);
      // The graph timeout is 30_000 ms; 60_000 overshoots safely.
      await vi.advanceTimersByTimeAsync(60_000);
      await rejectsAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects on socket error mid-session", async () => {
    const fake = new FakeTlsSocket();
    const scanPromise = runEsci2Scan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        destId: 0x02,
        outputDir: "/tmp",
        tempDir: "/tmp",
        duplex: false,
        action: "jpg",
        paperless: undefined,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();
    // Attach handler before emitting the error — FakeTlsSocket.destroy() fires
    // "close" synchronously, which rejects the promise inside the emit call.
    const rejectsAssertion = expect(scanPromise).rejects.toThrow(/ECONNREFUSED/);
    fake.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    await rejectsAssertion;
  });

  it("rejects on async ScanCancel event mid-session", async () => {
    const fake = new FakeTlsSocket();
    const scanPromise = runEsci2Scan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        destId: 0x02,
        outputDir: "/tmp",
        tempDir: "/tmp",
        duplex: false,
        action: "jpg",
        paperless: undefined,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();
    // Attach handler before feeding — FakeTlsSocket.destroy() fires "close"
    // synchronously, rejecting the promise inside fake.feed().
    const cancelPacket = buildIsPacket(0x9000, Buffer.from([0x03]));
    const rejectsAssertion = expect(scanPromise).rejects.toThrow(/ScanCancel/);
    fake.feed(cancelPacket);
    await rejectsAssertion;
  });

  it("rejects on async fatal event mid-session", async () => {
    const fake = new FakeTlsSocket();
    const scanPromise = runEsci2Scan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        destId: 0x02,
        outputDir: "/tmp",
        tempDir: "/tmp",
        duplex: false,
        action: "jpg",
        paperless: undefined,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();
    // The ESC/I-2 graph treats 0x02 (Disconnect), 0x80 (Timeout), and
    // 0xa0 (ServerError) as fatal. Use 0x02. (0x05 is info-only and does not reject.)
    const fatalPacket = buildIsPacket(0x9000, Buffer.from([0x02]));
    // Attach handler before feeding — FakeTlsSocket.destroy() fires "close"
    // synchronously, rejecting the promise inside fake.feed().
    const rejectsAssertion = expect(scanPromise).rejects.toThrow(/fatal/i);
    fake.feed(fatalPacket);
    await rejectsAssertion;
  });

  it("rejects on per-state assertion failure (unexpected packet type)", async () => {
    const fake = new FakeTlsSocket();
    const scanPromise = runEsci2Scan(
      {
        printerIp: "1.2.3.4",
        port: 1865,
        destId: 0x02,
        outputDir: "/tmp",
        tempDir: "/tmp",
        duplex: false,
        action: "jpg",
        paperless: undefined,
      },
      fake.asFactory(),
    );
    fake.simulateConnect();
    // Feed a packet whose type doesn't match the WELCOME state's expectation.
    // WELCOME expects type 0x8000. Feed type 0xa999 to force ensure(...) to fail.
    const wrongTypePacket = buildIsPacket(0xa999, Buffer.alloc(0));
    // Attach handler before feeding — FakeTlsSocket.destroy() fires "close"
    // synchronously, rejecting the promise inside fake.feed().
    const rejectsAssertion = expect(scanPromise).rejects.toThrow(
      /unexpected packet type|protocol error/i,
    );
    fake.feed(wrongTypePacket);
    await rejectsAssertion;
  });
});

// ─── ET-2750 (esci2-plain) replay ────────────────────────────────────────

describe("runEsci2ScanOverPlain — ET-2750 fixture replay", () => {
  let outputDir: string;
  let tempDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "et2750-out-"));
    tempDir = mkdtempSync(path.join(os.tmpdir(), "et2750-tmp-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("flatbed-single-page-pdf: drives the captured wire and produces one PDF", async () => {
    // Source: tools/pcap-extract/captures/et-2750/flatbed-single-page-pdf.jsonl
    // Provenance documented in `.reference/wireshark-captures/et-2750/protocol-decode.md`.
    // ET-2750 is flatbed-only hardware; no ADF or duplex variants exist.
    // The fixture is large (~3.9 MB) because each ESC/I-2 IMG cycle wraps
    // pixel data in 0xa000 IS frames — there's no 0xa200 image-stream
    // summary path here. Replay is byte-exact regardless.
    const fixturePath = path.join(
      "tools",
      "pcap-extract",
      "captures",
      "et-2750",
      "flatbed-single-page-pdf.jsonl",
    );
    const fixture = loadFixture(fixturePath);
    const fake = new FakePlainSocket();

    const sessionPromise = runEsci2ScanOverPlain(
      {
        printerIp: "10.31.50.16",
        port: 1865,
        destId: 0x02,
        outputDir,
        tempDir,
        duplex: false,
        action: "pdf",
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    // Byte-equivalence shield: assert the scanner's PARA wire bytes match
    // what the captured Wireshark session sent. Without this, driveFixture
    // replays the printer's responses regardless of what PARA the scanner
    // emitted, so a composer regression on ET-2750 would not fail this test.
    // Mirrors the XP-7100 replay pattern at line ~1173 of this file.
    const capturedPara = extractCapturedParaBody(fixture);
    const scannerPara = extractScannerParaWrite(fake);
    expect(scannerPara.equals(capturedPara)).toBe(true);

    await waitForPdf(outputDir);

    const files = readdirSync(outputDir);
    const pdfs = files.filter((f) => f.endsWith(".pdf"));
    const jpgs = files.filter((f) => f.endsWith(".jpg"));
    expect(jpgs).toEqual([]); // session temp dir is cleaned by finalizeSession
    expect(pdfs.length).toBe(1);
    expect(pdfs[0]).toMatch(/^scan_\d{4}-\d{2}-\d{2}_\d{6}\.pdf$/);

    const pdfBytes = readFileSync(path.join(outputDir, pdfs[0]));
    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const doc = await PDFDocument.load(pdfBytes);
    expect(doc.getPageCount()).toBe(1);
    // Flatbed front side — no 180° rotation.
    expect(doc.getPage(0).getRotation().angle).toBe(0);
  }, 60_000);
});

describe("runEsci2ScanOverPlain — XP-7100 fixture replay", () => {
  let outputDir: string;
  let tempDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "xp7100-out-"));
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xp7100-tmp-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  const XP_7100_FIXTURES = path.join("tools", "pcap-extract", "captures", "xp-7100");

  async function runOne(opts: { fixtureFile: string; source: "flatbed" | "adf"; duplex: boolean }) {
    const fixturePath = path.join(XP_7100_FIXTURES, opts.fixtureFile);
    const fixture = loadFixture(fixturePath);
    const fake = new FakePlainSocket();
    const sessionPromise = runEsci2ScanOverPlain(
      {
        printerIp: "10.0.0.143",
        port: 1865,
        destId: 0x02,
        outputDir,
        tempDir,
        duplex: opts.duplex,
        action: "jpg",
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    // Wire-fidelity check: scanner emitted same PARA bytes the driver did.
    const capturedPara = extractCapturedParaBody(fixture);
    const scannerPara = extractScannerParaWrite(fake);
    expect(scannerPara.equals(capturedPara)).toBe(true);

    // Cross-check the recipe: captured PARA equals what the composer would build
    // for these axes. (Recipe-level tests cover this against .bin fixtures; this
    // adds one more anchor from the JSONL side, catching any drift between
    // .bin and JSONL extractions.)
    const paraSource: ParaSpec["source"] =
      opts.source === "flatbed" ? "flatbed" : opts.duplex ? "adf-duplex" : "adf-simplex";
    const recipePara = composePara(makeParaSpec(REGISTRY.get(XP7100_FP)!, paraSource, "jpg"));
    expect(capturedPara.equals(recipePara)).toBe(true);

    return readdirSync(outputDir).filter((f) => f.endsWith(".jpg"));
  }

  it("flatbed JPG single page", async () => {
    const jpgs = await runOne({
      fixtureFile: "jpg-flatbed.jsonl",
      source: "flatbed",
      duplex: false,
    });
    expect(jpgs).toHaveLength(1);
  }, 60_000);

  it("ADF simplex JPG single page", async () => {
    const jpgs = await runOne({
      fixtureFile: "jpg-adf-simplex.jsonl",
      source: "adf",
      duplex: false,
    });
    expect(jpgs).toHaveLength(1);
  }, 60_000);

  it("ADF duplex JPG", async () => {
    const jpgs = await runOne({
      fixtureFile: "jpg-adf-duplex.jsonl",
      source: "adf",
      duplex: true,
    });
    expect(jpgs).toHaveLength(2); // duplex → front + back
  }, 60_000);
});

const ET4800_FP = "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2";

describe("runEsci2ScanOverPlain — ET-4800 fixture replay", () => {
  let outputDir: string;
  let tempDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "et4800-out-"));
    tempDir = mkdtempSync(path.join(os.tmpdir(), "et4800-tmp-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  const FIX_DIR = path.join("tools", "pcap-extract", "captures", "et-4800");

  async function runOne(opts: {
    fixtureFile: string;
    source: "flatbed" | "adf";
    action: "jpg" | "pdf";
  }) {
    const fixture = loadFixture(path.join(FIX_DIR, opts.fixtureFile));
    const fake = new FakePlainSocket();
    const sessionPromise = runEsci2ScanOverPlain(
      {
        printerIp: "192.168.27.230",
        port: 1865,
        destId: 0x02,
        outputDir,
        tempDir,
        duplex: false,
        action: opts.action,
      },
      fake.asFactory(),
    );
    await driveFixture(fixture, fake, sessionPromise);

    // Byte-equivalence shield: the scanner's PARA wire bytes must match the
    // captured Wireshark session. Without this, driveFixture replays the
    // printer's responses regardless of what PARA the scanner emitted, so a
    // composer/registry/class-data regression would not fail this test.
    // Mirrors the ET-2750 and XP-7100 replays.
    const capturedPara = extractCapturedParaBody(fixture);
    const scannerPara = extractScannerParaWrite(fake);
    expect(scannerPara.equals(capturedPara)).toBe(true);

    // Cross-check that the scanner auto-detected the correct source via the
    // stat-length heuristic: the captured PARA equals what the composer builds
    // for that source axis (ET-4800 PARA is action-invariant, so action only
    // selects identical gamma/cmx classes here).
    const paraSource: ParaSpec["source"] = opts.source === "flatbed" ? "flatbed" : "adf-simplex";
    const recipePara = composePara(makeParaSpec(REGISTRY.get(ET4800_FP)!, paraSource, opts.action));
    expect(capturedPara.equals(recipePara)).toBe(true);

    return readdirSync(outputDir);
  }

  it("flatbed JPG", async () => {
    const files = await runOne({
      fixtureFile: "flatbed-jpg.jsonl",
      source: "flatbed",
      action: "jpg",
    });
    expect(files.filter((f) => f.endsWith(".jpg")).length).toBe(1);
  }, 60_000);

  it("flatbed PDF", async () => {
    await runOne({ fixtureFile: "flatbed-pdf.jsonl", source: "flatbed", action: "pdf" });
    await waitForPdf(outputDir);
    const files = readdirSync(outputDir);
    expect(files.filter((f) => f.endsWith(".jpg"))).toEqual([]); // temp dir cleaned, no stragglers
    expect(files.filter((f) => f.endsWith(".pdf")).length).toBe(1);
  }, 60_000);

  it("ADF JPG", async () => {
    const files = await runOne({ fixtureFile: "adf-jpg.jsonl", source: "adf", action: "jpg" });
    expect(files.filter((f) => f.endsWith(".jpg")).length).toBe(1);
  }, 60_000);

  it("ADF PDF", async () => {
    await runOne({ fixtureFile: "adf-pdf.jsonl", source: "adf", action: "pdf" });
    await waitForPdf(outputDir);
    const files = readdirSync(outputDir);
    expect(files.filter((f) => f.endsWith(".jpg"))).toEqual([]); // temp dir cleaned, no stragglers
    expect(files.filter((f) => f.endsWith(".pdf")).length).toBe(1);
  }, 60_000);
});
