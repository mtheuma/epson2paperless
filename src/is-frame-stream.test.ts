import { describe, it, expect } from "vitest";
import { createIsFrameReader, type IsFrame } from "./is-frame-stream.js";

function isFrame(type: number, payloadBytes: number, fill = 0xb0): Buffer {
  const h = Buffer.alloc(12);
  h[0] = 0x49;
  h[1] = 0x53;
  h.writeUInt16BE(type, 2);
  h.writeUInt16BE(0x300c, 4);
  h.writeUInt32BE(payloadBytes, 6);
  return Buffer.concat([h, Buffer.alloc(payloadBytes, fill)]);
}
function collect(chunks: Buffer[]): IsFrame[] {
  const r = createIsFrameReader();
  const out: IsFrame[] = [];
  for (const c of chunks) r.feed(c, (f) => out.push(f));
  r.finish();
  return out;
}

describe("createIsFrameReader", () => {
  it("reassembles a frame whose header is split across feeds", () => {
    const f = isFrame(0xa200, 253063);
    const out = collect([f.subarray(0, 6), f.subarray(6)]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(0xa200);
    expect(out[0].payload.length).toBe(253063);
  });
  it("splits two frames packed into one feed", () => {
    const out = collect([Buffer.concat([isFrame(0xa200, 253063), isFrame(0xa200, 37216)])]);
    expect(out.map((f) => f.payload.length)).toEqual([253063, 37216]);
  });
  it("does not false-trigger on a plausible IS-0xa200 header inside a payload", () => {
    // Embed the FULL sequence the old heuristic scanned for — "IS" a200 + a
    // plausible BE u32 size — inside the pixel payload. A magic-scanning parser
    // would mis-split here; the length-walking reader must treat it as pixels.
    const evil = isFrame(0xa200, 40);
    Buffer.from("4953a200000003e8", "hex").copy(evil, 12); // IS a200 size=1000 at payload start
    const out = collect([evil]);
    expect(out).toHaveLength(1);
    expect(out[0].payload.length).toBe(40);
  });
  it("reassembles a split control frame", () => {
    const ack = isFrame(0xa000, 1, 0x06);
    const out = collect([ack.subarray(0, 8), ack.subarray(8)]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(0xa000);
  });
  it("throws on leftover partial bytes at finish", () => {
    const r = createIsFrameReader();
    r.feed(isFrame(0xa200, 100).subarray(0, 50), () => {});
    expect(() => r.finish()).toThrow(/leftover/);
  });
});
