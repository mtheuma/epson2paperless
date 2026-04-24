import { describe, it, expect } from "vitest";
import { formatRecord, CaptureRecord } from "./pretty-print.js";

// Helper: build a full IS packet (12-byte header + payload) in hex.
function buildIsPacketHex(type: number, payload: Buffer): string {
  const header = Buffer.alloc(12);
  header.write("IS", 0, "ascii");
  header.writeUInt16BE(type, 2);
  header.writeUInt16BE(0x000c, 4); // reserved/offset field (matches our own encoder)
  header.writeUInt32BE(payload.length, 6);
  return Buffer.concat([header, payload]).toString("hex");
}

describe("formatRecord", () => {
  it("annotates a welcome packet (type 0x8000, no payload)", () => {
    const packetHex = buildIsPacketHex(0x8000, Buffer.alloc(0));
    const record: CaptureRecord = {
      ts: "2026-04-18T14:30:12.341Z",
      hook: "recv",
      type_hex: "0x8000",
      payload_hex: packetHex,
      payload_size: 12,
    };
    const line = formatRecord(record);
    expect(line).toContain("RECV");
    expect(line).toContain("type=0x8000");
    expect(line).toContain("Welcome");
  });

  it("annotates a lock packet (type 0x2100)", () => {
    const lockBody = Buffer.from([0x01, 0xa0, 0x04, 0x00, 0x00, 0x01, 0x2c]);
    const packetHex = buildIsPacketHex(0x2100, lockBody);
    const record: CaptureRecord = {
      ts: "2026-04-18T14:30:13.000Z",
      hook: "send",
      type_hex: "0x2100",
      payload_hex: packetHex,
      payload_size: 12 + lockBody.length,
    };
    const line = formatRecord(record);
    expect(line).toContain("SEND");
    expect(line).toContain("type=0x2100");
    expect(line).toContain("Lock");
  });

  it("extracts ESC/I-2 command name from a passthru send (type 0x2000)", () => {
    // Passthru IS payload: 8-byte data header (cmd_size, reply_size) + ESC/I-2 command.
    const cmdSize = Buffer.alloc(4);
    cmdSize.writeUInt32BE(12, 0);
    const replySize = Buffer.alloc(4);
    replySize.writeUInt32BE(65536, 0);
    const esciCmd = Buffer.from("INFOx0000000", "ascii");
    const isPayload = Buffer.concat([cmdSize, replySize, esciCmd]);
    const packetHex = buildIsPacketHex(0x2000, isPayload);
    const record: CaptureRecord = {
      ts: "2026-04-18T14:30:14.000Z",
      hook: "send",
      type_hex: "0x2000",
      payload_hex: packetHex,
      payload_size: 12 + isPayload.length,
    };
    const line = formatRecord(record);
    expect(line).toContain("SEND");
    expect(line).toContain("type=0x2000");
    expect(line).toContain("Passthru");
    expect(line).toContain('cmd="INFO"');
  });

  it("annotates a ServerError async event (0x9000 with dispatch byte 0xa0)", () => {
    // AsyncEvent records don't have an IS header — payload_hex is the raw event payload.
    const record: CaptureRecord = {
      ts: "2026-04-18T14:30:15.000Z",
      hook: "async_event",
      type_hex: "0x9000",
      payload_hex: "a0",
      payload_size: 1,
    };
    const line = formatRecord(record);
    expect(line).toContain("ASYNC");
    expect(line).toContain("type=0x9000");
    expect(line).toContain("ServerError");
  });

  it("labels unknown type codes with the hex value only", () => {
    const packetHex = buildIsPacketHex(0xffff, Buffer.alloc(0));
    const record: CaptureRecord = {
      ts: "2026-04-18T14:30:16.000Z",
      hook: "recv",
      type_hex: "0xffff",
      payload_hex: packetHex,
      payload_size: 12,
    };
    const line = formatRecord(record);
    expect(line).toContain("type=0xffff");
    expect(line).not.toContain("undefined");
  });

  it("returns empty string for a malformed packet without crashing", () => {
    // Garbage hex — parseIsPacket should return null; formatter should still produce output.
    const record: CaptureRecord = {
      ts: "2026-04-18T14:30:17.000Z",
      hook: "send",
      type_hex: "0x2000",
      payload_hex: "deadbeef",
      payload_size: 4,
    };
    const line = formatRecord(record);
    expect(line).toContain("SEND");
    expect(line).toContain("type=0x2000");
    // No "cmd=..." since the inner payload couldn't be parsed.
    expect(line).not.toContain('cmd="');
  });
});
