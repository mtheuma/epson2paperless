import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extract,
  buildTsharkArgs,
  __test__createImageChunkFolder as createImageChunkFolder,
} from "./extract.js";

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

  it("excludes regular, fast, and spurious TCP retransmits so duplicate segments don't leak into the JSONL", () => {
    // Wireshark exposes the three retransmit labels as separate boolean
    // fields — a fast or spurious retransmit isn't guaranteed to also be
    // tagged with the generic `tcp.analysis.retransmission` flag, so all
    // three need explicit clauses for the filter to actually drop them.
    const filter = filterFor({
      pcapPath: "x.pcap",
      hostIp: "192.168.1.1",
      printerIp: "192.168.1.2",
      scanPort: 1865,
    });
    expect(filter).toContain("!tcp.analysis.retransmission");
    expect(filter).toContain("!tcp.analysis.fast_retransmission");
    expect(filter).toContain("!tcp.analysis.spurious_retransmission");
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
        "!tcp.analysis.retransmission && " +
        "!tcp.analysis.fast_retransmission && " +
        "!tcp.analysis.spurious_retransmission && " +
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
    expect(filter).toContain("!tcp.analysis.retransmission");
    expect(filter).toContain("!tcp.analysis.fast_retransmission");
    expect(filter).toContain("!tcp.analysis.spurious_retransmission");
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
