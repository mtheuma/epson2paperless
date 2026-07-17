import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createIsFrameReader } from "../../src/is-frame-stream.js";

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
      chunkCount: number;
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
 * The three `!tcp.analysis.*_retransmission` clauses exclude duplicate
 * segments that tshark classifies as retransmits. Without them, the
 * duplicates get extracted as ghost hex events and corrupt downstream
 * replay — the XP-7100 capture needed manual one-line surgery in
 * `xp-7100/jpg-adf-simplex.jsonl` to remove a duplicated segment before
 * its replay test would pass.
 *
 * Wireshark exposes regular, fast, and spurious retransmissions as
 * separate boolean fields — a fast or spurious retransmission isn't
 * necessarily tagged with the generic `tcp.analysis.retransmission` flag,
 * so all three need explicit clauses. See
 * https://www.wireshark.org/docs/dfref/t/tcp.html.
 */
export function buildTsharkArgs(opts: ExtractOptions): string[] {
  const streamFilter = opts.tcpStream !== undefined ? ` && tcp.stream==${opts.tcpStream}` : "";
  return [
    "-r",
    opts.pcapPath,
    "-Y",
    `tcp.port==${opts.scanPort} && tcp.len>0 && ` +
      `!tcp.analysis.retransmission && ` +
      `!tcp.analysis.fast_retransmission && ` +
      `!tcp.analysis.spurious_retransmission && ` +
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
 * chunks with a single summary record; other IS frames pass through verbatim.
 *
 * Large image payloads are typically split across many TCP frames, and the
 * printer occasionally packs more than one IS frame's bytes into a single TCP
 * segment. Rather than re-implementing that reassembly with a hex-prefix /
 * substring-scan heuristic (which can misfire on `49 53` bytes inside pixel
 * payloads and undercounts headers split across TCP frames), the folder feeds
 * `p>h` bytes through the shared `createIsFrameReader` — which walks frames by
 * their declared length — and folds the resulting complete IS frames.
 */
interface ImageChunkFolder {
  feed(e: { dir: "h>p" | "p>h"; ts: number; hex: string }): void;
  finish(): FixtureEvent[];
}

function createImageChunkFolder(): ImageChunkFolder {
  const out: FixtureEvent[] = [];
  const reader = createIsFrameReader();
  let run: { ts: number; chunkSize: number; chunkCount: number; totalBytes: number } | null = null;
  let ts = 0;

  const flushRun = (): void => {
    if (!run) return;
    out.push({
      dir: "p>h",
      ts: run.ts,
      summary: "image-stream",
      chunkCount: run.chunkCount,
      totalBytes: run.totalBytes,
      chunkSize: run.chunkSize,
    });
    run = null;
  };

  const onFrame = (f: { type: number; payload: Buffer; frame: Buffer }): void => {
    if (f.type === 0xa200) {
      const size = f.payload.length;
      if (!run) run = { ts, chunkSize: size, chunkCount: 0, totalBytes: 0 };
      run.chunkCount += 1;
      run.totalBytes += size;
    } else {
      flushRun();
      // Re-emit the complete IS frame verbatim — no header reconstruction, so no
      // assumption about the offset-4 field.
      out.push({ dir: "p>h", ts, hex: f.frame.toString("hex") });
    }
  };

  return {
    feed(e) {
      if (e.dir !== "p>h") {
        flushRun();
        out.push(e);
        return;
      }
      ts = e.ts;
      reader.feed(Buffer.from(e.hex, "hex"), onFrame);
    },
    finish() {
      reader.finish(); // throws on a truncated p>h frame
      flushRun();
      return out;
    },
  };
}

export const __test__createImageChunkFolder = createImageChunkFolder;

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
