import { describe, it, expect } from "vitest";
import { resolveLegacyEntry } from "./registry.js";

describe("resolveLegacyEntry", () => {
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
