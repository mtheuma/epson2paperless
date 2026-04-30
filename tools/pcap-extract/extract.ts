import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface ExtractOptions {
  pcapPath: string;
  hostIp: string;
  printerIp: string;
  scanPort: number;
  /** Override tshark binary path. Defaults to env TSHARK_PATH or `tshark`. */
  tsharkPath?: string;
}

export type FixtureEvent =
  | { dir: "h>p" | "p>h"; ts: number; hex: string }
  | {
      dir: "p>h";
      ts: number;
      summary: "image-stream";
      frameCount: number;
      totalBytes: number;
      chunkSize: number;
    };

const TSHARK_DEFAULT = "tshark";
const IS_HEADER_HEX_PREFIX = "4953";
const IS_TYPE_A200_PREFIX = "a200";
const IS_IMAGE_CHUNK_HEX = IS_HEADER_HEX_PREFIX + IS_TYPE_A200_PREFIX;

export async function extract(opts: ExtractOptions): Promise<FixtureEvent[]> {
  const tshark = opts.tsharkPath ?? process.env.TSHARK_PATH ?? TSHARK_DEFAULT;
  const args = [
    "-r",
    opts.pcapPath,
    "-Y",
    `tcp.port==${opts.scanPort} && tcp.len>0`,
    "-T",
    "fields",
    "-E",
    "separator=|",
    "-e",
    "frame.time_relative",
    "-e",
    "ip.src",
    "-e",
    "tcp.payload",
  ];
  const stdout = await runTshark(tshark, args);
  return foldImageChunks(parseLines(stdout, opts.hostIp));
}

function runTshark(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tshark exited ${code}: ${Buffer.concat(err).toString()}`));
        return;
      }
      resolve(Buffer.concat(out).toString());
    });
  });
}

function parseLines(stdout: string, hostIp: string): FixtureEvent[] {
  const events: FixtureEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [tsStr, src, hex] = trimmed.split("|");
    if (!hex) continue;
    events.push({
      dir: src === hostIp ? "h>p" : "p>h",
      ts: parseFloat(tsStr ?? "0"),
      hex,
    });
  }
  return events;
}

/**
 * Replace runs of IS-0xa200 image chunks (and their TCP continuation frames)
 * with a single summary record. Keeps the JSONL small (a few KB instead of
 * the original hundreds of MB).
 *
 * Large image payloads are typically split across many TCP frames. The first
 * frame of each IS chunk starts with the IS header "4953a200". Subsequent
 * frames in the same TCP stream carry raw continuation bytes with no IS
 * header. We fold the entire run (header frame + all continuations) into one
 * summary record.
 */
function foldImageChunks(events: FixtureEvent[]): FixtureEvent[] {
  const out: FixtureEvent[] = [];
  let runStart: { ts: number; chunkSize: number } | null = null;
  let runFrameCount = 0;
  let runTotalBytes = 0;

  const isImageChunkHeader = (e: FixtureEvent): boolean => {
    if (e.dir !== "p>h" || !("hex" in e)) return false;
    return e.hex.startsWith(IS_HEADER_HEX_PREFIX + IS_TYPE_A200_PREFIX);
  };

  /** A continuation frame: printer→host, does NOT start with IS magic "4953". */
  const isImageContinuation = (e: FixtureEvent): boolean => {
    if (e.dir !== "p>h" || !("hex" in e)) return false;
    return !e.hex.startsWith(IS_HEADER_HEX_PREFIX);
  };

  const flushRun = (): void => {
    if (!runStart) return;
    out.push({
      dir: "p>h",
      ts: runStart.ts,
      summary: "image-stream",
      frameCount: runFrameCount,
      totalBytes: runTotalBytes,
      chunkSize: runStart.chunkSize,
    });
    runStart = null;
    runFrameCount = 0;
    runTotalBytes = 0;
  };

  for (const e of events) {
    if (isImageChunkHeader(e) && "hex" in e) {
      // IS header bytes 6-9 (hex chars 12-20) are the payload size (BE uint32)
      const payloadSize = parseInt(e.hex.slice(12, 20), 16);
      if (!runStart) runStart = { ts: e.ts, chunkSize: payloadSize };
      runFrameCount++;
      runTotalBytes += payloadSize;
      continue;
    }
    if (runStart && isImageContinuation(e) && "hex" in e) {
      // TCP continuation frame: may carry the tail of the current chunk AND the IS-0xa200
      // header(s) of subsequent chunks packed into the same TCP segment. Scan for any
      // embedded IS-0xa200 headers and accumulate only their declared payloadSize —
      // do NOT add raw frame bytes, which would double-count data already declared by
      // the IS headers.
      runFrameCount++;
      let offset = 0;
      while (true) {
        const pos = e.hex.indexOf(IS_IMAGE_CHUNK_HEX, offset);
        if (pos === -1) break;
        // IS header layout: magic(4) type(4) flags(4) payloadSize(8) = 20 hex chars total
        const payloadHex = e.hex.slice(pos + 12, pos + 20);
        if (payloadHex.length === 8) {
          runTotalBytes += parseInt(payloadHex, 16);
        }
        offset = pos + 8;
      }
      continue;
    }
    flushRun();
    out.push(e);
  }
  flushRun();
  return out;
}

async function main(): Promise<void> {
  const [pcapPath, hostIp, printerIp, portStr, outPath] = process.argv.slice(2);
  if (!pcapPath || !hostIp || !printerIp || !portStr || !outPath) {
    console.error(
      "Usage: tsx tools/pcap-extract/extract.ts <pcap> <hostIp> <printerIp> <port> <out.jsonl>",
    );
    process.exit(2);
  }
  const events = await extract({
    pcapPath,
    hostIp,
    printerIp,
    scanPort: parseInt(portStr, 10),
  });
  const fs = await import("node:fs");
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(outPath, lines);
  console.log(`Wrote ${events.length} events to ${outPath}`);
}

// Cross-platform main guard: compare resolved filesystem paths
// (import.meta.url is a file URL; process.argv[1] is a native path on Windows)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
