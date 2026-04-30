import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "./extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("pcap-extract", () => {
  it("emits at least one host->printer record from the test fixture", async () => {
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
