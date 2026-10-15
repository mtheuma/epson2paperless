import { describe, it, expect } from "vitest";
import { checkLegacyIdentity, resolveLegacyEntry } from "./registry.js";
import { WF3620_ENTRY } from "./wf3620.js";
import { XP620_ENTRY } from "./xp620.js";
import { ET2550_ENTRY } from "./et2550.js";

describe("resolveLegacyEntry", () => {
  it("maps PID 08B8 to the WF-3620 entry", () => {
    expect(resolveLegacyEntry("PID 08B8").name).toBe("wf3620");
  });
  it("maps PID 08C8 to the XP-620 entry", () => {
    expect(resolveLegacyEntry("PID 08C8").name).toBe("xp620");
  });
  it("maps PID 1106 to the ET-2550 entry", () => {
    expect(resolveLegacyEntry("PID 1106").name).toBe("et2550");
  });
  it("falls back to WF-3620 for unknown or null PID", () => {
    expect(resolveLegacyEntry("PID 9999").name).toBe("wf3620");
    expect(resolveLegacyEntry(null).name).toBe("wf3620");
  });
});

describe("checkLegacyIdentity", () => {
  it("matches a dialect's own PID", () => {
    expect(checkLegacyIdentity(WF3620_ENTRY, "PID 08B8")).toEqual({ kind: "match" });
    expect(checkLegacyIdentity(XP620_ENTRY, "PID 08C8")).toEqual({ kind: "match" });
  });
  it("calls an unclaimed product on the WF-3620 fallback unrecognised", () => {
    expect(checkLegacyIdentity(WF3620_ENTRY, "PID 9999")).toEqual({ kind: "unrecognised" });
    expect(checkLegacyIdentity(WF3620_ENTRY, null)).toEqual({ kind: "unrecognised" });
  });
  it("switches to the owning dialect when its setup matches the running one", () => {
    // ET-2550 and WF-3620 both open with ESC @, so the wire up to FS I is identical.
    expect(checkLegacyIdentity(WF3620_ENTRY, "PID 1106")).toEqual({
      kind: "switch",
      owner: ET2550_ENTRY,
    });
    expect(checkLegacyIdentity(ET2550_ENTRY, "PID 08B8")).toEqual({
      kind: "switch",
      owner: WF3620_ENTRY,
    });
  });
  it("names the owning dialect without switching when its setup diverged before FS I", () => {
    // XP-620 opens with ESC I, the others with ESC @.
    expect(checkLegacyIdentity(WF3620_ENTRY, "PID 08C8")).toEqual({
      kind: "mismatch",
      owner: XP620_ENTRY,
    });
    expect(checkLegacyIdentity(XP620_ENTRY, "PID 1106")).toEqual({
      kind: "mismatch",
      owner: ET2550_ENTRY,
    });
  });
  it("flags a PID-keyed dialect the printer doesn't name, with no owner", () => {
    expect(checkLegacyIdentity(XP620_ENTRY, "PID 9999")).toEqual({ kind: "mismatch", owner: null });
  });
});
