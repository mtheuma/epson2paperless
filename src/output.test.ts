import { describe, it, expect } from "vitest";
import {
  generateFilename,
  resolveSessionTimestamp,
  writeOutputFile,
  promoteTempPagesToOutput,
} from "./output.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("generateFilename", () => {
  it("generates a filename with timestamp and extension", () => {
    const date = new Date("2026-04-16T14:30:22.000Z");
    const name = generateFilename(date, "bin");
    expect(name).toBe("scan_2026-04-16_143022.bin");
  });

  it("pads single-digit values with zeros", () => {
    const date = new Date("2026-01-05T03:07:09.000Z");
    const name = generateFilename(date, "pdf");
    expect(name).toBe("scan_2026-01-05_030709.pdf");
  });

  it("appends _NN suffix when a page index is provided", () => {
    const date = new Date("2026-04-20T08:14:38.000Z");
    expect(generateFilename(date, "jpg", 1)).toBe("scan_2026-04-20_081438_01.jpg");
    expect(generateFilename(date, "jpg", 12)).toBe("scan_2026-04-20_081438_12.jpg");
  });

  it("expands page-index padding for scans larger than 99 pages", () => {
    const date = new Date("2026-04-20T08:14:38.000Z");
    expect(generateFilename(date, "jpg", 100)).toBe("scan_2026-04-20_081438_100.jpg");
  });

  it("omits the page suffix when pageIndex is undefined (existing behaviour)", () => {
    const date = new Date("2026-04-20T08:14:38.000Z");
    expect(generateFilename(date, "jpg")).toBe("scan_2026-04-20_081438.jpg");
  });
});

describe("writeOutputFile", () => {
  it("appends _N suffix when the target filename already exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-test-"));
    try {
      writeOutputFile(dir, "x.jpg", Buffer.from("a"));
      writeOutputFile(dir, "x.jpg", Buffer.from("b"));
      writeOutputFile(dir, "x.jpg", Buffer.from("c"));
      const entries = fs.readdirSync(dir).sort();
      expect(entries).toEqual(["x.jpg", "x_1.jpg", "x_2.jpg"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSessionTimestamp", () => {
  const base = new Date("2026-04-20T08:14:38.000Z");

  it("returns the input date unchanged when the output directory is empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-test-"));
    try {
      const result = resolveSessionTimestamp(base, dir);
      expect(result.toISOString()).toBe(base.toISOString());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the input date unchanged when the output directory does not exist", () => {
    const dir = path.join(os.tmpdir(), `epson2paperless-missing-${Date.now()}`);
    const result = resolveSessionTimestamp(base, dir);
    expect(result.toISOString()).toBe(base.toISOString());
  });

  it("bumps by +1s when a scan_<ts>.jpg already exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-test-"));
    try {
      fs.writeFileSync(path.join(dir, "scan_2026-04-20_081438.jpg"), "x");
      const result = resolveSessionTimestamp(base, dir);
      expect(result.toISOString()).toBe("2026-04-20T08:14:39.000Z");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bumps past three consecutive occupied seconds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-test-"));
    try {
      fs.writeFileSync(path.join(dir, "scan_2026-04-20_081438.jpg"), "x");
      fs.writeFileSync(path.join(dir, "scan_2026-04-20_081439_01.jpg"), "x");
      fs.writeFileSync(path.join(dir, "scan_2026-04-20_081440_03.jpg"), "x");
      const result = resolveSessionTimestamp(base, dir);
      expect(result.toISOString()).toBe("2026-04-20T08:14:41.000Z");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-matching files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-test-"));
    try {
      fs.writeFileSync(path.join(dir, "other.jpg"), "x");
      fs.writeFileSync(path.join(dir, "scan_2026-04-20_000000.jpg"), "x");
      const result = resolveSessionTimestamp(base, dir);
      expect(result.toISOString()).toBe(base.toISOString());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("promoteTempPagesToOutput", () => {
  const sessionTs = new Date("2026-04-20T08:14:38.000Z");

  it("moves a single page as scan_<ts>.<ext> (no NN suffix)", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-out-"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-tmp-"));
    try {
      fs.writeFileSync(path.join(tempDir, "page_01.jpg"), Buffer.from("X"));
      const paths = promoteTempPagesToOutput(tempDir, outDir, sessionTs, "jpg");
      expect(paths.length).toBe(1);
      expect(paths[0]).toBe(path.join(outDir, "scan_2026-04-20_081438.jpg"));
      expect(fs.existsSync(paths[0])).toBe(true);
      expect(fs.readdirSync(tempDir)).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("moves multiple pages with _NN suffix", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-out-"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-tmp-"));
    try {
      fs.writeFileSync(path.join(tempDir, "page_01.jpg"), Buffer.from("A"));
      fs.writeFileSync(path.join(tempDir, "page_02.jpg"), Buffer.from("B"));
      fs.writeFileSync(path.join(tempDir, "page_03.jpg"), Buffer.from("C"));
      const paths = promoteTempPagesToOutput(tempDir, outDir, sessionTs, "jpg");
      expect(paths.length).toBe(3);
      expect(paths[0]).toBe(path.join(outDir, "scan_2026-04-20_081438_01.jpg"));
      expect(paths[1]).toBe(path.join(outDir, "scan_2026-04-20_081438_02.jpg"));
      expect(paths[2]).toBe(path.join(outDir, "scan_2026-04-20_081438_03.jpg"));
      for (const p of paths) expect(fs.existsSync(p)).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("sorts page files numerically (page_10 after page_02)", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-out-"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-tmp-"));
    try {
      fs.writeFileSync(path.join(tempDir, "page_10.jpg"), Buffer.from("J"));
      fs.writeFileSync(path.join(tempDir, "page_02.jpg"), Buffer.from("B"));
      fs.writeFileSync(path.join(tempDir, "page_01.jpg"), Buffer.from("A"));
      const paths = promoteTempPagesToOutput(tempDir, outDir, sessionTs, "jpg");
      expect(paths).toEqual([
        path.join(outDir, "scan_2026-04-20_081438_01.jpg"),
        path.join(outDir, "scan_2026-04-20_081438_02.jpg"),
        path.join(outDir, "scan_2026-04-20_081438_10.jpg"),
      ]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns an empty array when tempDir is empty", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-out-"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "epson2paperless-tmp-"));
    try {
      const paths = promoteTempPagesToOutput(tempDir, outDir, sessionTs, "jpg");
      expect(paths).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
