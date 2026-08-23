import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createIsFrameReader } from "../../src/is-frame-stream.js";

export interface ExtractOptions {
  pcapPath: string;
  /**
   * Endpoint addresses, IPv4 or IPv6. Both must be the same family (enforced
   * in `buildTsharkArgs`); it selects the tshark field name (`ip.*` vs
   * `ipv6.*`). Scan sessions
   * do reach the printer over IPv6 in the wild -- a Bonjour-discovered
   * scanner can pick it with no user control over the choice (issue #166).
   */
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
   * `tshark -r <pcap> -Y "tcp.port==<port>" -T fields -e tcp.stream -e ip.src -e ip.dst -e ipv6.src -e ipv6.dst | sort -u`
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

/**
 * tshark field prefix for an address's family. A colon only ever appears in an
 * IPv6 literal, and `ip.src==<v6 literal>` is a filter compile error rather
 * than a silent miss, so the family has to pick the field name.
 */
function addressFieldPrefix(addr: string): "ip" | "ipv6" {
  return addr.includes(":") ? "ipv6" : "ip";
}

/**
 * Which side of the conversation a segment came from, keyed on the source port
 * rather than the source address: the printer is whichever endpoint holds the
 * scan port. Address comparison would be brittle for IPv6, where one address
 * has several equally valid spellings (case, zero-compression) and tshark's
 * canonical form need not match what the caller typed on the command line.
 */
export function directionFor(srcPort: number, scanPort: number): "h>p" | "p>h" {
  return srcPort === scanPort ? "p>h" : "h>p";
}

/**
 * Build the tshark argv used by `extract`. Factored out for unit testing —
 * the display filter is the only knob that needs regression coverage, and
 * we'd rather pin its exact string than spawn tshark in a unit test.
 *
 * The filter deliberately does NOT exclude `tcp.analysis.*_retransmission`
 * frames. On captures with real packet loss (Wi-Fi captures like XP-620's
 * and 4 of the 10 WF-3620 ones), a retransmission-flagged frame can be the
 * ONLY captured copy of its byte range — excluding it silently drops bytes
 * from the middle of the stream. Duplicates are instead discarded
 * sequence-aware in `reassembleSession`, which also restores seq order for
 * gap-filling retransmits that were captured out of order.
 */
export function buildTsharkArgs(opts: ExtractOptions): string[] {
  const streamFilter = opts.tcpStream !== undefined ? ` && tcp.stream==${opts.tcpStream}` : "";
  const fam = addressFieldPrefix(opts.hostIp);
  if (fam !== addressFieldPrefix(opts.printerIp)) {
    throw new Error(
      `pcap-extract: hostIp (${opts.hostIp}) and printerIp (${opts.printerIp}) must be the ` +
        `same address family. A scan session runs over one family or the other, never a mix.`,
    );
  }
  return [
    "-r",
    opts.pcapPath,
    // Reassembly sorts on tcp.seq, so pin the relative-seq preference rather
    // than trusting the invoking user's Wireshark profile: absolute seqs from
    // a random ISN can wrap 2^32 mid-stream and mis-sort.
    "-o",
    "tcp.relative_sequence_numbers:TRUE",
    "-Y",
    `tcp.port==${opts.scanPort} && tcp.len>0 && ` +
      `((${fam}.src==${opts.hostIp} && ${fam}.dst==${opts.printerIp}) || ` +
      `(${fam}.src==${opts.printerIp} && ${fam}.dst==${opts.hostIp}))${streamFilter}`,
    "-T",
    "fields",
    "-E",
    "separator=|",
    "-e",
    "frame.time_relative",
    "-e",
    "tcp.srcport",
    "-e",
    "tcp.stream",
    "-e",
    "tcp.seq",
    "-e",
    "tcp.payload",
  ];
}

/** One captured TCP segment with payload, as reported by tshark. */
export interface RawPacket {
  dir: "h>p" | "p>h";
  ts: number;
  /** tshark's tcp.seq (relative by default; only differences are used). */
  seq: number;
  payload: Buffer;
}

export interface StreamEvent {
  dir: "h>p" | "p>h";
  ts: number;
  payload: Buffer;
}

/**
 * Sequence-aware TCP reassembly of one scan session's captured segments.
 *
 * Per direction, segments are stably sorted by `tcp.seq` and walked
 * greedily, accepting only bytes that extend the stream contiguously:
 * a segment ending at or before the accepted tail is a true duplicate and
 * is dropped; a segment overlapping the tail but carrying new trailing
 * bytes is trimmed to just that new tail (TCP can coalesce a resend with
 * newly-available data — seen in the WF-3620 `adf-4-page-duplex-jpeg`
 * capture); a segment starting past the tail means the capture is missing
 * bytes entirely, which is a hard error. This also drops TCP keepalive
 * garbage bytes (seq one below the tail), which the old display-filter
 * approach let through.
 *
 * The two directions are then merged back into one chronological list with
 * a stable two-pointer merge on timestamps — NOT a combined sort by ts.
 * On real lossy captures the printer-side timestamps are not monotonic in
 * seq order (capture-side jitter), so a ts sort would re-shuffle the
 * already-correct seq-ordered stream and corrupt it again.
 */
export function reassembleSession(packets: RawPacket[]): StreamEvent[] {
  const reassembleDirection = (dir: "h>p" | "p>h"): StreamEvent[] => {
    const sorted = packets.filter((p) => p.dir === dir).sort((a, b) => a.seq - b.seq);
    const out: StreamEvent[] = [];
    let nextSeq: number | null = null;
    for (const p of sorted) {
      const end = p.seq + p.payload.length;
      if (nextSeq === null) nextSeq = p.seq;
      if (end <= nextSeq) continue; // duplicate of already-accepted bytes
      if (p.seq > nextSeq) {
        throw new Error(
          `pcap-extract: ${dir} stream has a gap — expected seq ${nextSeq}, ` +
            `next captured segment starts at ${p.seq} (${p.seq - nextSeq} bytes ` +
            `missing from the capture)`,
        );
      }
      out.push({ dir, ts: p.ts, payload: p.payload.subarray(nextSeq - p.seq) });
      nextSeq = end;
    }
    return out;
  };

  const host = reassembleDirection("h>p");
  const printer = reassembleDirection("p>h");
  const merged: StreamEvent[] = [];
  let h = 0;
  let p = 0;
  while (h < host.length && p < printer.length) {
    merged.push(host[h].ts <= printer[p].ts ? host[h++] : printer[p++]);
  }
  while (h < host.length) merged.push(host[h++]);
  while (p < printer.length) merged.push(printer[p++]);
  return merged;
}

/**
 * Guard against a pcap holding several TCP conversations on the scan port
 * (e.g. a rejected TLS probe ahead of the real session). Per-stream relative
 * seqs all start at 1, so letting two conversations into `reassembleSession`
 * would silently discard real bytes as cross-stream "duplicates" — fail with
 * a --stream hint instead.
 */
export function assertSingleConversation(streams: Iterable<number>, scanPort: number): void {
  const distinct = [...streams].sort((a, b) => a - b);
  if (distinct.length > 1) {
    throw new Error(
      `pcap-extract: capture holds ${distinct.length} TCP conversations on ` +
        `tcp.port==${scanPort} (tcp.stream ${distinct.join(", ")}) — pass ` +
        `--stream <N> to isolate the scan session`,
    );
  }
}

/** Run tshark over the capture and collect every payload-bearing segment. */
export async function capturePackets(opts: ExtractOptions): Promise<RawPacket[]> {
  const tshark = opts.tsharkPath ?? process.env.TSHARK_PATH ?? TSHARK_DEFAULT;
  const packets: RawPacket[] = [];
  const streams = new Set<number>();
  await runTshark(tshark, buildTsharkArgs(opts), (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [tsStr, srcPortStr, streamStr, seqStr, hex] = trimmed.split("|");
    if (!hex) return;
    streams.add(parseInt(streamStr ?? "0", 10));
    packets.push({
      dir: directionFor(parseInt(srcPortStr ?? "0", 10), opts.scanPort),
      ts: parseFloat(tsStr ?? "0"),
      seq: parseInt(seqStr ?? "0", 10),
      payload: Buffer.from(hex, "hex"),
    });
  });
  assertSingleConversation(streams, opts.scanPort);
  return packets;
}

export async function extract(opts: ExtractOptions): Promise<FixtureEvent[]> {
  const packets = await capturePackets(opts);
  const folder = createImageChunkFolder();
  for (const e of reassembleSession(packets)) {
    folder.feed({ dir: e.dir, ts: e.ts, hex: e.payload.toString("hex") });
  }
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
