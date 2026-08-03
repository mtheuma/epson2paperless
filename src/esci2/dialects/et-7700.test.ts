import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET7700_FP = "72319314b621fea0aab6cc16f4fd891534cec08f33ce80116a849f6f6e1e58d4";
const entry = REGISTRY.get(ET7700_FP)!;

// The registry entry's static fields are asserted in registry.test.ts alongside
// the other dialects. This file covers only what's specific to the ET-7700's
// composed PARA. The ET-7700 is an A4 EcoTank Photo (flatbed-only, ESC/I-2 over
// plain TCP), speculative from the issue #145 diagnostic and shaped like the
// ET-8500: et4950-stock gamma + et4800-um08 CMX + the optional #QITOFF segment,
// so its flatbed PARA matches the ET-8500's 944 bytes.

describe("ET-7700 composed PARA size", () => {
  it("flatbed is 944 bytes (ET-4800's 936 + 8 for the #QITOFF segment)", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(944);
  });
});

describe("ET-7700 action invariance", () => {
  it("flatbed JPG equals flatbed PDF byte-for-byte", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });
});
