import { describe, it, expect } from "vitest";
import { runEsciScan } from "./scanner.js";
import { FakeTcpSocket } from "./test-support/fake-tcp-socket.js";
import { buildIsPacket, parseIsPacket } from "../protocol.js";

// Welcome and lock-ack helpers — same shape as the WF-3620 fixtures.
const welcome = buildIsPacket(0x8000, Buffer.alloc(0));
const lockAck = buildIsPacket(0xa100, Buffer.alloc(0));
// Reply payload of a single byte 0x15 wrapped in the same IS-0xa000 sub-type
// that ACKs use. Mirrors the ET-2750 report from issue #43.
const nakReply = buildIsPacket(0xa000, Buffer.from([0x15]));
const ackReply = buildIsPacket(0xa000, Buffer.from([0x06]));

const ESC_AT = Buffer.from([0x1b, 0x40]);
const FS_Y = Buffer.from([0x1c, 0x59]);

function passthruCommand(buf: Buffer): Buffer {
  // buildPassthruPacket prepends an 8-byte data header (cmd_size, reply_size)
  // before the actual command bytes — extract those for assertions.
  const pkt = parseIsPacket(buf);
  if (!pkt || pkt.type !== 0x2000) throw new Error(`not a passthru packet: ${buf.toString("hex")}`);
  return pkt.payload.subarray(8);
}

describe("scanner-esci DIAGNOSE_PROTOCOL probe", () => {
  it("sends FS Y after ESC @ NAK and rejects with a diagnostic message", async () => {
    const fake = new FakeTcpSocket();
    const promise = runEsciScan(
      {
        printerIp: "10.0.0.1",
        port: 1865,
        outputDir: "/tmp",
        tempDir: "",
        duplex: false,
        forcedSource: "flatbed",
        format: "pdf",
        jpegQuality: 90,
        diagnoseProtocol: true,
      },
      fake.asFactory(),
    );

    fake.simulateConnect();
    fake.feed(welcome);
    expect(parseIsPacket(fake.writes[0])?.type).toBe(0x2100); // lock packet
    fake.feed(lockAck);
    expect(passthruCommand(fake.writes[1]).equals(ESC_AT)).toBe(true);

    // Printer NAKs ESC @ — diagnostic mode should send FS Y instead of failing.
    fake.feed(nakReply);
    expect(passthruCommand(fake.writes[2]).equals(FS_Y)).toBe(true);

    // Printer ACKs FS Y — session still aborts, but with a diagnostic message.
    fake.feed(ackReply);

    await expect(promise).rejects.toThrow(/diagnostic probe complete/);
  });

  it("rejects with a diagnostic message even when FS Y is also NAK'd", async () => {
    const fake = new FakeTcpSocket();
    const promise = runEsciScan(
      {
        printerIp: "10.0.0.1",
        port: 1865,
        outputDir: "/tmp",
        tempDir: "",
        duplex: false,
        forcedSource: "flatbed",
        format: "pdf",
        jpegQuality: 90,
        diagnoseProtocol: true,
      },
      fake.asFactory(),
    );

    fake.simulateConnect();
    fake.feed(welcome);
    fake.feed(lockAck);
    fake.feed(nakReply);
    expect(passthruCommand(fake.writes[2]).equals(FS_Y)).toBe(true);

    // Both legacy ESC @ and ESC/I-2 FS Y rejected — printer is in some other family.
    fake.feed(nakReply);

    await expect(promise).rejects.toThrow(/diagnostic probe complete/);
  });

  it("preserves existing behaviour when DIAGNOSE_PROTOCOL is off", async () => {
    const fake = new FakeTcpSocket();
    const promise = runEsciScan(
      {
        printerIp: "10.0.0.1",
        port: 1865,
        outputDir: "/tmp",
        tempDir: "",
        duplex: false,
        forcedSource: "flatbed",
        format: "pdf",
        jpegQuality: 90,
        // diagnoseProtocol omitted (defaults to undefined / false)
      },
      fake.asFactory(),
    );

    fake.simulateConnect();
    fake.feed(welcome);
    fake.feed(lockAck);
    fake.feed(nakReply);

    // No FS Y probe — only the lock packet and ESC @ should have been sent.
    expect(fake.writes.length).toBe(2);
    await expect(promise).rejects.toThrow(/expected ESC @ ack, got type=0xa000 payload=15/);
  });
});
