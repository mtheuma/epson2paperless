import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildBaselineFromOutputDir } from "./baseline-cli.js";
import { buildTestPageRaster } from "../../src/test-oracle/test-support/raster-draw.js";

describe("buildBaselineFromOutputDir", () => {
  it("measures the lone JPG in an output dir and produces a baseline + overlay", async () => {
    const { raster } = buildTestPageRaster({ scale: 2 });
    const jpeg = await sharp(raster.data, {
      raw: { width: raster.width, height: raster.height, channels: 3 },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    const dir = mkdtempSync(path.join(os.tmpdir(), "oracle-cli-"));
    try {
      writeFileSync(path.join(dir, "scan_2026-06-05_000000.jpg"), jpeg);
      const { baseline, overlayPng } = await buildBaselineFromOutputDir(dir, {
        fixturePath: "x.jsonl",
        source: "flatbed",
        duplex: false,
        trimStatCycles: 3,
        printerIp: "192.0.2.58",
        destId: 2,
        approvedAt: "2026-06-05",
      });
      expect(baseline.swatches).toHaveLength(12);
      expect(baseline.swatches.find((s) => s.label === "FF0000")?.rgb[0]).toBeGreaterThan(200);
      expect((await sharp(overlayPng).metadata()).format).toBe("png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
