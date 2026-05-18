import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract, buildTsharkArgs } from "./extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  it("excludes TCP retransmits so duplicate segments don't leak into the JSONL", () => {
    const filter = filterFor({
      pcapPath: "x.pcap",
      hostIp: "192.168.1.1",
      printerIp: "192.168.1.2",
      scanPort: 1865,
    });
    expect(filter).toContain("!tcp.analysis.retransmission");
  });

  it("emits the full canonical filter without a tcp.stream constraint when tcpStream is omitted", () => {
    const filter = filterFor({
      pcapPath: "x.pcap",
      hostIp: "192.168.1.1",
      printerIp: "192.168.1.2",
      scanPort: 1865,
    });
    expect(filter).toBe(
      "tcp.port==1865 && tcp.len>0 && !tcp.analysis.retransmission && " +
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
  });
});
