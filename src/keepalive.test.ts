import { describe, it, expect } from "vitest";
import dgram from "node:dgram";
import {
  buildKeepalivePacket,
  parsePrinterAnnouncement,
  createKeepaliveResponder,
  type KeepaliveResponder,
  type KeepaliveResponderOptions,
} from "./keepalive.js";

// ---------------------------------------------------------------------------
// buildKeepalivePacket
// ---------------------------------------------------------------------------

describe("buildKeepalivePacket", () => {
  it("matches the captured reference packet (seq=0x07, T1-DESKTOP)", () => {
    const packet = buildKeepalivePacket(
      {
        clientName: "T1-DESKTOP",
        ipAddress: "203.0.113.95",
        eventPort: 2968,
        destId: 0x02,
        language: "en",
      },
      0x07,
    );

    // Reference payload from Wireshark capture (86 bytes).
    // Byte 11 is 0x07 — the sequence echoed from the printer's announcement.
    const expected = Buffer.from(
      "0207000056000000000000070002656e0000004128436c69656e744e616d653d" +
        "54312d4445534b544f50292c284950416464726573733d3230332e302e313133" +
        "2e3935292c284576656e74506f72743d323936382900",
      "hex",
    );

    expect(packet.length).toBe(86);
    expect(Buffer.compare(packet, expected)).toBe(0);
  });

  it("honors the seq parameter — seq=0x02 writes 0x02 at byte 11", () => {
    const packet = buildKeepalivePacket(
      {
        clientName: "T1-DESKTOP",
        ipAddress: "203.0.113.95",
        eventPort: 2968,
        destId: 0x02,
        language: "en",
      },
      0x02,
    );

    expect(packet[11]).toBe(0x02);
    // Total length and everything else should be the same as the seq=0x07 case
    expect(packet.length).toBe(86);
    expect(packet[4]).toBe(86);
  });

  it("adjusts length fields for clientName='Paperless' (0x55 total, 0x40 string len)", () => {
    const packet = buildKeepalivePacket(
      {
        clientName: "Paperless",
        ipAddress: "192.0.2.100",
        eventPort: 2968,
        destId: 0x02,
        language: "en",
      },
      0x07,
    );

    // "(ClientName=Paperless),(IPAddress=192.0.2.100),(EventPort=2968)\0"
    const kvString = "(ClientName=Paperless),(IPAddress=192.0.2.100),(EventPort=2968)\0";
    const expectedStringLen = Buffer.byteLength(kvString, "ascii") - 1; // excludes null terminator
    const expectedTotalLen = 20 + expectedStringLen + 1; // header + string bytes inc. null

    // Total length byte at offset 4
    expect(packet[4]).toBe(expectedTotalLen);
    // String length field at offset 16-19 (big-endian uint32)
    expect(packet.readUInt32BE(16)).toBe(expectedStringLen);
    // String content starts at offset 20
    expect(packet.subarray(20).toString("ascii")).toBe(kvString);
    // Seq is still honoured
    expect(packet[11]).toBe(0x07);
  });
});

// ---------------------------------------------------------------------------
// parsePrinterAnnouncement
// ---------------------------------------------------------------------------

describe("parsePrinterAnnouncement", () => {
  // Full printer announcement payload from the Wireshark capture.
  // Byte 11 = 0x07.
  const announcementBytes = Buffer.from([
    0x02, 0x06, 0x00, 0x00, 0x5c, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x02, 0x65, 0x6e,
    0x00, 0x00, 0x00, 0x1c,
    // "service:NetScanMonitor-agent\0"
    0x73, 0x65, 0x72, 0x76, 0x69, 0x63, 0x65, 0x3a, 0x4e, 0x65, 0x74, 0x53, 0x63, 0x61, 0x6e, 0x4d,
    0x6f, 0x6e, 0x69, 0x74, 0x6f, 0x72, 0x2d, 0x61, 0x67, 0x65, 0x6e, 0x74, 0x00,
    // "\x08PID 11D1\0"
    0x08, 0x50, 0x49, 0x44, 0x20, 0x31, 0x31, 0x44, 0x31, 0x00,
    // "\x1eClientName,IPAddress,EventPort\0"
    0x1e, 0x43, 0x6c, 0x69, 0x65, 0x6e, 0x74, 0x4e, 0x61, 0x6d, 0x65, 0x2c, 0x49, 0x50, 0x41, 0x64,
    0x64, 0x72, 0x65, 0x73, 0x73, 0x2c, 0x45, 0x76, 0x65, 0x6e, 0x74, 0x50, 0x6f, 0x72, 0x74, 0x00,
    0x00,
  ]);

  it("parses the printer announcement and returns seq=0x07", () => {
    const result = parsePrinterAnnouncement(announcementBytes);
    expect(result).not.toBeNull();
    expect(result!.seq).toBe(0x07);
  });

  it("returns null for a keepalive packet (starts with 02 07 00 00)", () => {
    // A keepalive starts with 02 07, not 02 06
    const keepalive = Buffer.from(
      "0207000056000000000000070002656e0000004128436c69656e744e616d653d" +
        "54312d4445534b544f50292c284950416464726573733d3230332e302e313133" +
        "2e3935292c284576656e74506f72743d323936382900",
      "hex",
    );
    expect(parsePrinterAnnouncement(keepalive)).toBeNull();
  });

  it("returns null for a packet shorter than 12 bytes", () => {
    expect(parsePrinterAnnouncement(Buffer.from([0x02, 0x06, 0x00]))).toBeNull();
    expect(parsePrinterAnnouncement(Buffer.alloc(0))).toBeNull();
    expect(parsePrinterAnnouncement(Buffer.alloc(11))).toBeNull();
  });

  it("returns null for an arbitrary non-Epson UDP packet", () => {
    const random = Buffer.from([
      0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    ]);
    expect(parsePrinterAnnouncement(random)).toBeNull();
  });

  it("accepts a minimal 12-byte announcement (just the header)", () => {
    // prettier-ignore
    const minimal = Buffer.from([
      0x02, 0x06, 0x00, 0x00, // command type
      0x0c,                   // total length = 12
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // reserved
      0x0a,                   // seq = 0x0a
    ]);
    const result = parsePrinterAnnouncement(minimal);
    expect(result).not.toBeNull();
    expect(result!.seq).toBe(0x0a);
  });
});

// ---------------------------------------------------------------------------
// createKeepaliveResponder — integration tests using real loopback UDP sockets
// ---------------------------------------------------------------------------

describe("createKeepaliveResponder", () => {
  const KEEPALIVE_OPTS = {
    clientName: "TestClient",
    ipAddress: "127.0.0.1",
    eventPort: 12345,
    destId: 0x02,
    language: "en",
  };

  function makeAnnouncement(seq: number): Buffer {
    // Minimum-viable 02 06 announcement packet. The responder only validates
    // bytes 0-3 (must be 02 06 00 00) and reads byte 11 as the sequence.
    const pkt = Buffer.alloc(20);
    pkt[0] = 0x02;
    pkt[1] = 0x06;
    pkt[11] = seq;
    return pkt;
  }

  interface Harness {
    listener: dgram.Socket;
    announcer: dgram.Socket;
    responder: KeepaliveResponder;
    received: Buffer[];
    teardown: () => void;
  }

  // Stand up a loopback listener (fake printer), a responder wired to that
  // port, and an announcer (fake multicast source). Overrides merge into the
  // default opts. Returns `teardown` to close all three sockets in one call.
  async function setupHarness(
    overrides: Partial<
      Omit<KeepaliveResponderOptions, "keepalive" | "printerIp" | "printerPort">
    > = {},
  ): Promise<Harness> {
    const listener = dgram.createSocket("udp4");
    await new Promise<void>((r) => listener.bind(0, "127.0.0.1", () => r()));
    const listenerPort = listener.address().port;

    const received: Buffer[] = [];
    listener.on("message", (msg) => received.push(msg));

    const responder = createKeepaliveResponder({
      keepalive: KEEPALIVE_OPTS,
      printerIp: "127.0.0.1",
      printerPort: listenerPort,
      multicastAddress: "239.255.255.250", // arbitrary; routing unused
      multicastPort: 0, // ephemeral
      burstCount: 3,
      burstIntervalMs: 10,
      ...overrides,
    });
    await responder.start();

    const announcer = dgram.createSocket("udp4");
    await new Promise<void>((r) => announcer.bind(0, "127.0.0.1", () => r()));

    return {
      listener,
      announcer,
      responder,
      received,
      teardown: () => {
        responder.stop();
        listener.close();
        announcer.close();
      },
    };
  }

  // Unicast `pkt` to the responder's bound port and resolve on send callback.
  function sendAnnouncement(harness: Harness, pkt: Buffer): Promise<void> {
    return new Promise<void>((r) =>
      harness.announcer.send(pkt, harness.responder.boundPort, "127.0.0.1", () => r()),
    );
  }

  it("responds to a printer announcement with a burst of N keepalives", async () => {
    const h = await setupHarness();
    await sendAnnouncement(h, makeAnnouncement(0x42));
    // Wait for the 3-packet burst (3 * 10ms + slack)
    await new Promise((r) => setTimeout(r, 80));

    expect(h.received).toHaveLength(3);
    h.received.forEach((p) => expect(p[11]).toBe(0x42));

    h.teardown();
  });

  it("ignores non-announcement packets", async () => {
    const h = await setupHarness();
    // Keepalive-shape packet (02 07) — NOT an announcement (02 06)
    const badPacket = Buffer.alloc(20);
    badPacket[0] = 0x02;
    badPacket[1] = 0x07;
    await sendAnnouncement(h, badPacket);
    await new Promise((r) => setTimeout(r, 80));

    expect(h.received).toHaveLength(0);

    h.teardown();
  });

  it("dedupes repeated announcements of the same seq within the window (3 announcements → 1 burst)", async () => {
    const h = await setupHarness({ dedupWindowMs: 1_000 });
    // Simulate the printer's 3-in-a-row beacons with identical seq.
    for (let i = 0; i < 3; i++) await sendAnnouncement(h, makeAnnouncement(0x42));
    await new Promise((r) => setTimeout(r, 80));

    // Only the first announcement triggered a burst: 3 packets total.
    expect(h.received).toHaveLength(3);
    h.received.forEach((p) => expect(p[11]).toBe(0x42));

    h.teardown();
  });

  it("fires a new burst for a distinct seq within the dedup window", async () => {
    const h = await setupHarness({ burstCount: 2, dedupWindowMs: 1_000 });
    await sendAnnouncement(h, makeAnnouncement(0x01));
    await sendAnnouncement(h, makeAnnouncement(0x02));
    await new Promise((r) => setTimeout(r, 60));

    // Both seqs fire their own burst: 2 bursts × 2 packets = 4 total.
    expect(h.received).toHaveLength(4);
    const seqs = h.received.map((p) => p[11]);
    expect(seqs.filter((s) => s === 0x01)).toHaveLength(2);
    expect(seqs.filter((s) => s === 0x02)).toHaveLength(2);

    h.teardown();
  });

  it("fires a new burst for the same seq after the dedup window expires", async () => {
    const h = await setupHarness({ burstCount: 1, dedupWindowMs: 40 });
    await sendAnnouncement(h, makeAnnouncement(0x05));
    await new Promise((r) => setTimeout(r, 80)); // wait past the dedup window
    await sendAnnouncement(h, makeAnnouncement(0x05));
    await new Promise((r) => setTimeout(r, 40));

    // Both announcements fired: 2 bursts × 1 packet = 2 total.
    expect(h.received).toHaveLength(2);
    h.received.forEach((p) => expect(p[11]).toBe(0x05));

    h.teardown();
  });

  it("stop() cancels pending burst timers before they fire", async () => {
    const h = await setupHarness({ burstIntervalMs: 100 }); // long enough that stop() interrupts
    await sendAnnouncement(h, makeAnnouncement(0x01));
    // Let the first burst packet fire (i=0 fires at t+0)...
    await new Promise((r) => setTimeout(r, 30));
    h.responder.stop();
    // ...and wait past when the 2nd and 3rd would have fired
    await new Promise((r) => setTimeout(r, 250));

    expect(h.received.length).toBeLessThanOrEqual(1);

    h.listener.close();
    h.announcer.close();
  });
});
