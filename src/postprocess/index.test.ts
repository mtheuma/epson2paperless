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
});
