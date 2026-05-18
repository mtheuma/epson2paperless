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
  /**
   * Optional `tcp.stream` index to isolate a single TCP conversation.
   * Useful when a pcap contains multiple connect attempts (e.g. an
   * aborted SYN/RST followed by the real session); without this, both
   * streams' bytes interleave in the output and confuse the replay
   * driver. List the indices via
   * `tshark -r <pcap> -Y "tcp.port==<port>" -T fields -e tcp.stream -e ip.src -e ip.dst | sort -u`
   * (the `-z conv,tcp` summary table does NOT expose the stream index)
   * and pick the one whose endpoints are the host/printer IP pair you
   * captured. Wireshark's GUI also shows this as the `tcp.stream` field
   * on any selected packet.
   */
  tcpStream?: number;
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
export const IS_IMAGE_CHUNK_HEX = IS_HEADER_HEX_PREFIX + IS_TYPE_A200_PREFIX;

/**
 * Build the tshark argv used by `extract`. Factored out for unit testing —
 * the display filter is the only knob that needs regression coverage, and
 * we'd rather pin its exact string than spawn tshark in a unit test.
 *
 * The `!tcp.analysis.retransmission` clause excludes TCP retransmits, which
 * tshark detects when a segment carries the same sequence number as one
 * already seen on the stream. Without this, retransmits get extracted as
 * duplicate hex events and corrupt downstream replay — the XP-7100 capture
 * needed manual one-line surgery in `xp-7100/jpg-adf-simplex.jsonl` to
 * remove a duplicated segment before its replay test would pass.
 */
export function buildTsharkArgs(opts: ExtractOptions): string[] {
  const streamFilter = opts.tcpStream !== undefined ? ` && tcp.stream==${opts.tcpStream}` : "";
  return [
    "-r",
    opts.pcapPath,
    "-Y",
    `tcp.port==${opts.scanPort} && tcp.len>0 && !tcp.analysis.retransmission && ` +
      `((ip.src==${opts.hostIp} && ip.dst==${opts.printerIp}) || ` +
      `(ip.src==${opts.printerIp} && ip.dst==${opts.hostIp}))${streamFilter}`,
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
}

export async function extract(opts: ExtractOptions): Promise<FixtureEvent[]> {
  const tshark = opts.tsharkPath ?? process.env.TSHARK_PATH ?? TSHARK_DEFAULT;
  const args = buildTsharkArgs(opts);
  const folder = createImageChunkFolder();
  await runTshark(tshark, args, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [tsStr, src, hex] = trimmed.split("|");
    if (!hex) return;
    folder.feed({
      dir: src === opts.hostIp ? "h>p" : "p>h",
      ts: parseFloat(tsStr ?? "0"),
      hex,
    });
  });
  const events = folder.finish();
  const dirs = new Set(events.map((e) => e.dir));
  if (events.length > 0 && (!dirs.has("h>p") || !dirs.has("p>h"))) {
    throw new Error(
      `pcap-extract: no bidirectional traffic on tcp.port==${opts.scanPort} ` +
        `between ${opts.hostIp} and ${opts.printerIp}. Verify the IPs and pcap.`,
    );
  }
  return events;
}

/**
 * Stream tshark stdout line-by-line. Buffering the full output ran into Node's
 * 0x1fffffe8-character string-length limit on multi-hundred-megabyte pcaps.
 */
export function runTshark(
  bin: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const err: Buffer[] = [];
    let leftover = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const text = leftover + chunk;
      const lines = text.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (leftover) onLine(leftover);
      if (code !== 0) {
        reject(new Error(`tshark exited ${code}: ${Buffer.concat(err).toString()}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Streaming version of the image-chunk folder. Replace runs of IS-0xa200 image
 * chunks (and their TCP continuation frames) with a single summary record.
 *
 * Large image payloads are typically split across many TCP frames. The first
 * frame of each IS chunk starts with the IS header "4953a200". Subsequent
 * frames in the same TCP stream carry raw continuation bytes with no IS
 * header. The folder accumulates run state across feed() calls; finish()
 * flushes any in-progress run and returns the full event list.
 */
interface ImageChunkFolder {
  feed(e: { dir: "h>p" | "p>h"; ts: number; hex: string }): void;
  finish(): FixtureEvent[];
}

function createImageChunkFolder(): ImageChunkFolder {
  const out: FixtureEvent[] = [];
  let runStart: { ts: number; chunkSize: number } | null = null;
  let runFrameCount = 0;
  let runTotalBytes = 0;

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

  return {
    feed(e) {
      if (e.dir !== "p>h") {
        flushRun();
        out.push(e);
        return;
      }
      const isImageChunkHeader = e.hex.startsWith(IS_IMAGE_CHUNK_HEX);
      // During an image-stream run, anything from the printer that does NOT
      // start with the IS-0xa200 magic is a continuation frame — including raw
      // pixel data that happens to begin with bytes 0x49 0x53 ("IS"). The
      // earlier check on just `4953` was too permissive: pixel bytes coincide
      // with that 2-byte prefix often enough on multi-MB streams to falsely
      // terminate runs and inflate frame counts.
      const isContinuation = runStart !== null && !e.hex.startsWith(IS_IMAGE_CHUNK_HEX);

      if (isImageChunkHeader) {
        // IS header bytes 6-9 (hex chars 12-20) are the payload size (BE uint32)
        const payloadSize = parseInt(e.hex.slice(12, 20), 16);
        if (!runStart) runStart = { ts: e.ts, chunkSize: payloadSize };
        runFrameCount++;
        runTotalBytes += payloadSize;
        return;
      }
      if (isContinuation) {
        // TCP continuation frame: may carry the tail of the current chunk AND
        // the IS-0xa200 header(s) of subsequent chunks packed into the same TCP
        // segment. Scan for embedded IS-0xa200 headers and accumulate only their
        // declared payloadSize — adding raw frame bytes would double-count data
        // already declared by the IS headers.
        runFrameCount++;
        let offset = 0;
        while (true) {
          const pos = e.hex.indexOf(IS_IMAGE_CHUNK_HEX, offset);
          if (pos === -1) break;
          const payloadHex = e.hex.slice(pos + 12, pos + 20);
          if (payloadHex.length === 8) {
            runTotalBytes += parseInt(payloadHex, 16);
          }
          offset = pos + IS_IMAGE_CHUNK_HEX.length;
        }
        return;
      }
      flushRun();
      out.push(e);
    },
    finish() {
      flushRun();
      return out;
    },
  };
}

async function main(): Promise<void> {
  // Strip optional `--stream N` from positional args so the existing
  // five-positional CLI shape stays backwards-compatible.
  const argv = process.argv.slice(2);
  let tcpStream: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stream" && i + 1 < argv.length) {
      tcpStream = parseInt(argv[++i], 10);
    } else {
      positional.push(argv[i]);
    }
  }
  const [pcapPath, hostIp, printerIp, portStr, outPath] = positional;
  if (!pcapPath || !hostIp || !printerIp || !portStr || !outPath) {
    console.error(
      "Usage: tsx tools/pcap-extract/extract.ts <pcap> <hostIp> <printerIp> <port> <out.jsonl> [--stream N]",
    );
    process.exit(2);
  }
  const events = await extract({
    pcapPath,
    hostIp,
    printerIp,
    scanPort: parseInt(portStr, 10),
    tcpStream,
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
