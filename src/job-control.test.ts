import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";
import { buildDummyJobWritePacket, buildJobReadPacket, runJobNumberCommit } from "./job-control.js";
import { buildIsPacket, buildUnlockPacket } from "./protocol.js";

describe("FF-680W job-control packet builders", () => {
  it("builds the JobList dummy JOBW packet observed in the Mac trace", () => {
    expect(buildDummyJobWritePacket().toString("hex")).toBe(
      "49532300000c0000003a00000000003200000000" +
        "4a4f425700000000000000000000000000000000011a18000000000a0000" +
        "440075006d006d00790003000000020000020100",
    );
  });

  it("builds the JobNumber JOBR packet observed in the Mac trace", () => {
    expect(buildJobReadPacket().toString("hex")).toBe(
      "49532300000c0000000c000000000004000000084a4f4252",
    );
  });
});

// Minimal scripted socket: replies to each write via `onWrite`, and records
// writes / end-payloads / destroy so the error-path behaviour is observable.
class FakeJobSocket extends EventEmitter {
  readonly readyState = "open" as const;
  readonly writes: Buffer[] = [];
  readonly ends: Buffer[] = [];
  destroyed = false;

  constructor(private readonly onWrite: (data: Buffer) => Buffer | null) {
    super();
  }

  write(data: Buffer): boolean {
    this.writes.push(data);
    const resp = this.onWrite(data);
    if (resp) setImmediate(() => this.emit("data", resp));
    return true;
  }

  end(data?: Buffer): this {
    if (data) this.ends.push(data);
    setImmediate(() => this.emit("close"));
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    setImmediate(() => this.emit("close"));
    return this;
  }
}

const asSocket = (f: FakeJobSocket): Socket => f as unknown as Socket;
const isType = (buf: Buffer): number => buf.readUInt16BE(2);

describe("runJobControl error handling", () => {
  it("sends UNLOCK before closing when the job reply fails after the lock is held", async () => {
    const welcome = buildIsPacket(0x8000, Buffer.from([0x01, 0x04, 0x00, 0x00, 0x00]));
    const lockAck = buildIsPacket(0xa100, Buffer.from([0x06]));
    const badReply = buildIsPacket(0xa300, Buffer.alloc(4)); // JOBR expects 8 bytes

    const fake = new FakeJobSocket((data) => {
      const t = isType(data);
      if (t === 0x2100) return lockAck; // lock → ack
      if (t === 0x2300) return badReply; // JOBR → wrong-length reply, throws
      return null;
    });

    const p = runJobNumberCommit({
      printerIp: "192.0.2.9",
      socketFactory: () => asSocket(fake),
    });
    setImmediate(() => fake.emit("data", welcome));

    // The error carries the actual reply bytes so a rejected handshake is
    // diagnosable from the debug log alone, without a pcap (issue #128).
    await expect(p).rejects.toThrow(/reply payload length 4, expected 8 \(payload=00000000\)/);
    // Lock was acquired, so the error path must flush an UNLOCK (via end()).
    expect(fake.ends.some((b) => b.equals(buildUnlockPacket()))).toBe(true);
    expect(fake.destroyed).toBe(false);
  });

  it("fails on a socket error that lands between two reads, naming it, not a timeout", async () => {
    const welcome = buildIsPacket(0x8000, Buffer.from([0x01, 0x04, 0x00, 0x00, 0x00]));
    // The printer resets the connection as the lock goes out, before the
    // lock-ack read is listening.
    const fake: FakeJobSocket = new FakeJobSocket((data) => {
      if (isType(data) === 0x2100) {
        fake.emit("error", new Error("read ECONNRESET"));
        fake.emit("close");
      }
      return null;
    });
    const p = runJobNumberCommit({
      printerIp: "192.0.2.9",
      timeoutMs: 2000,
      socketFactory: () => asSocket(fake),
    });
    setImmediate(() => fake.emit("data", welcome));

    await expect(p).rejects.toThrow(/^JOBR lock ack: read ECONNRESET$/);
  });

  it("reports the reply type and bytes when a packet has an unexpected IS type", async () => {
    const welcome = buildIsPacket(0x8000, Buffer.from([0x01, 0x04, 0x00, 0x00, 0x00]));
    const lockAck = buildIsPacket(0xa100, Buffer.from([0x06]));
    // JOBR reply comes back as the wrong IS type — the failure mode we'd expect
    // if the DS-575W doesn't accept the FF-680W-derived job-control commands.
    const wrongTypeReply = buildIsPacket(0xa301, Buffer.from([0xde, 0xad, 0xbe, 0xef]));

    const fake = new FakeJobSocket((data) => {
      const t = isType(data);
      if (t === 0x2100) return lockAck;
      if (t === 0x2300) return wrongTypeReply;
      return null;
    });

    const p = runJobNumberCommit({
      printerIp: "192.0.2.9",
      socketFactory: () => asSocket(fake),
    });
    setImmediate(() => fake.emit("data", welcome));

    await expect(p).rejects.toThrow(
      /JOBR reply: expected IS 0xa300, got 0xa301 \(payload=deadbeef\)/,
    );
  });

  it("fails fast on a desynced stream (oversized declared IS payload)", async () => {
    const bogus = Buffer.alloc(12);
    bogus.write("IS", 0, "latin1");
    bogus.writeUInt16BE(0x8000, 2);
    bogus.writeUInt32BE(0x00100000, 6); // 1 MB declared — far past the sanity cap

    const fake = new FakeJobSocket(() => null);
    const p = runJobNumberCommit({
      printerIp: "192.0.2.9",
      socketFactory: () => asSocket(fake),
    });
    setImmediate(() => fake.emit("data", bogus));

    await expect(p).rejects.toThrow(/framing desync/);
  });

  it("fails a timed-out welcome on a real socket without an uncaught socket error", async () => {
    // The printer accepts the connection and never sends its welcome.
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      await expect(
        runJobNumberCommit({ printerIp: "127.0.0.1", port, timeoutMs: 100 }),
      ).rejects.toThrow(/JOBR welcome: read timeout after 100ms/);
      // The socket's error event, if any, is emitted after the rejection.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
