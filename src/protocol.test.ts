import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  IS_HEADER_SIZE,
  parseIsPacket,
  buildIsPacket,
  buildPassthruPacket,
  buildPurereadPacket,
  buildLockPacket,
  buildUnlockPacket,
} from "./protocol.js";

interface CaptureRecord {
  hook: string;
  type_hex?: string;
  payload_hex?: string;
}

// Read a Frida capture (JSONL) and return the first record matching `hook`.
// Parses line-by-line with early break so large captures aren't fully
// deserialised when the needle is near the top of the file.
function firstRecordOfKind(capturePath: string, hook: string): CaptureRecord | undefined {
  const text = readFileSync(capturePath, "utf8");
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      if (i > lineStart) {
        const line = text.slice(lineStart, i);
        const r = JSON.parse(line) as CaptureRecord;
        if (r.hook === hook) return r;
      }
      lineStart = i + 1;
    }
  }
  return undefined;
}

describe("parseIsPacket", () => {
  it("returns null when buffer is shorter than the header", () => {
    expect(parseIsPacket(Buffer.alloc(IS_HEADER_SIZE - 1))).toBeNull();
  });

  it("returns null when magic is not 'IS'", () => {
    const buf = Buffer.alloc(IS_HEADER_SIZE);
    buf.write("XX", 0, "ascii");
    expect(parseIsPacket(buf)).toBeNull();
  });

  it("returns null when payload is truncated", () => {
    // Header says payload size = 10, but buffer only has 5 payload bytes.
    const buf = Buffer.alloc(IS_HEADER_SIZE + 5);
    buf.write("IS", 0, "ascii");
    buf.writeUInt16BE(0x8000, 2);
    buf.writeUInt16BE(0x000c, 4);
    buf.writeUInt32BE(10, 6);
    expect(parseIsPacket(buf)).toBeNull();
  });

  it("parses a welcome packet (type 0x8000, empty payload)", () => {
    const buf = Buffer.from("49538000000c000000000000", "hex");
    const packet = parseIsPacket(buf);
    expect(packet).not.toBeNull();
    expect(packet!.type).toBe(0x8000);
    expect(packet!.payloadSize).toBe(0);
    expect(packet!.totalSize).toBe(IS_HEADER_SIZE);
  });

  it("round-trips with buildIsPacket", () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const built = buildIsPacket(0x2000, payload);
    const parsed = parseIsPacket(built);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe(0x2000);
    expect(parsed!.payloadSize).toBe(4);
    expect(Buffer.from(parsed!.payload).equals(payload)).toBe(true);
  });
});

describe("buildPassthruPacket", () => {
  // Capture record 1: FS Y legacy 2-byte command.
  // Expected hex: "49532000000c0000000a000000000002000000011c59"
  it("wraps a legacy 2-byte command (FS Y) — matches capture record 1", () => {
    const cmd = Buffer.from([0x1c, 0x59]);
    const packet = buildPassthruPacket(cmd, 1);
    expect(packet.toString("hex")).toBe("49532000000c0000000a000000000002000000011c59");
  });

  // Capture record 4: STAT ESC/I-2 header, reply_size=64.
  // Expected hex: "49532000000c0000001400000000000c00000040535441547830303030303030"
  it("wraps an ESC/I-2 command header (STAT) — matches capture record 4", () => {
    const cmd = Buffer.from("STATx0000000", "ascii");
    const packet = buildPassthruPacket(cmd, 64);
    expect(packet.toString("hex")).toBe(
      "49532000000c0000001400000000000c00000040535441547830303030303030",
    );
  });

  it("handles empty reply_size (PARA phase-1 header send)", () => {
    // Capture record 115: PARA header, cmd_size=12, reply_size=0.
    // "PARAx00003a8" as ASCII + preamble with reply_size=0.
    const cmd = Buffer.from("PARAx00003a8", "ascii");
    const packet = buildPassthruPacket(cmd, 0);
    // IS header 12 bytes + 8-byte preamble (cmd_size=12, reply_size=0) + 12-byte cmd = 32 bytes
    expect(packet.length).toBe(32);
    // Header: type 0x2000, offset 0x000c, payload_size=20
    expect(packet.subarray(0, 12).toString("hex")).toBe("49532000000c000000140000");
    // Preamble: cmd_size=12 (0x0c), reply_size=0
    expect(packet.subarray(12, 20).toString("hex")).toBe("0000000c00000000");
    // Command bytes
    expect(packet.subarray(20).toString("ascii")).toBe("PARAx00003a8");
  });
});

describe("buildPurereadPacket", () => {
  it("builds a pure-read passthru with cmd_size=0 and the given reply_size — matches capture record 1539 (reply_size=0x25F)", () => {
    const packet = buildPurereadPacket(0x25f);
    // IS header 12 + preamble 8 = 20 bytes, no command bytes.
    expect(packet.length).toBe(20);
    expect(packet.toString("hex")).toBe("49532000000c000000080000000000000000025f");
  });

  it("allows zero reply_size (edge case)", () => {
    const packet = buildPurereadPacket(0);
    expect(packet.toString("hex")).toBe("49532000000c00000008000000000000" + "00000000");
  });
});

describe("buildLockPacket", () => {
  // Lock-packet bytes are byte-identical across every Frida capture we hold
  // (all 7 ADF + flatbed captures — 1p/3p simplex/duplex, JPG + PDF). The
  // scanner sends this as its first write after WELCOME; a mismatch would
  // also fail the replay suite at send #0.
  it("matches the 19-byte LOCK send — IS type 0x2100 + 7-byte payload", () => {
    const packet = buildLockPacket();
    // Payload bytes: 01 a0 04 00 00 01 2c (7 bytes)
    // IS header: type 0x2100, offset 0x000c, payload_size=7
    expect(packet.toString("hex")).toBe("49532100000c00000007000001a0040000012c");
    expect(packet.length).toBe(19);
  });

  it("matches the first SEND record in the 1p-simplex-JPG Frida capture (record 4)", () => {
    // Evidence-based regression shield: if either the code or the capture
    // drifts, this test fails with a clear diff. Other captures have the
    // same LOCK bytes at the same position (verified manually against all 7).
    const capturePath = path.resolve(
      __dirname,
      "..",
      "tools/frida-capture/captures/2026-04-24T08-56-07-adf-1p-simplex.jsonl",
    );
    const firstSend = firstRecordOfKind(capturePath, "send");
    expect(firstSend?.type_hex).toBe("0x2100");
    expect(firstSend?.payload_hex).toBe(buildLockPacket().toString("hex"));
  });
});

describe("buildUnlockPacket", () => {
  it("builds the unlock packet — matches capture record 4956", () => {
    const packet = buildUnlockPacket();
    expect(packet.toString("hex")).toBe("49532101000c000000000000");
  });
});
