import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BaselineSchema, loadBaseline, saveBaseline, type Baseline } from "./baseline.js";

const sample: Baseline = {
  approvedAt: "2026-06-05",
  note: "ET-4956 flatbed reference",
  replay: {
    fixturePath: "tools/frida-capture/captures/x.jsonl",
    source: "flatbed",
    duplex: false,
    trimStatCycles: 3,
    printerIp: "192.0.2.58",
    destId: 2,
  },
  page: { width: 1191, height: 1684 },
  crosshairResidualPx: 1.2,
  swatches: [{ label: "FF0000", rgb: [200, 30, 25] }],
  greySpreads: [{ label: "C0C0C0", spread: 4 }],
  stripeVarianceMax: 12,
  expectedBackPages: [],
  tolerances: { swatchDeltaE: 4, crosshairPx: 6, greySpread: 10, stripeVariance: 25 },
};

describe("baseline", () => {
  it("accepts a well-formed baseline", () => {
    expect(() => BaselineSchema.parse(sample)).not.toThrow();
  });

  it("rejects a baseline missing the replay block", () => {
    const bad = { ...sample } as Record<string, unknown>;
    delete bad.replay;
    expect(() => BaselineSchema.parse(bad)).toThrow();
  });

  it("round-trips through save/load", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "baseline-test-"));
    try {
      const p = path.join(dir, "x.baseline.json");
      saveBaseline(p, sample);
      expect(loadBaseline(p)).toEqual(sample);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
