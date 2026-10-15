// src/esci2/test-support/capability-bodies.ts
//
// Recovers the INIT1 INFO and CAPA reply bodies from a committed ESC/I-2
// replay fixture, for tests that check capability derivation against the
// printers we have recordings of.
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

/** Fixture paths, one per ESC/I-2 model with a committed replay fixture. */
export const FIXTURE_MODELS: ReadonlyArray<{ model: string; path: string }> = [
  {
    model: "ET-4950 family",
    path: "tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl",
  },
  { model: "ET-2750", path: "tools/pcap-extract/captures/et-2750/flatbed-single-page-pdf.jsonl" },
  { model: "XP-7100", path: "tools/pcap-extract/captures/xp-7100/jpg-flatbed.jsonl" },
  { model: "ET-4800", path: "tools/pcap-extract/captures/et-4800/flatbed-jpg.jsonl" },
  { model: "ET-7700", path: "tools/pcap-extract/captures/et-7700/flatbed-jpg.jsonl" },
  { model: "FF-680W", path: "tools/pcap-extract/captures/ff-680w/adf-simplex-200.jsonl" },
  { model: "DS-575W", path: "tools/pcap-extract/captures/ds-575w/adf-simplex-400-mono-jpg.jsonl" },
];

export function readInit1Bodies(path: string): CapabilityBodies {
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
      throw new Error(`readInit1Bodies: IS framing lost at byte ${off} of ${path}`);
    }
    const length = stream.readUInt32BE(off + 6);
    payloads.push(stream.subarray(off + 12, off + 12 + length));
    off += 12 + length;
  }

  // The first INFO and CAPA reply headers are INIT1's; the body is the
  // payload of the frame that follows each header.
  const bodyAfter = (cmd: string): Buffer => {
    const i = payloads.findIndex((p) => p.toString("latin1", 0, 5) === `${cmd}x`);
    if (i < 0 || i + 1 >= payloads.length) {
      throw new Error(`readInit1Bodies: no ${cmd} reply in ${path}`);
    }
    return payloads[i + 1];
  };
  return { info: bodyAfter("INFO"), capa: bodyAfter("CAPA") };
}
