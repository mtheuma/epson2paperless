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
 * Every committed ESC/I-2 replay fixture that records INIT1. The DS-575W
 * colour oracle is a PARA-only excerpt with no INIT1, so it is left out.
 */
export const REPLAY_FIXTURES: ReadonlyArray<{ model: string; path: string }> = [
  ...[
    "2026-04-24T08-56-07-adf-1p-simplex",
    "2026-04-24T08-58-29-adf-1p-duplex",
    "2026-04-24T08-59-52-adf-3p-simplex",
    "2026-04-24T09-01-34-adf-3p-duplex",
    "2026-04-24T09-03-58-adf-1p-simplex-pdf",
    "2026-04-24T09-05-08-flatbed-1p-jpg",
    "2026-04-24T09-06-37-flatbed-1p-pdf",
  ].map((name) => ({
    model: "ET-4950 family",
    path: `tools/frida-capture/captures/${name}.jsonl`,
  })),
  ...(
    [
      ["ET-2750", "et-2750", ["flatbed-single-page-pdf"]],
      ["XP-7100", "xp-7100", ["jpg-adf-duplex", "jpg-adf-simplex", "jpg-flatbed"]],
      ["ET-4800", "et-4800", ["adf-jpg", "adf-pdf", "flatbed-jpg", "flatbed-pdf"]],
      ["ET-7700", "et-7700", ["flatbed-jpg", "flatbed-pdf"]],
      ["FF-680W", "ff-680w", ["adf-duplex-200", "adf-simplex-200", "adf-simplex-300"]],
      ["DS-575W", "ds-575w", ["adf-duplex-600-mono-jpg", "adf-simplex-400-mono-jpg"]],
    ] as const
  ).flatMap(([model, dir, names]) =>
    names.map((name) => ({ model, path: `tools/pcap-extract/captures/${dir}/${name}.jsonl` })),
  ),
];

/** The printer→host IS frame payloads of a fixture, in order. */
function readPrinterPayloads(path: string): Buffer[] {
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
