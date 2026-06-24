import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET8500_FP = "05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467";
const entry = REGISTRY.get(ET8500_FP)!;

// The registry entry's static fields are asserted in registry.test.ts alongside
// the other dialects. This file covers only what's specific to the ET-8500's
// composed PARA. The ET-8500 is an A4 EcoTank Photo (flatbed-only, ESC/I-2 over
// both TLS and plain TCP across reporters). It pairs the TLS-sibling
// et4950-stock gamma with the ET-4800's
// et4800-um08 CMX, and (unlike the ET-4800) carries the optional #QITOFF
// segment — every gamma triplet is 804 bytes, so its flatbed PARA is still the
// ET-4800's 936 bytes plus 8 for #QITOFF (944 total).

describe("ET-8500 composed PARA size", () => {
  it("flatbed is 944 bytes (ET-4800's 936 + 8 for the #QITOFF segment)", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(944);
  });
});

describe("ET-8500 action invariance", () => {
  it("flatbed JPG equals flatbed PDF byte-for-byte", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });
});
