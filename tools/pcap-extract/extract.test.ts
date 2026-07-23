import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extract,
  buildTsharkArgs,
  reassembleSession,
  assertSingleConversation,
  __test__createImageChunkFolder as createImageChunkFolder,
} from "./extract.js";
import type { RawPacket } from "./extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isFrame(type: number, payloadBytes: number, fill = 0xb0): Buffer {
  const h = Buffer.alloc(12);
  h[0] = 0x49;
  h[1] = 0x53;
  h.writeUInt16BE(type, 2);
  h.writeUInt16BE(0x300c, 4);
  h.writeUInt32BE(payloadBytes, 6);
  return Buffer.concat([h, Buffer.alloc(payloadBytes, fill)]);
}

function tsharkAvailable(): boolean {
  const bin = process.env.TSHARK_PATH ?? "tshark";
  try {
    const res = spawnSync(bin, ["-v"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

const SKIP = !tsharkAvailable();

describe("pcap-extract", () => {
  it.skipIf(SKIP)("emits at least one host->printer record from the test fixture", async () => {
    const events = await extract({
      pcapPath: path.join(__dirname, "test-fixtures", "tiny.pcap"),
      hostIp: "192.168.188.140",
      printerIp: "192.168.188.54",
      scanPort: 1865,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.dir === "h>p")).toBe(true);
  });
});

describe("buildTsharkArgs display filter", () => {
  function filterFor(opts: Parameters<typeof buildTsharkArgs>[0]): string {
    const args = buildTsharkArgs(opts);
    const idx = args.indexOf("-Y");
    expect(idx).toBeGreaterThanOrEqual(0);
    return args[idx + 1];
  }

  it("does NOT exclude retransmission-flagged frames — on lossy captures a flagged frame can be the only copy of a byte range", () => {
    // Deduplication happens seq-aware in reassembleSession instead; a
    // display-filter exclusion silently drops necessary retransmits on
    // captures with real packet loss (Wi-Fi captures like XP-620's).
    const filter = filterFor({
      pcapPath: "x.pcap",
      hostIp: "192.168.1.1",
      printerIp: "192.168.1.2",
      scanPort: 1865,
    });
    expect(filter).not.toContain("tcp.analysis");
  });

  it("emits the full canonical filter without a tcp.stream constraint when tcpStream is omitted", () => {
    const filter = filterFor({
      pcapPath: "x.pcap",
      hostIp: "192.168.1.1",
      printerIp: "192.168.1.2",
      scanPort: 1865,
    });
    expect(filter).toBe(
      "tcp.port==1865 && tcp.len>0 && " +
        "((ip.src==192.168.1.1 && ip.dst==192.168.1.2) || " +
        "(ip.src==192.168.1.2 && ip.dst==192.168.1.1))",
    );
  });

  it("appends `&& tcp.stream==N` when tcpStream is provided", () => {
    const filter = filterFor({
      pcapPath: "x.pcap",
      hostIp: "192.168.1.1",
      printerIp: "192.168.1.2",
      scanPort: 1865,
      tcpStream: 3,
    });
    expect(filter.endsWith("&& tcp.stream==3")).toBe(true);
  });

  it("extracts tcp.stream and tcp.seq so reassembly can detect conversations and order segments", () => {
    const args = buildTsharkArgs({
      pcapPath: "x.pcap",
      hostIp: "192.168.1.1",
      printerIp: "192.168.1.2",
      scanPort: 1865,
    });
    const fields = args.filter((_, i) => args[i - 1] === "-e");
    expect(fields).toEqual([
      "frame.time_relative",
      "ip.src",
      "tcp.stream",
      "tcp.seq",
      "tcp.payload",
    ]);
  });

  it("pins relative sequence numbers so a user profile with them disabled can't break the seq sort", () => {
    const args = buildTsharkArgs({
      pcapPath: "x.pcap",
      hostIp: "192.168.1.1",
      printerIp: "192.168.1.2",
      scanPort: 1865,
    });
    const prefs = args.filter((_, i) => args[i - 1] === "-o");
    expect(prefs).toContain("tcp.relative_sequence_numbers:TRUE");
  });
});

describe("assertSingleConversation", () => {
  it("throws a --stream hint naming the conversations when the capture holds more than one", () => {
    expect(() => assertSingleConversation(new Set([9, 10]), 1865)).toThrow(
      /2 TCP conversations.*9, 10.*--stream/s,
    );
  });

  it("accepts a single conversation", () => {
    expect(() => assertSingleConversation(new Set([10]), 1865)).not.toThrow();
  });
});

describe("reassembleSession", () => {
  const pkt = (dir: "h>p" | "p>h", ts: number, seq: number, hex: string): RawPacket => ({
    dir,
    ts,
    seq,
    payload: Buffer.from(hex, "hex"),
  });

  it("drops a pure duplicate retransmission", () => {
    const events = reassembleSession([
      pkt("p>h", 0.0, 1, "aabbccdd"),
      pkt("p>h", 0.5, 1, "aabbccdd"), // retransmit of already-captured bytes
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].payload.toString("hex")).toBe("aabbccdd");
    expect(events[0].ts).toBe(0.0);
  });

  it("keeps a retransmitted segment that is the only captured copy of its byte range", () => {
    // Original copy of seq 5..8 was lost before the capture point; the
    // retransmit arrives AFTER the following segment. Seq order must win
    // over capture order.
    const events = reassembleSession([
      pkt("p>h", 0.0, 1, "00010203"),
      pkt("p>h", 0.2, 9, "08090a0b"),
      pkt("p>h", 0.5, 5, "04050607"), // gap-filling retransmit, captured late
    ]);
    expect(events.map((e) => e.payload.toString("hex"))).toEqual([
      "00010203",
      "04050607",
      "08090a0b",
    ]);
  });

  it("trims a partial-overlap frame to just its new tail bytes", () => {
    // TCP coalesced a resend with newly-available data: same seq, longer
    // frame. The overlapping prefix is already accepted; only the tail is new.
    const first = "000102030405060708090a0b0c0d0e0f10111213"; // seq 100, 20 bytes
    const second = first + "beef"; // seq 100, 22 bytes — 2 new trailing bytes
    const events = reassembleSession([pkt("p>h", 0.0, 100, first), pkt("p>h", 0.1, 100, second)]);
    expect(events.map((e) => e.payload.toString("hex"))).toEqual([first, "beef"]);
    expect(events[1].ts).toBe(0.1);
  });

  it("throws on a gap no captured frame fills", () => {
    expect(() =>
      reassembleSession([pkt("p>h", 0.0, 1, "00010203"), pkt("p>h", 0.2, 9, "08090a0b")]),
    ).toThrow(/p>h.*gap/);
  });

  it("merges directions with a stable two-pointer merge, never reordering a direction by timestamp", () => {
    // p>h timestamps are not monotonic in seq order on real lossy captures
    // (capture-side jitter). A combined ts sort would emit seq 5 before
    // seq 1 here; the merge must preserve each direction's seq order.
    const events = reassembleSession([
      pkt("p>h", 1.0, 1, "aabbccdd"),
      pkt("p>h", 0.9, 5, "eeff0011"), // later seq, earlier ts
      pkt("h>p", 0.95, 1, "1b40"),
    ]);
    expect(events.map((e) => `${e.dir}:${e.payload.toString("hex")}`)).toEqual([
      "h>p:1b40",
      "p>h:aabbccdd",
      "p>h:eeff0011",
    ]);
  });
});

describe("createImageChunkFolder", () => {
  it("folds a split-header image run and emits control frames, using chunkCount", () => {
    const folder = createImageChunkFolder();
    const img = isFrame(0xa200, 253063).toString("hex");
    folder.feed({ dir: "p>h", ts: 0, hex: img.slice(0, 12) });
    folder.feed({ dir: "p>h", ts: 0, hex: img.slice(12) });
    folder.feed({ dir: "p>h", ts: 1, hex: isFrame(0xa000, 1, 0x06).toString("hex") }); // ACK ends the run
    const out = folder.finish();
    expect(out[0]).toMatchObject({
      summary: "image-stream",
      totalBytes: 253063,
      chunkCount: 1,
      chunkSize: 253063,
    });
    expect(out[1]).toMatchObject({ dir: "p>h", hex: expect.stringContaining("4953a000") });
  });
});
