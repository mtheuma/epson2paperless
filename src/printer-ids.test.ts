import { describe, it, expect } from "vitest";
import { extractPid, PID_ET7700, PID_FF680W, PID_DS575W } from "./printer-ids.js";

describe("extractPid", () => {
  it("returns canonical spellings unchanged", () => {
    for (const pid of [PID_ET7700, PID_FF680W, PID_DS575W, "PID 11D1", "PID 08C8"]) {
      expect(extractPid(pid)).toBe(pid);
    }
  });

  it("canonicalises prefix casing, hex casing, and spacing variance", () => {
    expect(extractPid("pid 112b")).toBe("PID 112B");
    expect(extractPid("Pid 112B")).toBe("PID 112B");
    expect(extractPid("  PID 112b  ")).toBe("PID 112B");
    expect(extractPid("PID  112B")).toBe("PID 112B");
    expect(extractPid("PID112B")).toBe("PID 112B");
  });

  it("extracts the token from the latin1-decoded announcement shape", () => {
    // In the real beacon the token sits between a length byte and a NUL
    // ("\x08PID 11D1\0" — see keepalive.test.ts's capture fixture).
    expect(extractPid("service:NetScanMonitor-agent\0\x08PID 11D1\0")).toBe("PID 11D1");
  });

  it("rejects PID-shaped substrings inside longer tokens", () => {
    // No alphanumeric may touch either end of the token: "RAPID 112B" must
    // not read as the ET-7700, and a 5-hex run is not a 4-hex PID.
    expect(extractPid("RAPID 112B")).toBeNull();
    expect(extractPid("PID 112B7")).toBeNull();
    expect(extractPid("PID 112")).toBeNull();
  });

  it("returns null when no PID token is present", () => {
    expect(extractPid("ET-7700 Series")).toBeNull();
    expect(extractPid("")).toBeNull();
    expect(extractPid(null)).toBeNull();
    expect(extractPid(undefined)).toBeNull();
  });
});
