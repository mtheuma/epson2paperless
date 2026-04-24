import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("output");

// UTC so filenames are stable across host timezones (e.g. in Docker).
function formatTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}_${h}${mi}${s}`;
}

/**
 * Generates a scan filename like "scan_2026-04-16_143022.jpg" (single-page)
 * or "scan_2026-04-16_143022_01.jpg" (multi-page, with pageIndex >= 1).
 */
export function generateFilename(date: Date, extension: string, pageIndex?: number): string {
  const timestamp = formatTimestamp(date);
  if (pageIndex === undefined) {
    return `scan_${timestamp}.${extension}`;
  }
  const page = String(pageIndex).padStart(2, "0");
  return `scan_${timestamp}_${page}.${extension}`;
}

/**
 * Writes data to a file in the output directory.
 * If a file with the same name exists, appends _1, _2, etc.
 */
export function writeOutputFile(outputDir: string, filename: string, data: Buffer): string {
  fs.mkdirSync(outputDir, { recursive: true });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let filePath = path.join(outputDir, filename);
  let counter = 1;

  // wx = fail if exists. Atomic vs the existsSync-then-write TOCTOU pattern.
  while (true) {
    try {
      fs.writeFileSync(filePath, data, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      filePath = path.join(outputDir, `${base}_${counter}${ext}`);
      counter++;
    }
  }

  log.info(`Saved scan to ${filePath} (${data.length} bytes)`);
  return filePath;
}

/**
 * Returns a Date such that no file in `outputDir` starts with
 * `scan_<formatted(returned)>`. Starts from `base` and bumps by +1 second
 * until free. Used at scan-session start so every page of one scan shares
 * a timestamp prefix without the page suffix colliding with a prior scan.
 *
 * Returns `base` unchanged if `outputDir` does not exist.
 */
export function resolveSessionTimestamp(base: Date, outputDir: string): Date {
  let entries: string[];
  try {
    entries = fs.readdirSync(outputDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return base;
    throw err;
  }
  // `scan_` (5) + `YYYY-MM-DD_HHMMSS` (17) = 22-char shared prefix.
  const PREFIX_LEN = 22;
  const taken = new Set(
    entries.filter((n) => n.startsWith("scan_")).map((n) => n.slice(0, PREFIX_LEN)),
  );
  let candidate = new Date(base.getTime());
  while (taken.has(`scan_${formatTimestamp(candidate)}`)) {
    candidate = new Date(candidate.getTime() + 1000);
  }
  return candidate;
}

/**
 * Filters and sorts `page_NN.<ext>` filenames numerically by page number.
 * If `ext` is provided, only files with that extension are kept; otherwise
 * any extension matches. Non-matching names are dropped silently.
 */
export function sortedPageFiles(names: string[], ext?: string): string[] {
  const extPattern = ext ? ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[^.]+";
  const re = new RegExp(`^page_(\\d+)\\.${extPattern}$`);
  const matched: { name: string; page: number }[] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) matched.push({ name, page: parseInt(m[1], 10) });
  }
  matched.sort((a, b) => a.page - b.page);
  return matched.map((e) => e.name);
}

/**
 * Moves all `page_NN.<ext>` files from `tempDir` into `outputDir`, renaming
 * them to the standard scan filename convention:
 *   - 1 file  → scan_<ts>.<ext>
 *   - N files → scan_<ts>_01.<ext>, _02.<ext>, … in numerically sorted order
 *
 * Returns the list of final absolute paths written, in ascending page order.
 * Uses the existing `writeOutputFile` so collisions with pre-existing
 * `scan_<ts>…` files are handled via the `_1` suffix pattern.
 */
export function promoteTempPagesToOutput(
  tempDir: string,
  outputDir: string,
  sessionTs: Date,
  extension: string,
): string[] {
  const entries = sortedPageFiles(fs.readdirSync(tempDir));

  const paths: string[] = [];
  for (const entry of entries) {
    const src = path.join(tempDir, entry);
    const data = fs.readFileSync(src);
    const pageNum = parseInt(entry.match(/^page_(\d+)/)![1], 10);
    const pageIndex = entries.length > 1 ? pageNum : undefined;
    const filename = generateFilename(sessionTs, extension, pageIndex);
    const out = writeOutputFile(outputDir, filename, data);
    fs.unlinkSync(src);
    paths.push(out);
  }
  return paths;
}
