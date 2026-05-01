import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { finalizeSession } from "./output-tail.js";

const SAMPLE_JPEG_PATH = "test-fixtures/sample-page.jpg";

describe("output-tail", () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "out-tail-tmp-"));
    outputDir = mkdtempSync(path.join(os.tmpdir(), "out-tail-out-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("promotes a single JPG from temp to output dir", async () => {
    const fakeJpeg = Buffer.from("ffd8ffe000104a464946", "hex");
    writeFileSync(path.join(tempDir, "page_001.jpg"), fakeJpeg);

    const ts = new Date("2026-01-01T00:00:00Z");
    await finalizeSession({
      sessionTempDir: tempDir,
      outputDir,
      sessionTs: ts,
      action: "jpg",
      backPageIndices: [],
      paperless: undefined,
    });

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scan_2026-01-01_000000\.jpg$/);
    expect(readFileSync(path.join(outputDir, files[0]))).toEqual(fakeJpeg);
  });

  it("composes a PDF when action is pdf and a JPG exists", async () => {
    // Use the real sample JPEG so pdf-lib can actually embed it
    const sampleJpeg = readFileSync(SAMPLE_JPEG_PATH);
    writeFileSync(path.join(tempDir, "page_001.jpg"), sampleJpeg);

    const ts = new Date("2026-02-02T02:02:02Z");
    await finalizeSession({
      sessionTempDir: tempDir,
      outputDir,
      sessionTs: ts,
      action: "pdf",
      backPageIndices: [],
      paperless: undefined,
    });

    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scan_2026-02-02_020202\.pdf$/);
  });

  it("removes the temp dir even when promotion fails", async () => {
    // Point outputDir at a plain file so mkdirSync inside writeOutputFile throws
    const blockingFile = path.join(outputDir, "not-a-dir");
    writeFileSync(blockingFile, "blocker");
    const badOutputDir = path.join(blockingFile, "sub"); // file/sub → ENOTDIR

    writeFileSync(path.join(tempDir, "page_001.jpg"), Buffer.from("ffd8ffd9", "hex"));

    await expect(
      finalizeSession({
        sessionTempDir: tempDir,
        outputDir: badOutputDir,
        sessionTs: new Date("2026-01-01T00:00:00Z"),
        action: "jpg",
        backPageIndices: [],
        paperless: undefined,
      }),
    ).rejects.toThrow();

    expect(() => readdirSync(tempDir)).toThrow(/ENOENT/);
  });
});
