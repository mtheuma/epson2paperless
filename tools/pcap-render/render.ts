import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runTshark } from "../pcap-extract/extract.js";
import { createIsFrameReader } from "../../src/is-frame-stream.js";
import { encodeRawGbrToJpeg } from "../../src/esci/raw-to-jpeg.js";
import { setJpegOrientation } from "../../src/exif.js";
import { geometry, type Source, type Format } from "../../src/esci/commands.js";
import { resolveSessionTimestamp } from "../../src/output.js";
import { finalizeSession } from "../../src/output-tail.js";

const VALID_SOURCES = ["flatbed", "adf-simplex", "adf-duplex"] as const satisfies readonly Source[];
const VALID_FORMATS = ["jpg", "pdf"] as const satisfies readonly Format[];

interface RenderOptions {
  pcapPath: string;
  source: Source;
  format: Format;
  outputDir: string;
  hostIp: string;
  printerIp: string;
  scanPort: number;
  tcpStream?: number;
  widthPx?: number;
  heightPx?: number;
}

export async function render(opts: RenderOptions): Promise<{ pageCount: number }> {
  const tshark = process.env.TSHARK_PATH ?? "tshark";
  // The three `!tcp.analysis.*_retransmission` clauses keep duplicated
  // segments out of the hex stream — without them, retransmits get rendered
  // as ghost pixel bytes and corrupt the page. Wireshark exposes regular,
  // fast, and spurious retransmissions as separate boolean fields, so all
  // three need explicit clauses. Mirrors the same constraint in pcap-extract.
  // See https://www.wireshark.org/docs/dfref/t/tcp.html.
  const streamFilter = opts.tcpStream !== undefined ? ` && tcp.stream==${opts.tcpStream}` : "";
  const args = [
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
    "ip.src",
    "-e",
    "tcp.payload",
  ];

  const geom =
    opts.widthPx && opts.heightPx
      ? { widthPx: opts.widthPx, heightPx: opts.heightPx }
      : geometry({ source: opts.source, format: opts.format });
  const pageSize = geom.widthPx * geom.heightPx * 3;
  const buffers: Buffer[] = [];
  const reader = createIsFrameReader();

  await runTshark(tshark, args, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [src, hex] = trimmed.split("|");
    if (src !== opts.printerIp || !hex) return;
    reader.feed(Buffer.from(hex, "hex"), (f) => {
      // IS-0xa200 chunks prefix pixels with a 1-byte status; strip it before
      // appending — everything else (acks, control frames) is ignored.
      if (f.type === 0xa200) buffers.push(f.payload.subarray(1));
    });
  });
  // Throws on any leftover partial bytes — a truncated capture should fail
  // loudly rather than silently render a short/garbled page.
  reader.finish();

  const allGbr = Buffer.concat(buffers);
  const pageCount = Math.floor(allGbr.length / pageSize);
  if (pageCount === 0) {
    throw new Error(
      `pcap-render: no full pages extracted from ${opts.pcapPath} ` +
        `(got ${allGbr.length} bytes, page size ${pageSize}). ` +
        `Verify --source and --format match the capture.`,
    );
  }

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const sessionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcap-render-"));
  const sessionTs = resolveSessionTimestamp(new Date(), opts.outputDir);
  const backPageIndices: number[] = [];

  // Encode pages in parallel — sharp dispatches to a libuv worker pool, so
  // awaiting sequentially leaves cores idle. For a 4-page duplex JPEG run
  // that's ~9s instead of ~36s. Memory tradeoff is bounded: the raw GBR
  // pages already coexist in `allGbr` regardless of encode concurrency.
  const encoded = await Promise.all(
    Array.from({ length: pageCount }, async (_, i) => {
      const pageBytes = allGbr.subarray(i * pageSize, (i + 1) * pageSize);
      const pageNum = i + 1;
      const isBackPage = opts.source === "adf-duplex" && pageNum % 2 === 0;
      const jpg = await encodeRawGbrToJpeg(pageBytes, geom.widthPx, geom.heightPx, 90);
      return { pageNum, isBackPage, jpg: isBackPage ? setJpegOrientation(jpg, 3) : jpg };
    }),
  );
  for (const { pageNum, isBackPage, jpg } of encoded) {
    if (isBackPage) backPageIndices.push(pageNum);
    fs.writeFileSync(
      path.join(sessionTempDir, `page_${String(pageNum).padStart(2, "0")}.jpg`),
      jpg,
    );
  }

  await finalizeSession({
    sessionTempDir,
    outputDir: opts.outputDir,
    sessionTs,
    action: opts.format,
    backPageIndices,
    paperless: undefined,
  });

  return { pageCount };
}

function isSource(s: string): s is Source {
  return (VALID_SOURCES as string[]).includes(s);
}
function isFormat(f: string): f is Format {
  return (VALID_FORMATS as string[]).includes(f);
}

export interface RenderCliArgs {
  pcapPath: string;
  source: string;
  format: string;
  outputDir: string;
  tcpStream?: number;
  widthPx?: number;
  heightPx?: number;
}

/**
 * Parse `render.ts` CLI argv (post `node`/script name). Factored out from
 * `main()` so the flag-parsing logic is unit-testable without spawning
 * tshark. Positional args are `<pcap> <source> <format> <outputDir>`;
 * `--stream`, `--width`, and `--height` are optional flags that can appear
 * anywhere in argv.
 */
export function parseRenderArgs(argv: string[]): RenderCliArgs {
  const positional: string[] = [];
  let tcpStream: number | undefined;
  let widthPx: number | undefined;
  let heightPx: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stream" && i + 1 < argv.length) {
      tcpStream = parseInt(argv[++i], 10);
    } else if (arg === "--width" && i + 1 < argv.length) {
      widthPx = parseInt(argv[++i], 10);
    } else if (arg === "--height" && i + 1 < argv.length) {
      heightPx = parseInt(argv[++i], 10);
    } else {
      positional.push(arg);
    }
  }
  const [pcapPath, source, format, outputDir] = positional;
  return { pcapPath, source, format, outputDir, tcpStream, widthPx, heightPx };
}

async function main(): Promise<void> {
  const { pcapPath, source, format, outputDir, tcpStream, widthPx, heightPx } = parseRenderArgs(
    process.argv.slice(2),
  );
  if (!pcapPath || !source || !format || !outputDir) {
    console.error(
      "Usage: tsx tools/pcap-render/render.ts <pcap> <source> <format> <outputDir>\n" +
        "  source: flatbed | adf-simplex | adf-duplex\n" +
        "  format: jpg | pdf\n" +
        "  Flags: --stream <tcpStream>  --width <px>  --height <px>\n" +
        "  Env: HOST_IP (default 192.168.188.140), PRINTER_IP (default 192.168.188.54),\n" +
        "       SCAN_PORT (default 1865), TSHARK_PATH (default tshark)",
    );
    process.exit(2);
  }
  if (!isSource(source)) {
    console.error(`Invalid source "${source}". Expected one of: ${VALID_SOURCES.join(", ")}`);
    process.exit(2);
  }
  if (!isFormat(format)) {
    console.error(`Invalid format "${format}". Expected one of: ${VALID_FORMATS.join(", ")}`);
    process.exit(2);
  }
  const { pageCount } = await render({
    pcapPath,
    source,
    format,
    outputDir,
    hostIp: process.env.HOST_IP ?? "192.168.188.140",
    printerIp: process.env.PRINTER_IP ?? "192.168.188.54",
    scanPort: parseInt(process.env.SCAN_PORT ?? "1865", 10),
    tcpStream,
    widthPx,
    heightPx,
  });
  console.log(`Rendered ${pageCount} page(s) (${source}/${format}) to ${outputDir}`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
