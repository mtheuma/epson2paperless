// src/esci2/test-support/capability-bodies.ts
//
// Recovers the INIT1 INFO and CAPA reply bodies, and the first init-poll STAT
// reply, from a committed ESC/I-2 replay fixture, for tests that check
// capability derivation against the printers we have recordings of.
//
// Both fixture formats carry the printer→host byte stream: pcap-extract
// events as `{ dir: "p>h", hex }`, Frida events as `{ hook: "recv",
// payload_hex }`. Concatenated in order, either one is a run of IS frames
// (12-byte header, payload length at bytes 6..9), so the bodies are found
// by walking frames rather than by matching on how the capture happened to
// split them.

import { readFileSync } from "node:fs";
import type { DerivedCapabilities } from "../derivation.js";

export interface CapabilityBodies {
  info: Buffer;
  capa: Buffer;
}

interface RawEvent {
  dir?: string;
  hex?: string;
  hook?: string;
  payload_hex?: string;
}

/**
 * Every committed ESC/I-2 replay fixture that records INIT1, with the source
 * the session was recorded scanning from. The DS-575W colour oracle is a
 * PARA-only excerpt with no INIT1, so it is left out.
 */
export const REPLAY_FIXTURES: ReadonlyArray<{
  model: string;
  path: string;
  source: "flatbed" | "adf";
}> = (
  [
    ["ET-4950 family", "frida-capture/captures/2026-04-24T08-56-07-adf-1p-simplex", "adf"],
    ["ET-4950 family", "frida-capture/captures/2026-04-24T08-58-29-adf-1p-duplex", "adf"],
    ["ET-4950 family", "frida-capture/captures/2026-04-24T08-59-52-adf-3p-simplex", "adf"],
    ["ET-4950 family", "frida-capture/captures/2026-04-24T09-01-34-adf-3p-duplex", "adf"],
    ["ET-4950 family", "frida-capture/captures/2026-04-24T09-03-58-adf-1p-simplex-pdf", "adf"],
    ["ET-4950 family", "frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg", "flatbed"],
    ["ET-4950 family", "frida-capture/captures/2026-04-24T09-06-37-flatbed-1p-pdf", "flatbed"],
    ["ET-2750", "pcap-extract/captures/et-2750/flatbed-single-page-pdf", "flatbed"],
    ["XP-7100", "pcap-extract/captures/xp-7100/jpg-adf-duplex", "adf"],
    ["XP-7100", "pcap-extract/captures/xp-7100/jpg-adf-simplex", "adf"],
    ["XP-7100", "pcap-extract/captures/xp-7100/jpg-flatbed", "flatbed"],
    ["ET-4800", "pcap-extract/captures/et-4800/adf-jpg", "adf"],
    ["ET-4800", "pcap-extract/captures/et-4800/adf-pdf", "adf"],
    ["ET-4800", "pcap-extract/captures/et-4800/flatbed-jpg", "flatbed"],
    ["ET-4800", "pcap-extract/captures/et-4800/flatbed-pdf", "flatbed"],
    ["ET-7700", "pcap-extract/captures/et-7700/flatbed-jpg", "flatbed"],
    ["ET-7700", "pcap-extract/captures/et-7700/flatbed-pdf", "flatbed"],
    ["FF-680W", "pcap-extract/captures/ff-680w/adf-duplex-200", "adf"],
    ["FF-680W", "pcap-extract/captures/ff-680w/adf-simplex-200", "adf"],
    ["FF-680W", "pcap-extract/captures/ff-680w/adf-simplex-300", "adf"],
    ["DS-575W", "pcap-extract/captures/ds-575w/adf-duplex-600-mono-jpg", "adf"],
    ["DS-575W", "pcap-extract/captures/ds-575w/adf-simplex-400-mono-jpg", "adf"],
  ] as const
).map(([model, file, source]) => ({ model, path: `tools/${file}.jsonl`, source }));

const payloadCache = new Map<string, Buffer[]>();

/**
 * The printer→host IS frame payloads of a fixture, in order. Cached per path:
 * several tests read the same multi-megabyte fixtures.
 */
function readPrinterPayloads(path: string): Buffer[] {
  const cached = payloadCache.get(path);
  if (cached) return cached;
  const chunks: Buffer[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const e = JSON.parse(line) as RawEvent;
    if (e.dir === "p>h" && e.hex !== undefined) chunks.push(Buffer.from(e.hex, "hex"));
    if (e.hook === "recv" && e.payload_hex !== undefined) {
      chunks.push(Buffer.from(e.payload_hex, "hex"));
    }
  }
  const stream = Buffer.concat(chunks);

  const payloads: Buffer[] = [];
  for (let off = 0; off + 12 <= stream.length; ) {
    if (stream.toString("latin1", off, off + 2) !== "IS") {
      throw new Error(`readPrinterPayloads: IS framing lost at byte ${off} of ${path}`);
    }
    const length = stream.readUInt32BE(off + 6);
    // A capture may stop mid-frame; INIT1 is long past by then, and a cut
    // body still fails firstReply's length check.
    if (off + 12 + length > stream.length) break;
    payloads.push(stream.subarray(off + 12, off + 12 + length));
    off += 12 + length;
  }
  payloadCache.set(path, payloads);
  return payloads;
}

/**
 * The reply header naming `cmd` ("INFO", "CAPA", "STAT"), the length it
 * declares ("INFOx" + 7 hex digits), and the body: the next non-empty frame,
 * since the session ignores empty 0xa000 frames too. The body is null when
 * the header declares zero length.
 */
function firstReply(
  payloads: Buffer[],
  cmd: string,
  path: string,
): { header: Buffer; body: Buffer | null } {
  const i = payloads.findIndex((p) => p.toString("latin1", 0, 5) === `${cmd}x`);
  if (i < 0) throw new Error(`firstReply: no ${cmd} reply in ${path}`);
  const header = payloads[i];
  const declared = parseInt(header.toString("latin1", 5, 12), 16);
  if (declared === 0) return { header, body: null };
  const body = payloads.slice(i + 1).find((p) => p.length > 0);
  if (body?.length !== declared || body[0] !== 0x23) {
    throw new Error(
      `firstReply: ${cmd} body in ${path} is ${body?.length ?? 0} bytes ` +
        `(header declares ${declared}) or doesn't start with '#'`,
    );
  }
  return { header, body };
}

export function readInit1Bodies(path: string): CapabilityBodies {
  // The first INFO and CAPA replies are INIT1's.
  const payloads = readPrinterPayloads(path);
  const body = (cmd: string): Buffer => {
    const reply = firstReply(payloads, cmd, path);
    if (reply.body === null) throw new Error(`readInit1Bodies: empty ${cmd} reply in ${path}`);
    return reply.body;
  };
  return { info: body("INFO"), capa: body("CAPA") };
}

/**
 * The first init-poll STAT reply: the session's first STAT, since INIT1 and
 * INIT2 send none. `body` is null for a zero-length reply.
 */
export function readFirstInitPollStatus(path: string): { header: Buffer; body: Buffer | null } {
  return firstReply(readPrinterPayloads(path), "STAT", path);
}

// Models with no replay fixture: the facts their reporters posted in the
// unsupported-printer diagnostic block. A diagnostic carries only the lists,
// the duplex flag and the scan areas (and older blocks have no CCT line), so
// INFO and CAPA bodies are rebuilt from the lines present
// (bodiesFromDiagnostic), and only the fields they determine are checked.
export const DIAGNOSTICS: ReadonlyArray<{
  model: string;
  issue: number;
  fp: string;
  block: string;
}> = [
  {
    model: "ET-2950",
    issue: 92,
    fp: "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
Scan area (FB):    d850i0001170
Scan area (ADF):   (absent)
QIT list:          PREFON  OFF`,
  },
  {
    model: "ET-15000",
    issue: 106,
    fp: "d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55",
    block: `
Source caps:       flatbed: Y  ADF: Y  duplex: N
Scan area (FB):    d850i0001400
Scan area (ADF):   d850i0001400
QIT list:          (absent)
CCT list:          (absent)`,
  },
  {
    model: "ET-2810",
    issue: 132,
    fp: "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
Scan area (FB):    d850i0001170
Scan area (ADF):   (absent)
QIT list:          (absent)
CCT list:          (absent)`,
  },
  {
    model: "ET-8500",
    issue: 120,
    fp: "05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
Scan area (FB):    d850i0001170
Scan area (ADF):   (absent)
QIT list:          PREFON  OFF
CCT list:          (absent)`,
  },
  {
    model: "WF-3835",
    issue: 174,
    fp: "860a899be9dc4fc27b68f8aed21a49ccfe87733a3974813f0c2ade6810e89dc7",
    block: `
Source caps:       flatbed: Y  ADF: Y  duplex: N
Scan area (FB):    d850i0001170
Scan area (ADF):   d850i0001400
QIT list:          PREFON  OFF
CCT list:          (absent)`,
  },
];

/**
 * INFO and CAPA bodies rebuilt from a diagnostic block, and the derived
 * fields those lines determine.
 */
export function bodiesFromDiagnostic(block: string): CapabilityBodies & {
  fields: (keyof DerivedCapabilities)[];
} {
  const infoSegments: string[] = [];
  const capaSegments: string[] = [];
  const fields: (keyof DerivedCapabilities)[] = [];
  const fbArea = block.match(/^Scan area \(FB\): +(.+)$/m);
  const adfArea = block.match(/^Scan area \(ADF\): +(.+)$/m);
  if (fbArea && fbArea[1] !== "(absent)") infoSegments.push("#FB AREA" + fbArea[1]);
  if (adfArea && adfArea[1] !== "(absent)") infoSegments.push("#ADFAREA" + adfArea[1]);
  const duplex = block.match(/duplex: ([YN])/);
  // ADF duplex also needs an ADF scan area, so it is determined only with both lines.
  if (duplex && adfArea) {
    fields.push("adfDuplex");
    if (duplex[1] === "Y") capaSegments.push("#ADFDPLX");
  }
  for (const [label, token, field] of [
    ["QIT", "#QITLIST", "qit"],
    ["CCT", "#CCTLIST", "cct"],
  ] as const) {
    const line = block.match(new RegExp(`^${label} list: +(.+)$`, "m"));
    if (!line) continue;
    fields.push(field);
    if (line[1] !== "(absent)") capaSegments.push(token + line[1]);
  }
  if (fbArea && adfArea) fields.push("sources", "sourceDetection");
  // A printer with a flatbed is never adf-crp, whatever its ADF lists.
  if (fbArea && fbArea[1] !== "(absent)") fields.push("paraProfile");
  return {
    info: Buffer.from(infoSegments.join(""), "ascii"),
    capa: Buffer.from(capaSegments.join(""), "ascii"),
    fields,
  };
}
