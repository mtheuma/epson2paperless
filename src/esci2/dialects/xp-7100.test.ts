import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { xp7100Dialect } from "./xp-7100.js";

const FIXTURE_DIR = path.resolve("src/esci2/dialects/xp-7100-fixtures");

function loadFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

// Byte offsets of the LUT triplet and CMX header markers inside each PARA
// body. Verified against the extracted .bin fixtures during analysis.
// Payload offsets = marker offset + 12 (skip the 12-byte ASCII header).
//
//   #GMTxxx h100<256-byte LUT>     ← 12-byte header + 256-byte payload
//   #CMXUM08h009<12-byte payload>  ← 12-byte header + 12-byte payload
//
// Flatbed and ADF simplex share the same marker offsets — the 8-byte size
// delta (944 → 952) comes from the #PAGd000 token inserted AFTER the LUTs.
// ADF duplex inserts DPLX (4 bytes) into the source token at offset 0,
// shifting everything by +4.
const LUT_REGION_OFFSETS = {
  flatbed: { grn: 60, red: 328, blu: 596, cmx: 864 }, // 944 B body
  adfSimplex: { grn: 60, red: 328, blu: 596, cmx: 864 }, // 952 B body — same markers as flatbed
  adfDuplex: { grn: 64, red: 332, blu: 600, cmx: 868 }, // 956 B body — shifted +4 by DPLX
};

describe("xp7100Dialect", () => {
  it("has hardware {flatbed, adf, duplex} all true", () => {
    expect(xp7100Dialect.hardware).toEqual({ flatbed: true, adf: true, duplex: true });
  });

  it("uses stat-length source detection (has ADF, needs detection)", () => {
    expect(xp7100Dialect.sourceDetection).toBe("stat-length");
  });

  it("uses 3 init-poll iterations", () => {
    expect(xp7100Dialect.initPollIterations).toBe(3);
  });

  describe("captured-axis byte equality", () => {
    it("flatbed JPG matches jpg-flatbed.bin", () => {
      const out = xp7100Dialect.buildPara({ source: "flatbed", duplex: false, action: "jpg" });
      expect(out.equals(loadFixture("jpg-flatbed.bin"))).toBe(true);
    });
    it("ADF simplex JPG matches jpg-single.bin", () => {
      const out = xp7100Dialect.buildPara({ source: "adf", duplex: false, action: "jpg" });
      expect(out.equals(loadFixture("jpg-single.bin"))).toBe(true);
    });
    it("ADF simplex PDF matches pdf-single.bin", () => {
      const out = xp7100Dialect.buildPara({ source: "adf", duplex: false, action: "pdf" });
      expect(out.equals(loadFixture("pdf-single.bin"))).toBe(true);
    });
    it("ADF duplex JPG matches jpg-duplex.bin", () => {
      const out = xp7100Dialect.buildPara({ source: "adf", duplex: true, action: "jpg" });
      expect(out.equals(loadFixture("jpg-duplex.bin"))).toBe(true);
    });
    it("ADF duplex PDF matches pdf-duplex.bin", () => {
      const out = xp7100Dialect.buildPara({ source: "adf", duplex: true, action: "pdf" });
      expect(out.equals(loadFixture("pdf-duplex.bin"))).toBe(true);
    });
  });

  it("flatbed PDF is synthesised independently from captured fixtures", () => {
    const flatbedJpg = loadFixture("jpg-flatbed.bin");
    const pdfSrcBody = loadFixture("pdf-single.bin");

    const adfOff = LUT_REGION_OFFSETS.adfSimplex;
    const fbOff = LUT_REGION_OFFSETS.flatbed;
    const pdfGrnLut = pdfSrcBody.subarray(adfOff.grn + 12, adfOff.grn + 12 + 256);
    const pdfRedLut = pdfSrcBody.subarray(adfOff.red + 12, adfOff.red + 12 + 256);
    const pdfBluLut = pdfSrcBody.subarray(adfOff.blu + 12, adfOff.blu + 12 + 256);
    const pdfCmx = pdfSrcBody.subarray(adfOff.cmx + 12, adfOff.cmx + 12 + 12);

    const expected = Buffer.from(flatbedJpg);
    pdfGrnLut.copy(expected, fbOff.grn + 12);
    pdfRedLut.copy(expected, fbOff.red + 12);
    pdfBluLut.copy(expected, fbOff.blu + 12);
    pdfCmx.copy(expected, fbOff.cmx + 12);

    const out = xp7100Dialect.buildPara({ source: "flatbed", duplex: false, action: "pdf" });
    expect(out.equals(expected)).toBe(true);
  });
});
