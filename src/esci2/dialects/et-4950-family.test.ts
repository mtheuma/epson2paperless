import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";
const entry = REGISTRY.get(ET4950_FP)!;

describe("ET-4950 registry entry", () => {
  it("supports flatbed + ADF", () => {
    expect(entry.adfExtents).not.toBeNull();
  });
  it("uses stat-length source detection", () => {
    expect(entry.sourceDetection).toBe("stat-length");
  });
  it("uses 3 init-poll iterations", () => {
    expect(entry.initPollIterations).toBe(3);
  });
});

describe("ET-4950 composed PARA size", () => {
  it("flatbed is 928 bytes", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(928);
  });
  it("adf-simplex is 936 bytes", () => {
    expect(composePara(makeParaSpec(entry, "adf-simplex", "jpg")).length).toBe(936);
  });
  it("adf-duplex is 940 bytes", () => {
    expect(composePara(makeParaSpec(entry, "adf-duplex", "jpg")).length).toBe(940);
  });
});
