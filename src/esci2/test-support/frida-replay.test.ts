import { describe, it, expect } from "vitest";
import { trimStatCycles } from "./frida-replay.js";
import type { CaptureRecord } from "./frida-replay.js";

describe("trimStatCycles", () => {
  it("keeps LOCK + cycles 1+2, trims the STAT loop, and resumes at FS X", () => {
    // Build a minimal capture: 15 pre-STAT sends (LOCK + 6 cycle-1 + 8 cycle-2),
    // 5 STAT cycles (45 records), then an FS X send, then a post-FS-X send.
    const pre = Array.from({ length: 15 }, (_, i) => ({
      hook: "send" as const,
      payload_hex: `aa${i.toString(16).padStart(2, "0")}`,
    }));
    const oneStatCycle: CaptureRecord[] = [
      { hook: "send", payload_hex: "bb01" },
      { hook: "recv" },
      { hook: "recv" },
      { hook: "send", payload_hex: "bb02" },
      { hook: "recv" },
      { hook: "recv" },
      { hook: "send", payload_hex: "bb03" },
      { hook: "recv" },
      { hook: "recv" },
    ];
    const statLoop = Array.from({ length: 5 }, () => oneStatCycle).flat();
    const fsX: CaptureRecord = {
      hook: "send",
      payload_hex: "49532000000c0000000a000000000002000000011c58",
    };
    const post: CaptureRecord = { hook: "send", payload_hex: "ffff" };
    const all: CaptureRecord[] = [...pre, ...statLoop, fsX, post];

    const trimmed = trimStatCycles(all, 3);

    // 15 pre + (3 × 9) STAT + 2 post (FS X + post) = 44 records
    expect(trimmed.length).toBe(15 + 27 + 2);
    expect(trimmed[15 + 27].payload_hex).toBe(fsX.payload_hex);
    expect(trimmed[15 + 27 + 1].payload_hex).toBe("ffff");
  });

  it("throws if capture has fewer than 16 sends", () => {
    const tooShort: CaptureRecord[] = Array.from({ length: 10 }, () => ({
      hook: "send",
      payload_hex: "aa",
    }));
    expect(() => trimStatCycles(tooShort, 3)).toThrow(/expected ≥ 16/);
  });

  it("throws if no FS X send is present", () => {
    const noFsX: CaptureRecord[] = Array.from({ length: 20 }, () => ({
      hook: "send",
      payload_hex: "aa",
    }));
    expect(() => trimStatCycles(noFsX, 3)).toThrow(/no FS X send/);
  });
});
