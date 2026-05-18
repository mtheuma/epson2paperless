import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runTshark, IS_IMAGE_CHUNK_HEX } from "../pcap-extract/extract.js";
import { IS_HEADER_SIZE } from "../../src/protocol.js";
import { encodeRawGbrToJpeg } from "../../src/esci/raw-to-jpeg.js";
import { setJpegOrientation } from "../../src/exif.js";
import { geometry, type Source, type Format } from "../../src/esci/commands.js";
import { resolveSessionTimestamp } from "../../src/output.js";
import { finalizeSession } from "../../src/output-tail.js";

const VALID_SOURCES = ["flatbed", "adf-simplex", "adf-duplex"] as const satisfies readonly Source[];
const VALID_FORMATS = ["jpg", "pdf"] as const satisfies readonly Format[];
const IS_HEADER_HEX_LEN = IS_HEADER_SIZE * 2;
const PAYLOAD_SIZE_HEX_OFFSET = 12; // BE u32 at byte offset 6 → hex offset 12..20

interface RenderOptions {
  pcapPath: string;
  source: Source;
  format: Format;
  outputDir: string;
  hostIp: string;
  printerIp: string;
  scanPort: number;
}

export async function render(opts: RenderOptions): Promise<{ pageCount: number }> {
  const tshark = process.env.TSHARK_PATH ?? "tshark";
  // `!tcp.analysis.retransmission` keeps duplicated segments out of the
  // hex stream — without it, retransmits get rendered as ghost pixel bytes
  // and corrupt the page. Mirrors the same constraint in pcap-extract.
  const args = [
    "-r",
    opts.pcapPath,
    "-Y",
    `tcp.port==${opts.scanPort} && tcp.len>0 && !tcp.analysis.retransmission && ` +
      `((ip.src==${opts.hostIp} && ip.dst==${opts.printerIp}) || ` +
      `(ip.src==${opts.printerIp} && ip.dst==${opts.hostIp}))`,
    "-T",
    "fields",
    "-E",
    "separator=|",
    "-e",
    "ip.src",
    "-e",
    "tcp.payload",
  ];

  const geom = geometry({ source: opts.source, format: opts.format });
  const pageSize = geom.widthPx * geom.heightPx * 3;
  const buffers: Buffer[] = [];
  let currentChunkRemaining = 0;
  // IS-0xa200 chunks prefix pixels with a status byte; the marker may span TCP segments.
  let pendingStatusByte = false;

  await runTshark(tshark, args, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [src, hex] = trimmed.split("|");
    if (src !== opts.printerIp || !hex) return;
    let pos = 0;
    while (pos < hex.length) {
      if (currentChunkRemaining > 0) {
        if (pendingStatusByte) {
          if (pos + 2 > hex.length) break; // status byte split across segments — defer
          pos += 2;
          currentChunkRemaining -= 1;
          pendingStatusByte = false;
          if (currentChunkRemaining === 0) continue;
        }
        const availableBytes = (hex.length - pos) / 2;
        const take = Math.min(availableBytes, currentChunkRemaining);
        buffers.push(Buffer.from(hex.slice(pos, pos + take * 2), "hex"));
        pos += take * 2;
        currentChunkRemaining -= take;
        continue;
      }
      // Sync loss check: anything other than the IS-0xa200 magic at the
      // current cursor means we're past the image stream or have drifted.
      // Stopping rather than skipping prevents silent pixel corruption from
      // misaligned reads.
      if (hex.slice(pos, pos + IS_IMAGE_CHUNK_HEX.length) !== IS_IMAGE_CHUNK_HEX) break;
      if (pos + PAYLOAD_SIZE_HEX_OFFSET + 8 > hex.length) break; // truncated header
      const size = parseInt(
        hex.slice(pos + PAYLOAD_SIZE_HEX_OFFSET, pos + PAYLOAD_SIZE_HEX_OFFSET + 8),
        16,
      );
      pos += IS_HEADER_HEX_LEN;
      currentChunkRemaining = size;
      pendingStatusByte = true;
    }
  });

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

async function main(): Promise<void> {
  const [pcapPath, source, format, outputDir] = process.argv.slice(2);
  if (!pcapPath || !source || !format || !outputDir) {
    console.error(
      "Usage: tsx tools/pcap-render/render.ts <pcap> <source> <format> <outputDir>\n" +
        "  source: flatbed | adf-simplex | adf-duplex\n" +
        "  format: jpg | pdf\n" +
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
