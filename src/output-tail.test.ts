import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./paperless-upload.js", () => ({
  uploadAllToPaperless: vi.fn(() => Promise.resolve()),
}));

// Wrap (not replace) the real implementation so every existing test's file-
// system behaviour is unchanged (postProcess defaults to "none", which the
// real postProcessTempPages already no-ops on) while letting the new test
// below assert on the jpegQuality it was actually called with.
vi.mock("./postprocess/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./postprocess/index.js")>();
  return { ...actual, postProcessTempPages: vi.fn(actual.postProcessTempPages) };
});

import { finalizeSession } from "./output-tail.js";
import { uploadAllToPaperless, type PaperlessUploadOptions } from "./paperless-upload.js";
import { postProcessTempPages } from "./postprocess/index.js";
import { DEFAULT_JPEG_QUALITY } from "./config.js";

const postProcessMock = vi.mocked(postProcessTempPages);

const SAMPLE_JPEG_PATH = "test-fixtures/sample-page.jpg";

const PAPERLESS_OPTS: PaperlessUploadOptions = {
  url: "http://paperless.test",
  token: "test-token",
  deleteAfterUpload: true,
};

const uploadMock = vi.mocked(uploadAllToPaperless);

describe("output-tail", () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "out-tail-tmp-"));
    outputDir = mkdtempSync(path.join(os.tmpdir(), "out-tail-out-"));
    uploadMock.mockReset().mockResolvedValue(undefined);
    postProcessMock.mockClear();
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

  it("uploads JPG outputs to Paperless when paperless options are configured", async () => {
    const fakeJpeg = Buffer.from("ffd8ffe000104a464946", "hex");
    writeFileSync(path.join(tempDir, "page_001.jpg"), fakeJpeg);
    writeFileSync(path.join(tempDir, "page_002.jpg"), fakeJpeg);

    await finalizeSession({
      sessionTempDir: tempDir,
      outputDir,
      sessionTs: new Date("2026-03-03T03:03:03Z"),
      action: "jpg",
      backPageIndices: [],
      paperless: PAPERLESS_OPTS,
    });

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [paths, opts] = uploadMock.mock.calls[0];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/scan_2026-03-03_030303_01\.jpg$/);
    expect(paths[1]).toMatch(/scan_2026-03-03_030303_02\.jpg$/);
    expect(opts).toBe(PAPERLESS_OPTS);
  });

  it("uploads composed PDF to Paperless when paperless options are configured", async () => {
    const sampleJpeg = readFileSync(SAMPLE_JPEG_PATH);
    writeFileSync(path.join(tempDir, "page_001.jpg"), sampleJpeg);

    await finalizeSession({
      sessionTempDir: tempDir,
      outputDir,
      sessionTs: new Date("2026-04-04T04:04:04Z"),
      action: "pdf",
      backPageIndices: [],
      paperless: PAPERLESS_OPTS,
    });

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [paths] = uploadMock.mock.calls[0];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/scan_2026-04-04_040404\.pdf$/);
  });

  it("does NOT call paperless upload when paperless options are undefined", async () => {
    const fakeJpeg = Buffer.from("ffd8ffe000104a464946", "hex");
    writeFileSync(path.join(tempDir, "page_001.jpg"), fakeJpeg);

    await finalizeSession({
      sessionTempDir: tempDir,
      outputDir,
      sessionTs: new Date("2026-05-05T05:05:05Z"),
      action: "jpg",
      backPageIndices: [],
      paperless: undefined,
    });

    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("falls back to JPG promote when PDF composition fails (and uploads the JPGs)", async () => {
    // Write a 4-byte non-JPEG "ffd8ffd9" — pdf-lib's embedJpg will reject
    // it because there's no SOF segment. The output-tail catch should kick
    // in and run the JPG fallback path.
    const garbage = Buffer.from("ffd8ffd9", "hex");
    writeFileSync(path.join(tempDir, "page_001.jpg"), garbage);

    await finalizeSession({
      sessionTempDir: tempDir,
      outputDir,
      sessionTs: new Date("2026-06-06T06:06:06Z"),
      action: "pdf",
      backPageIndices: [],
      paperless: PAPERLESS_OPTS,
    });

    // No PDF was produced — the fallback wrote a JPG.
    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scan_2026-06-06_060606\.jpg$/);
    expect(readFileSync(path.join(outputDir, files[0]))).toEqual(garbage);

    // Paperless upload sees the JPG fallback path, not a PDF.
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [paths] = uploadMock.mock.calls[0];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/\.jpg$/);
  });

  it("preserves the local scan when uploadAllToPaperless rejects (defense-in-depth)", async () => {
    // Pin the contract: a thrown rejection from uploadAllToPaperless must
    // not turn a completed local scan into a failed scan from the
    // dispatcher's perspective. one-shot.ts maps any rejection from the
    // scan promise to exit code 1; without the catch around this await,
    // a future refactor that lets uploadAllToPaperless throw would
    // silently break user-facing semantics.
    uploadMock.mockRejectedValueOnce(new Error("network blip"));

    const fakeJpeg = Buffer.from("ffd8ffe000104a464946", "hex");
    writeFileSync(path.join(tempDir, "page_001.jpg"), fakeJpeg);

    await expect(
      finalizeSession({
        sessionTempDir: tempDir,
        outputDir,
        sessionTs: new Date("2026-07-07T07:07:07Z"),
        action: "jpg",
        backPageIndices: [],
        paperless: PAPERLESS_OPTS,
      }),
    ).resolves.toBeUndefined();

    // Local file is still on disk, exactly as written.
    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scan_2026-07-07_070707\.jpg$/);
    expect(readFileSync(path.join(outputDir, files[0]))).toEqual(fakeJpeg);

    // Temp dir was still cleaned up (the finally block ran).
    expect(() => readdirSync(tempDir)).toThrow(/ENOENT/);
  });

  it("falls back to DEFAULT_JPEG_QUALITY when jpegQuality is omitted", async () => {
    const fakeJpeg = Buffer.from("ffd8ffe000104a464946", "hex");
    writeFileSync(path.join(tempDir, "page_001.jpg"), fakeJpeg);

    await finalizeSession({
      sessionTempDir: tempDir,
      outputDir,
      sessionTs: new Date("2026-08-08T08:08:08Z"),
      action: "jpg",
      backPageIndices: [],
      paperless: undefined,
      // jpegQuality intentionally omitted
    });

    expect(postProcessMock).toHaveBeenCalledWith(
      tempDir,
      "none",
      { jpegQuality: DEFAULT_JPEG_QUALITY },
      expect.anything(),
    );
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
