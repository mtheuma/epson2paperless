import { describe, it, expect } from "vitest";
import { collectImagePixels, parseRenderArgs } from "./render.js";
import type { RawPacket } from "../pcap-extract/extract.js";

describe("parseRenderArgs", () => {
  it("parses positionals plus --stream/--width/--height flags", () => {
    const args = parseRenderArgs([
      "cap.pcap",
      "flatbed",
      "jpg",
      "/out",
      "--stream",
      "1",
      "--width",
      "2481",
      "--height",
      "3507",
    ]);
    expect(args).toEqual({
      pcapPath: "cap.pcap",
      source: "flatbed",
      format: "jpg",
      outputDir: "/out",
      tcpStream: 1,
      widthPx: 2481,
      heightPx: 3507,
    });
  });

  it("leaves the flags undefined when absent", () => {
    const args = parseRenderArgs(["cap.pcap", "flatbed", "jpg", "/out"]);
    expect(args).toEqual({
      pcapPath: "cap.pcap",
      source: "flatbed",
      format: "jpg",
      outputDir: "/out",
      tcpStream: undefined,
      widthPx: undefined,
      heightPx: undefined,
    });
  });
});

function isFrame(type: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(12);
  h[0] = 0x49;
  h[1] = 0x53;
  h.writeUInt16BE(type, 2);
  h.writeUInt16BE(0x300c, 4);
  h.writeUInt32BE(payload.length, 6);
  return Buffer.concat([h, payload]);
}

const pkt = (dir: "h>p" | "p>h", ts: number, seq: number, payload: Buffer): RawPacket => ({
  dir,
  ts,
  seq,
  payload,
});

describe("collectImagePixels", () => {
  it("collects 0xa200 pixel bytes minus each chunk's status byte, across segment boundaries and control frames", () => {
    const px1 = Buffer.from([1, 2, 3, 4]);
    const px2 = Buffer.from([5, 6]);
    const chunk1 = isFrame(0xa200, Buffer.concat([Buffer.from([0x20]), px1]));
    const ctrl = isFrame(0xa000, Buffer.from([0x06]));
    const chunk2 = isFrame(0xa200, Buffer.concat([Buffer.from([0x20]), px2]));
    const pixels = collectImagePixels([
      // chunk1 split mid-header across two segments — framing must survive
      pkt("p>h", 0.0, 1, chunk1.subarray(0, 5)),
      pkt("p>h", 0.1, 6, chunk1.subarray(5)),
      pkt("h>p", 0.2, 1, Buffer.from([0x1b, 0x40])), // host bytes are not printer stream
      // a control frame and the next image chunk packed into one segment
      pkt("p>h", 0.3, 1 + chunk1.length, Buffer.concat([ctrl, chunk2])),
    ]);
    expect(pixels).toEqual(Buffer.concat([px1, px2]));
  });

  it("deduplicates a retransmitted printer segment instead of feeding its bytes twice", () => {
    const px = Buffer.from([1, 2, 3, 4]);
    const chunk = isFrame(0xa200, Buffer.concat([Buffer.from([0x20]), px]));
    const pixels = collectImagePixels([
      pkt("h>p", 0.0, 1, Buffer.from([0x1b, 0x40])),
      pkt("p>h", 0.1, 1, chunk),
      pkt("p>h", 0.5, 1, chunk), // retransmit of the same seq range
    ]);
    expect(pixels).toEqual(px);
  });

  it("renders through a host-direction capture gap — only the printer stream carries pixels", () => {
    const px = Buffer.from([1, 2, 3, 4]);
    const chunk = isFrame(0xa200, Buffer.concat([Buffer.from([0x20]), px]));
    const pixels = collectImagePixels([
      pkt("h>p", 0.0, 1, Buffer.from([0x1b, 0x40])),
      pkt("h>p", 0.2, 500, Buffer.from([0x1b, 0x65])), // gap: seq 3..499 never captured
      pkt("p>h", 0.1, 1, chunk),
    ]);
    expect(pixels).toEqual(px);
  });

  it("throws on a truncated trailing frame instead of silently rendering a partial stream", () => {
    const chunk = isFrame(0xa200, Buffer.from([0x20, 1, 2, 3]));
    expect(() => collectImagePixels([pkt("p>h", 0, 1, chunk.subarray(0, 8))])).toThrow(/leftover/);
  });
});
