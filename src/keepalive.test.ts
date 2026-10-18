import { PID_FF680W, PID_DS575W } from "./printer-ids.js";
import { describe, it, expect, vi } from "vitest";
import { getLogLevel, setLogLevel } from "./logger.js";
import dgram from "node:dgram";
import {
  buildKeepalivePacket,
  parsePrinterAnnouncement,
  createKeepaliveResponder,
  type KeepaliveResponder,
  type KeepaliveResponderOptions,
} from "./keepalive.js";

// ---------------------------------------------------------------------------
// Captured announcements (fixtures)
// ---------------------------------------------------------------------------

// ET-4950 announcement (NetScanMonitor v2): full payload from the Wireshark
// capture. Byte 11 = 0x07.
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

// FF-680W announcement (NetScanMonitor v3) from a Wireshark capture: the
// multicast UDP payload, which carries no address, MAC or serial. Byte 11 =
// 0x02. Its tag list asks for Ver and Group on top of the v2 three.
const ff680wAnnouncementBytes = Buffer.from(
  "0206000066200000000000020002656e0000001c" +
    // "service:NetScanMonitor-agent\0"
    "736572766963653a4e65745363616e4d6f6e69746f722d6167656e7400" +
    // "\x08PID 016B\0"
    "08504944203031364200" +
    // "\x28Ver,ClientName,IPAddress,EventPort,Group\0"
    "285665722c436c69656e744e616d652c4950416464726573732c4576656e74506f72742c47726f757000" +
    "00",
  "hex",
);

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

  it("matches the FF-680W Mac v3 reference packet when version=3.0", () => {
    const packet = buildKeepalivePacket(
      {
        clientName: "MacBookPro.lan",
        ipAddress: "192.168.10.152",
        eventPort: 2968,
        destId: 0x02,
        language: "en",
        version: "3.0",
      },
      0x07,
    );

    // UDP payload from Wireshark capture (112 bytes).
    // Byte 11 is 0x07 — the sequence echoed from the printer's announcement.
    const expected = Buffer.from(
      "0207000070000000000000070002656e0000005b285665723d332e30292c28436c" +
        "69656e744e616d653d4d6163426f6f6b50726f2e6c616e292c284950416464" +
        "726573733d3139322e3136382e31302e313532292c284576656e74506f7274" +
        "3d32393638292c2847726f75703d302900",
      "hex",
    );

    expect(packet.length).toBe(112);
    expect(Buffer.compare(packet, expected)).toBe(0);
  });

  it("answering the ET-4950 announcement's tag list reproduces the captured v2 packet", () => {
    const tags = parsePrinterAnnouncement(announcementBytes)!.requestedTags!;
    const packet = buildKeepalivePacket(
      {
        clientName: "T1-DESKTOP",
        ipAddress: "203.0.113.95",
        eventPort: 2968,
        destId: 0x02,
        language: "en",
      },
      0x07,
      tags,
    );

    expect(packet.toString("hex")).toBe(
      "0207000056000000000000070002656e0000004128436c69656e744e616d653d" +
        "54312d4445534b544f50292c284950416464726573733d3230332e302e313133" +
        "2e3935292c284576656e74506f72743d323936382900",
    );
  });

  it("answering the FF-680W announcement's tag list reproduces the captured v3 packet", () => {
    const tags = parsePrinterAnnouncement(ff680wAnnouncementBytes)!.requestedTags!;
    const packet = buildKeepalivePacket(
      {
        clientName: "MacBookPro.lan",
        ipAddress: "192.168.10.152",
        eventPort: 2968,
        destId: 0x02,
        language: "en",
      },
      0x07,
      tags,
    );

    expect(packet.toString("hex")).toBe(
      "0207000070000000000000070002656e0000005b285665723d332e30292c28436c" +
        "69656e744e616d653d4d6163426f6f6b50726f2e6c616e292c284950416464" +
        "726573733d3139322e3136382e31302e313532292c284576656e74506f7274" +
        "3d32393638292c2847726f75703d302900",
    );
  });

  it("answers requested tags in the order asked, skipping unknown and repeated tags", () => {
    const packet = buildKeepalivePacket(
      {
        clientName: "Paperless",
        ipAddress: "192.0.2.100",
        eventPort: 2968,
        destId: 0x02,
        language: "en",
      },
      0x07,
      ["EventPort", "Colour", "ClientName", "Ver", "EventPort", "IPAddress"],
    );

    expect(packet.subarray(20).toString("ascii")).toBe(
      "(EventPort=2968),(ClientName=Paperless),(Ver=3.0),(IPAddress=192.0.2.100)\0",
    );
    expect(packet[4]).toBe(packet.length);
    expect(packet.readUInt32BE(16)).toBe(packet.length - 21);
  });
});

// ---------------------------------------------------------------------------
// parsePrinterAnnouncement
// ---------------------------------------------------------------------------

describe("parsePrinterAnnouncement", () => {
  it("reads the requested tag list from the ET-4950 (v2) announcement", () => {
    expect(parsePrinterAnnouncement(announcementBytes)!.requestedTags).toEqual([
      "ClientName",
      "IPAddress",
      "EventPort",
    ]);
  });

  it("reads seq, PID and the requested tag list from the FF-680W (v3) announcement", () => {
    const result = parsePrinterAnnouncement(ff680wAnnouncementBytes);
    expect(result).toEqual({
      seq: 0x02,
      productName: "PID 016B",
      requestedTags: ["Ver", "ClientName", "IPAddress", "EventPort", "Group"],
    });
  });

  it("reports no tag list for a header-only announcement", () => {
    const headerOnly = Buffer.alloc(20);
    headerOnly[0] = 0x02;
    headerOnly[1] = 0x06;
    expect(parsePrinterAnnouncement(headerOnly)!.requestedTags).toBeNull();
  });

  it("skips a record that names no known field when looking for the tag list", () => {
    const withExtraRecord = Buffer.concat([
      ff680wAnnouncementBytes.subarray(0, 59),
      Buffer.from("\x06DS575W\0", "latin1"),
      ff680wAnnouncementBytes.subarray(59),
    ]);
    expect(parsePrinterAnnouncement(withExtraRecord)!.requestedTags).toEqual([
      "Ver",
      "ClientName",
      "IPAddress",
      "EventPort",
      "Group",
    ]);
  });

  it("reports no tag list when the records after the service string are malformed", () => {
    // Tag-list record claims 0x40 bytes but the packet ends first.
    const truncated = Buffer.concat([
      ff680wAnnouncementBytes.subarray(0, 59),
      Buffer.from("40566572", "hex"),
    ]);
    expect(parsePrinterAnnouncement(truncated)!.requestedTags).toBeNull();
  });

  it("parses the printer announcement and returns seq=0x07", () => {
    const result = parsePrinterAnnouncement(announcementBytes);
    expect(result).not.toBeNull();
    expect(result!.seq).toBe(0x07);
  });

  it("extracts the product name when present", () => {
    const result = parsePrinterAnnouncement(announcementBytes);
    expect(result).not.toBeNull();
    expect(result!.productName).toBe("PID 11D1");
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

  // PID-suffixed announcement, spelled with the same printer-ids constants the
  // production Set membership keys on — no second copy of the PID strings.
  function makePidAnnouncement(seq: number, pid: string): Buffer {
    return Buffer.concat([makeAnnouncement(seq), Buffer.from(`\x08${pid}\0`, "latin1")]);
  }

  interface Harness {
    listener: dgram.Socket;
    announcer: dgram.Socket;
    responder: KeepaliveResponder;
    received: Buffer[];
    /** Source UDP port each burst packet was sent from (parallel to `received`). */
    receivedFrom: number[];
    teardown: () => void;
  }

  // Stand up a loopback listener (fake printer), a responder wired to that
  // port, and an announcer (fake multicast source). Overrides merge into the
  // default opts (a `keepalive` override replaces the whole block). Returns
  // `teardown` to close all three sockets in one call.
  async function setupHarness(
    overrides: Partial<Omit<KeepaliveResponderOptions, "printerIp" | "printerPort">> = {},
  ): Promise<Harness> {
    const listener = dgram.createSocket("udp4");
    await new Promise<void>((r) => listener.bind(0, "127.0.0.1", () => r()));
    const listenerPort = listener.address().port;

    const received: Buffer[] = [];
    const receivedFrom: number[] = [];
    listener.on("message", (msg, rinfo) => {
      received.push(msg);
      receivedFrom.push(rinfo.port);
    });

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
      receivedFrom,
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

  // A fixed pause for the negative half of a test: proving nothing more
  // arrives. Only ever used after the positive part has been awaited.
  function settle(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Poll until `assertion` passes. Loopback delivery and the burst timers both
  // run on the event loop, so under a busy suite a fixed sleep can run out
  // first. The timeout stays well under the 5 s test timeout so a failure
  // reports the assertion, not a bare test timeout.
  function waitUntil(assertion: () => void): Promise<void> {
    return vi.waitFor(assertion, { timeout: 2_000, interval: 5 });
  }

  // Burst packets are 10 ms apart here, so a stray extra one would land well
  // inside this window.
  const EXTRA_PACKET_WINDOW_MS = 40;

  // Wait until the fake printer has seen at least `count` packets, then hold
  // a short window so any extra packet arrives too: the exact-count assertion
  // that follows then catches a burst that sends one too many.
  async function waitForReceived(harness: Harness, count: number): Promise<void> {
    await waitUntil(() => expect(harness.received.length).toBeGreaterThanOrEqual(count));
    await settle(EXTRA_PACKET_WINDOW_MS);
  }

  it("responds to a printer announcement with a burst of N keepalives", async () => {
    const h = await setupHarness();
    await sendAnnouncement(h, makeAnnouncement(0x42));
    await waitForReceived(h, 3);

    expect(h.received).toHaveLength(3);
    h.received.forEach((p) => {
      expect(p[11]).toBe(0x42);
      const payload = p.subarray(20).toString("ascii");
      expect(payload).not.toContain("(Ver=3.0)");
      expect(payload).not.toContain("(Group=0)");
    });

    h.teardown();
  });

  it.each([
    ["FF-680W", PID_FF680W],
    ["DS-575W", PID_DS575W],
  ])("auto-selects v3 keepalive for a %s announcement", async (_model, pid) => {
    const h = await setupHarness({ burstCount: 1 });
    try {
      await sendAnnouncement(h, makePidAnnouncement(0x43, pid));
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(h.received[0].subarray(20).toString("ascii")).toContain("(Ver=3.0)");
      expect(h.received[0].subarray(20).toString("ascii")).toContain("(Group=0)");
    } finally {
      h.teardown();
    }
  });

  it("sends the v2 fleet keepalive from the bound multicast socket (port preserved)", async () => {
    const h = await setupHarness({ burstCount: 2 });
    await sendAnnouncement(h, makeAnnouncement(0x44));
    await waitForReceived(h, 2);

    expect(h.receivedFrom).toHaveLength(2);
    // v2 bursts egress from the bound multicast socket, exactly as before the
    // FF-680W's ephemeral-sender path was added.
    h.receivedFrom.forEach((srcPort) => expect(srcPort).toBe(h.responder.boundPort));

    h.teardown();
  });

  it("sends the FF-680W (v3) keepalive from the separate ephemeral sender socket", async () => {
    const h = await setupHarness({ burstCount: 2 });
    await sendAnnouncement(h, makePidAnnouncement(0x45, PID_FF680W));
    await waitForReceived(h, 2);

    expect(h.receivedFrom).toHaveLength(2);
    // v3 bursts egress from the dedicated `sender` socket (matching the FF-680W
    // reference driver's ephemeral source port), NOT the bound multicast socket.
    h.receivedFrom.forEach((srcPort) => expect(srcPort).not.toBe(h.responder.boundPort));

    h.teardown();
  });

  it("forced version=3.0 sends v3 keepalives for a non-FF-680W announcement (NETSCAN_VERSION override)", async () => {
    const h = await setupHarness({
      burstCount: 1,
      keepalive: { ...KEEPALIVE_OPTS, version: "3.0" },
    });
    // Bare announcement with no PID string — would get v2 under auto-selection.
    await sendAnnouncement(h, makeAnnouncement(0x46));
    await waitForReceived(h, 1);

    expect(h.received).toHaveLength(1);
    const payload = h.received[0].subarray(20).toString("ascii");
    expect(payload).toContain("(Ver=3.0)");
    expect(payload).toContain("(Group=0)");
    // Forcing v3 also switches to the ephemeral sender's source port.
    expect(h.receivedFrom[0]).not.toBe(h.responder.boundPort);

    h.teardown();
  });

  it("forced version=2.0 sends v2 keepalives even for an FF-680W announcement", async () => {
    const h = await setupHarness({
      burstCount: 1,
      keepalive: { ...KEEPALIVE_OPTS, version: "2.0" },
    });
    await sendAnnouncement(h, makePidAnnouncement(0x47, PID_FF680W));
    await waitForReceived(h, 1);

    expect(h.received).toHaveLength(1);
    const payload = h.received[0].subarray(20).toString("ascii");
    expect(payload).not.toContain("(Ver=3.0)");
    expect(payload).not.toContain("(Group=0)");
    // v2 keeps the pre-FF-680W source-port behaviour: the bound multicast socket.
    expect(h.receivedFrom[0]).toBe(h.responder.boundPort);

    h.teardown();
  });

  // Announcement framed as the printer sends it: header, service string, a PID
  // record and a tag-list record (each length byte + text + NUL), zero end byte.
  function makeTaggedAnnouncement(seq: number, pid: string, tagList: string): Buffer {
    const service = "service:NetScanMonitor-agent";
    const header = makeAnnouncement(seq);
    header.writeUInt32BE(service.length, 16);
    const record = (text: string) =>
      Buffer.from(`${String.fromCharCode(text.length)}${text}\0`, "latin1");
    return Buffer.concat([
      header,
      Buffer.from(`${service}\0`, "latin1"),
      record(pid),
      record(tagList),
      Buffer.from([0x00]),
    ]);
  }

  function payloadOf(packet: Buffer): string {
    return packet.subarray(20).toString("ascii");
  }

  it("answers the captured FF-680W announcement in v3 from the ephemeral sender", async () => {
    const h = await setupHarness({ burstCount: 1 });
    try {
      await sendAnnouncement(h, ff680wAnnouncementBytes);
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(h.received[0][11]).toBe(0x02);
      expect(payloadOf(h.received[0])).toBe(
        "(Ver=3.0),(ClientName=TestClient),(IPAddress=127.0.0.1),(EventPort=12345),(Group=0)\0",
      );
      expect(h.receivedFrom[0]).not.toBe(h.responder.boundPort);
    } finally {
      h.teardown();
    }
  });

  it("answers the captured ET-4950 announcement in v2 from the bound socket", async () => {
    const h = await setupHarness({ burstCount: 1 });
    try {
      await sendAnnouncement(h, announcementBytes);
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(payloadOf(h.received[0])).toBe(
        "(ClientName=TestClient),(IPAddress=127.0.0.1),(EventPort=12345)\0",
      );
      expect(h.receivedFrom[0]).toBe(h.responder.boundPort);
    } finally {
      h.teardown();
    }
  });

  it("answers v3 for an unrecognised PID whose tag list requests Ver", async () => {
    const h = await setupHarness({ burstCount: 1 });
    try {
      await sendAnnouncement(
        h,
        makeTaggedAnnouncement(0x48, "PID 9999", "Ver,ClientName,IPAddress,EventPort,Group"),
      );
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(payloadOf(h.received[0])).toContain("(Ver=3.0)");
      expect(h.receivedFrom[0]).not.toBe(h.responder.boundPort);
    } finally {
      h.teardown();
    }
  });

  it("answers v2 for an FF-680W PID whose tag list doesn't request Ver", async () => {
    const h = await setupHarness({ burstCount: 1 });
    try {
      await sendAnnouncement(
        h,
        makeTaggedAnnouncement(0x49, PID_FF680W, "ClientName,IPAddress,EventPort"),
      );
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(payloadOf(h.received[0])).toBe(
        "(ClientName=TestClient),(IPAddress=127.0.0.1),(EventPort=12345)\0",
      );
      expect(h.receivedFrom[0]).toBe(h.responder.boundPort);
    } finally {
      h.teardown();
    }
  });

  it("skips requested tags it doesn't know and logs them at debug", async () => {
    const previous = getLogLevel();
    setLogLevel("debug");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = await setupHarness({ burstCount: 1 });
    try {
      await sendAnnouncement(
        h,
        makeTaggedAnnouncement(0x4a, "PID 9999", "ClientName,Colour,IPAddress,EventPort"),
      );
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(payloadOf(h.received[0])).toBe(
        "(ClientName=TestClient),(IPAddress=127.0.0.1),(EventPort=12345)\0",
      );
      const debugLines = logSpy.mock.calls
        .map((c) => c.map(String).join(" "))
        .filter((line) => line.includes("[DEBUG]") && line.includes("Colour"));
      expect(debugLines).toHaveLength(1);
    } finally {
      h.teardown();
      logSpy.mockRestore();
      setLogLevel(previous);
    }
  });

  it("falls back to the PID when no requested tag is one it knows", async () => {
    const h = await setupHarness({ burstCount: 1 });
    try {
      await sendAnnouncement(h, makeTaggedAnnouncement(0x4b, PID_DS575W, "Colour,Duplex"));
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(payloadOf(h.received[0])).toBe(
        "(Ver=3.0),(ClientName=TestClient),(IPAddress=127.0.0.1),(EventPort=12345),(Group=0)\0",
      );
    } finally {
      h.teardown();
    }
  });

  it("forced version=2.0 answers the captured FF-680W announcement in v2 regardless of its tag list", async () => {
    const h = await setupHarness({
      burstCount: 1,
      keepalive: { ...KEEPALIVE_OPTS, version: "2.0" },
    });
    try {
      await sendAnnouncement(h, ff680wAnnouncementBytes);
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(payloadOf(h.received[0])).toBe(
        "(ClientName=TestClient),(IPAddress=127.0.0.1),(EventPort=12345)\0",
      );
      expect(h.receivedFrom[0]).toBe(h.responder.boundPort);
    } finally {
      h.teardown();
    }
  });

  it("forced version=3.0 answers the captured ET-4950 announcement in v3 regardless of its tag list", async () => {
    const h = await setupHarness({
      burstCount: 1,
      keepalive: { ...KEEPALIVE_OPTS, version: "3.0" },
    });
    try {
      await sendAnnouncement(h, announcementBytes);
      await waitForReceived(h, 1);

      expect(h.received).toHaveLength(1);
      expect(payloadOf(h.received[0])).toBe(
        "(Ver=3.0),(ClientName=TestClient),(IPAddress=127.0.0.1),(EventPort=12345),(Group=0)\0",
      );
      expect(h.receivedFrom[0]).not.toBe(h.responder.boundPort);
    } finally {
      h.teardown();
    }
  });

  it("ignores non-announcement packets", async () => {
    const h = await setupHarness();
    // Keepalive-shape packet (02 07) — NOT an announcement (02 06)
    const badPacket = Buffer.alloc(20);
    badPacket[0] = 0x02;
    badPacket[1] = 0x07;
    await sendAnnouncement(h, badPacket);
    await settle(80);

    expect(h.received).toHaveLength(0);

    h.teardown();
  });

  it("warns once (throttled) naming observed and expected peer for a mismatched announcement", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fixed-IP target the loopback announcer can never match, so every beacon
    // from 127.0.0.1 is rejected.
    const responder = createKeepaliveResponder({
      keepalive: KEEPALIVE_OPTS,
      printerIp: "192.0.2.1",
      printerPort: 12345,
      multicastAddress: "239.255.255.250",
      multicastPort: 0,
      burstCount: 1,
      burstIntervalMs: 10,
    });
    await responder.start();
    const announcer = dgram.createSocket("udp4");
    await new Promise<void>((r) => announcer.bind(0, "127.0.0.1", () => r()));
    const send = (pkt: Buffer) =>
      new Promise<void>((r) => announcer.send(pkt, responder.boundPort, "127.0.0.1", () => r()));

    const rejectionWarns = () =>
      warnSpy.mock.calls
        .map((c) => c.map(String).join(" "))
        .filter((line) => line.includes("unrecognised peer"));

    try {
      await send(makeAnnouncement(0x50));
      await waitUntil(() => expect(rejectionWarns().length).toBeGreaterThanOrEqual(1));
      // Same peer, different seq — the per-address throttle should suppress
      // it. A rejected beacon leaves no other trace, so this half can only be
      // a fixed wait.
      await send(makeAnnouncement(0x51));
      await settle(EXTRA_PACKET_WINDOW_MS);

      expect(rejectionWarns()).toHaveLength(1);
      expect(rejectionWarns()[0]).toContain("127.0.0.1");
      expect(rejectionWarns()[0]).toContain("192.0.2.1");
    } finally {
      responder.stop();
      announcer.close();
      warnSpy.mockRestore();
    }
  });

  it("drops the dedup entry on a local-route failure so the next announcement retries", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const h = await setupHarness({
      burstCount: 1,
      localIpForTarget: (): Promise<string> => {
        calls++;
        if (calls === 1)
          return Promise.reject(Object.assign(new Error("no route"), { code: "EHOSTUNREACH" }));
        return Promise.resolve("127.0.0.1");
      },
    });
    try {
      // First attempt: route resolution rejects → no burst, no unhandled
      // rejection. The warning is logged after the dedup entry is dropped, so
      // once it shows the retry below can't be mistaken for a duplicate.
      await sendAnnouncement(h, makeAnnouncement(0x60));
      await waitUntil(() =>
        expect(
          warnSpy.mock.calls.some((c) => c.map(String).join(" ").includes("No local route")),
        ).toBe(true),
      );
      await settle(EXTRA_PACKET_WINDOW_MS);
      expect(h.received).toHaveLength(0);

      // Same seq again: must NOT be skipped as a duplicate — the failed attempt
      // cleared the dedup entry — so it retries and now succeeds.
      await sendAnnouncement(h, makeAnnouncement(0x60));
      await waitForReceived(h, 1);
      expect(h.received).toHaveLength(1);
      expect(h.received[0][11]).toBe(0x60);
    } finally {
      h.teardown();
      warnSpy.mockRestore();
    }
  });

  it("dedupes repeated announcements of the same seq within the window (3 announcements → 1 burst)", async () => {
    const h = await setupHarness({ dedupWindowMs: 1_000 });
    // Simulate the printer's 3-in-a-row beacons with identical seq.
    for (let i = 0; i < 3; i++) await sendAnnouncement(h, makeAnnouncement(0x42));
    // The settle inside waitForReceived also gives the two duplicates time to
    // start a second burst, if they were going to.
    await waitForReceived(h, 3);

    // Only the first announcement triggered a burst: 3 packets total.
    expect(h.received).toHaveLength(3);
    h.received.forEach((p) => {
      expect(p[11]).toBe(0x42);
      const payload = p.subarray(20).toString("ascii");
      expect(payload).not.toContain("(Ver=3.0)");
      expect(payload).not.toContain("(Group=0)");
    });

    h.teardown();
  });

  it("fires a new burst for a distinct seq within the dedup window", async () => {
    const h = await setupHarness({ burstCount: 2, dedupWindowMs: 1_000 });
    await sendAnnouncement(h, makeAnnouncement(0x01));
    await sendAnnouncement(h, makeAnnouncement(0x02));
    await waitForReceived(h, 4);

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
    await waitForReceived(h, 1);
    await settle(80); // wait past the dedup window
    await sendAnnouncement(h, makeAnnouncement(0x05));
    await waitForReceived(h, 2);

    // Both announcements fired: 2 bursts × 1 packet = 2 total.
    expect(h.received).toHaveLength(2);
    h.received.forEach((p) => expect(p[11]).toBe(0x05));

    h.teardown();
  });

  it("stop() cancels pending burst timers before they fire", async () => {
    // Long enough that stop() interrupts even if the poll below is slow to
    // see the first packet.
    const h = await setupHarness({ burstIntervalMs: 400 });
    await sendAnnouncement(h, makeAnnouncement(0x01));
    // Let the first burst packet arrive (i=0 fires at t+0)...
    await waitUntil(() => expect(h.received.length).toBeGreaterThanOrEqual(1));
    h.responder.stop();
    // ...and wait past when the 2nd and 3rd would have fired
    await settle(900);

    expect(h.received).toHaveLength(1);

    h.listener.close();
    h.announcer.close();
  });
});
