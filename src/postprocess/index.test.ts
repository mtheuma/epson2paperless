import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { applyPostProcess, postProcessTempPages } from "./index.js";

describe("applyPostProcess", () => {
  it("none returns the exact same buffer bytes", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]);
    const out = await applyPostProcess("none", jpeg, { jpegQuality: 90 });
    expect(out.equals(jpeg)).toBe(true);
  });
});

const noopLog = { info: () => {}, error: () => {} };

async function writePage(dir: string, name: string, rgb: [number, number, number]) {
  const w = 32,
    h = 32,
    buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
  }
  const jpeg = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(path.join(dir, name), jpeg);
}

describe("postProcessTempPages", () => {
  it("none leaves page bytes untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-none-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    const before = fs.readFileSync(path.join(dir, "page_00.jpg"));
    await postProcessTempPages(dir, "none", { jpegQuality: 90 }, noopLog);
    expect(fs.readFileSync(path.join(dir, "page_00.jpg")).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("document rewrites the page toward neutral white and leaves no .tmp", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-doc-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    await postProcessTempPages(dir, "document", { jpegQuality: 90 }, noopLog);
    const { data } = await sharp(path.join(dir, "page_00.jpg"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(250);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fallback: a page that fails to decode is left byte-for-byte intact, no .tmp", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-bad-"));
    const bad = Buffer.from("this is not a jpeg");
    fs.writeFileSync(path.join(dir, "page_00.jpg"), bad);
    // Must resolve (never throw) even though sharp cannot decode the page.
    await expect(
      postProcessTempPages(dir, "document", { jpegQuality: 90 }, noopLog),
    ).resolves.toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "page_00.jpg")).equals(bad)).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a non-existent temp dir resolves (never throws) so a directory-level failure never fails the scan", async () => {
    await expect(
      postProcessTempPages("/no/such/dir/xyz", "document", { jpegQuality: 90 }, noopLog),
    ).resolves.toBeUndefined();
  });

  it("no downsample field → pages byte-identical (pure no-op path preserved)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-nods-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    const before = fs.readFileSync(path.join(dir, "page_00.jpg"));
    await postProcessTempPages(dir, "none", { jpegQuality: 90 }, noopLog);
    expect(fs.readFileSync(path.join(dir, "page_00.jpg")).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs the standalone downsample under profile none (no document/grayscale transform)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ds-none-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    await postProcessTempPages(
      dir,
      "none",
      { jpegQuality: 90, downsample: { fromDpi: 300, toDpi: 150 } },
      noopLog,
    );
    const { info } = await sharp(path.join(dir, "page_00.jpg")).toBuffer({
      resolveWithObject: true,
    });
    expect(info.width).toBe(16);
    expect(info.height).toBe(16);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("document profile folds the downsample into its single encode pass", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ds-doc-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    await postProcessTempPages(
      dir,
      "document",
      { jpegQuality: 90, downsample: { fromDpi: 300, toDpi: 150 } },
      noopLog,
    );
    const out = fs.readFileSync(path.join(dir, "page_00.jpg"));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
    expect(meta.density).toBe(150);
  });

  it("errors (at error level, not warn) when a page's transform fails while a downsample is pending, noting the mixed-size consequence", async () => {
    // The logger ranks warn (2) BELOW error (3) — see src/logger.ts — so this
    // failure must stay at error level or LOG_LEVEL=error would suppress the
    // more consequential mixed-output-size case while plain failures print.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ds-err-"));
    const bad = Buffer.from("this is not a jpeg");
    fs.writeFileSync(path.join(dir, "page_00.jpg"), bad);
    const errors: string[] = [];
    const log = { info: () => {}, error: (m: string) => errors.push(m) };
    await postProcessTempPages(
      dir,
      "none",
      { jpegQuality: 90, downsample: { fromDpi: 300, toDpi: 150 } },
      log,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/page_00\.jpg/);
    expect(errors[0]).toMatch(/wire resolution/);
    expect(errors[0]).toMatch(/output page sizes will differ/);
    // Fail-open behaviour is unchanged — original bytes kept, no .tmp left.
    expect(fs.readFileSync(path.join(dir, "page_00.jpg")).equals(bad)).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("omits the mixed-size consequence text when a page's transform fails and no downsample is pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-nods-err-"));
    const bad = Buffer.from("this is not a jpeg");
    fs.writeFileSync(path.join(dir, "page_00.jpg"), bad);
    const errors: string[] = [];
    const log = { info: () => {}, error: (m: string) => errors.push(m) };
    await postProcessTempPages(dir, "document", { jpegQuality: 90 }, log);
    expect(errors.length).toBe(1);
    expect(errors[0]).not.toMatch(/wire resolution/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("folds the downsample into the forced-grayscale re-encode (profile none)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ds-gray-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    await postProcessTempPages(
      dir,
      "none",
      {
        jpegQuality: 90,
        grayscaleConversion: "force",
        downsample: { fromDpi: 300, toDpi: 150 },
      },
      noopLog,
    );
    const out = fs.readFileSync(path.join(dir, "page_00.jpg"));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
    expect(meta.density).toBe(150);
    expect(meta.channels).toBe(1);
  });

  // -------------------------------------------------------------------------
  // stampDpi — lossless density-only patch for legacy-path pages that reach
  // output with no resize (explicit SCAN_RESOLUTION exact match, or capped
  // above the delivered DPI). See src/exif.ts's setJfifDensity and
  // PostProcessOptions.stampDpi.
  // -------------------------------------------------------------------------

  it("stampDpi under profile none/conversion off: page carries the stamped density, pixel dimensions unchanged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-stamp-none-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    await postProcessTempPages(dir, "none", { jpegQuality: 90, stampDpi: 600 }, noopLog);
    const out = fs.readFileSync(path.join(dir, "page_00.jpg"));
    const meta = await sharp(out).metadata();
    expect(meta.density).toBe(600);
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(32);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stampDpi + forced grayscale: the converted page carries the stamped density", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-stamp-gray-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    await postProcessTempPages(
      dir,
      "none",
      { jpegQuality: 90, grayscaleConversion: "force", stampDpi: 300 },
      noopLog,
    );
    const out = fs.readFileSync(path.join(dir, "page_00.jpg"));
    const meta = await sharp(out).metadata();
    expect(meta.density).toBe(300);
    expect(meta.channels).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stampDpi undefined: existing no-op behaviour is untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-stamp-unset-"));
    await writePage(dir, "page_00.jpg", [222, 220, 244]);
    const before = fs.readFileSync(path.join(dir, "page_00.jpg"));
    await postProcessTempPages(dir, "none", { jpegQuality: 90 }, noopLog);
    expect(fs.readFileSync(path.join(dir, "page_00.jpg")).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
