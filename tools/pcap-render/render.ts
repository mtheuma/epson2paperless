import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runTshark } from "../pcap-extract/extract.js";
import { encodeRawRgbToJpeg } from "../../src/raw-to-jpeg.js";
import { setJpegOrientation } from "../../src/exif.js";
import { geometry, type Source, type Format } from "../../src/esci-legacy.js";
import { resolveSessionTimestamp } from "../../src/output.js";
import { finalizeSession } from "../../src/output-tail.js";

const IS_IMAGE_CHUNK_HEX = "4953a200";
const VALID_SOURCES: Source[] = ["flatbed", "adf-simplex", "adf-duplex"];
const VALID_FORMATS: Format[] = ["jpg", "pdf"];

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
  const args = [
    "-r",
    opts.pcapPath,
    "-Y",
    `tcp.port==${opts.scanPort} && tcp.len>0 && ` +
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

  await runTshark(tshark, args, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [src, hex] = trimmed.split("|");
    if (src !== opts.printerIp || !hex) return;
    let pos = 0;
    while (pos < hex.length) {
      if (currentChunkRemaining > 0) {
        const availableBytes = (hex.length - pos) / 2;
        const take = Math.min(availableBytes, currentChunkRemaining);
        buffers.push(Buffer.from(hex.slice(pos, pos + take * 2), "hex"));
        pos += take * 2;
        currentChunkRemaining -= take;
        continue;
      }
      // Expect a new IS-0xa200 chunk header at this position
      if (hex.slice(pos, pos + IS_IMAGE_CHUNK_HEX.length) !== IS_IMAGE_CHUNK_HEX) break;
      // payloadSize is BE u32 at byte offset 6, hex offset pos+12 .. pos+20
      const size = parseInt(hex.slice(pos + 12, pos + 20), 16);
      pos += 24; // skip 12-byte IS header
      currentChunkRemaining = size;
    }
  });

  const allRgb = Buffer.concat(buffers);
  const pageCount = Math.floor(allRgb.length / pageSize);
  if (pageCount === 0) {
    throw new Error(
      `pcap-render: no full pages extracted from ${opts.pcapPath} ` +
        `(got ${allRgb.length} bytes, page size ${pageSize}). ` +
        `Verify --source and --format match the capture.`,
    );
  }

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const sessionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcap-render-"));
  const sessionTs = resolveSessionTimestamp(new Date(), opts.outputDir);
  const backPageIndices: number[] = [];

  for (let i = 0; i < pageCount; i++) {
    const pageBytes = allRgb.subarray(i * pageSize, (i + 1) * pageSize);
    let jpg = await encodeRawRgbToJpeg(pageBytes, geom.widthPx, geom.heightPx, 90);
    const pageNum = i + 1;
    if (opts.source === "adf-duplex" && pageNum % 2 === 0) {
      jpg = setJpegOrientation(jpg, 3);
      backPageIndices.push(pageNum);
    }
    const jpgPath = path.join(sessionTempDir, `page_${String(pageNum).padStart(2, "0")}.jpg`);
    fs.writeFileSync(jpgPath, jpg);
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
