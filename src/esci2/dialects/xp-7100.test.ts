import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const XP7100_FP = "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e";
const entry = REGISTRY.get(XP7100_FP)!;

const FIXTURE_DIR = path.resolve("src/esci2/dialects/xp-7100-fixtures");
function loadFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

describe("XP-7100 registry entry", () => {
  it("supports flatbed + ADF + duplex (has adfExtents)", () => {
    expect(entry.adfExtents).not.toBeNull();
  });
  it("uses stat-length source detection", () => {
    expect(entry.sourceDetection).toBe("stat-length");
  });
  it("uses 3 init-poll iterations", () => {
    expect(entry.initPollIterations).toBe(3);
  });
  it("uses per-action gamma + CMX classes (action-aware)", () => {
    expect(entry.gammaClass.jpg).not.toBe(entry.gammaClass.pdf);
    expect(entry.cmxClass.jpg).not.toBe(entry.cmxClass.pdf);
  });
});

describe("XP-7100 captured-axis byte equality (the only coverage of PDF wire bytes)", () => {
  it("flatbed JPG matches jpg-flatbed.bin", () => {
    const out = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    expect(out.equals(loadFixture("jpg-flatbed.bin"))).toBe(true);
  });
  it("ADF simplex JPG matches jpg-single.bin", () => {
    const out = composePara(makeParaSpec(entry, "adf-simplex", "jpg"));
    expect(out.equals(loadFixture("jpg-single.bin"))).toBe(true);
  });
  it("ADF simplex PDF matches pdf-single.bin", () => {
    const out = composePara(makeParaSpec(entry, "adf-simplex", "pdf"));
    expect(out.equals(loadFixture("pdf-single.bin"))).toBe(true);
  });
  it("ADF duplex JPG matches jpg-duplex.bin", () => {
    const out = composePara(makeParaSpec(entry, "adf-duplex", "jpg"));
    expect(out.equals(loadFixture("jpg-duplex.bin"))).toBe(true);
  });
  it("ADF duplex PDF matches pdf-duplex.bin", () => {
    const out = composePara(makeParaSpec(entry, "adf-duplex", "pdf"));
    expect(out.equals(loadFixture("pdf-duplex.bin"))).toBe(true);
  });
});

describe("XP-7100 flatbed PDF (no captured fixture — synthesised by composer)", () => {
  // Today's xp-7100.test.ts:65-84 synthesises the expected bytes by splicing
  // PDF LUTs from pdf-single.bin into a copy of jpg-flatbed.bin. The composer
  // achieves the same result via gammaClass.pdf="xp7100-pdf" + cmxClass.pdf=
  // "xp7100-pdf" applied to the flatbed source. Replicate the synthesis as
  // the expected-bytes oracle and assert byte equality.
  const LUT_OFFSETS = {
    flatbed: { grn: 60, red: 328, blu: 596, cmx: 864 },
    adfSimplex: { grn: 60, red: 328, blu: 596, cmx: 864 },
  };

  it("composed flatbed-PDF equals the JPG-flatbed body with PDF LUT triplet + CMX spliced in", () => {
    const flatbedJpg = loadFixture("jpg-flatbed.bin");
    const pdfSrc = loadFixture("pdf-single.bin");
    const fb = LUT_OFFSETS.flatbed;
    const adf = LUT_OFFSETS.adfSimplex;
    const expected = Buffer.from(flatbedJpg);
    pdfSrc.subarray(adf.grn + 12, adf.grn + 12 + 256).copy(expected, fb.grn + 12);
    pdfSrc.subarray(adf.red + 12, adf.red + 12 + 256).copy(expected, fb.red + 12);
    pdfSrc.subarray(adf.blu + 12, adf.blu + 12 + 256).copy(expected, fb.blu + 12);
    pdfSrc.subarray(adf.cmx + 12, adf.cmx + 12 + 12).copy(expected, fb.cmx + 12);

    const out = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(out.equals(expected)).toBe(true);
  });
});
