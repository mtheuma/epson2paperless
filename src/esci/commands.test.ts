import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GAMMA_LUT_R, GAMMA_LUT_G, GAMMA_LUT_B } from "./luts.js";

describe("esci-legacy gamma LUTs", () => {
  it("each LUT is exactly 256 bytes", () => {
    expect(GAMMA_LUT_R.length).toBe(256);
    expect(GAMMA_LUT_G.length).toBe(256);
    expect(GAMMA_LUT_B.length).toBe(256);
  });

  it("each LUT matches its captured bytes (sha256-pinned)", () => {
    // If a LUT looks like it has a typo, it isn't — these are the firmware's
    // intentional perturbations and the printer accepts them verbatim.
    // Re-derive from .reference/wireshark-captures/wf-3620/flatbed-single-page-jpeg.pcap
    // before changing.
    const r = createHash("sha256").update(GAMMA_LUT_R).digest("hex");
    const g = createHash("sha256").update(GAMMA_LUT_G).digest("hex");
    const b = createHash("sha256").update(GAMMA_LUT_B).digest("hex");
    expect(r).toBe("50ac30203a5e8fe992581443ee85b9ac84aef9e1d6a386b6c7c59fc9c5a3c040");
    expect(g).toBe("6c94050b612bf6c2e325179f23c98fa950ffdfc01c25aa5fbd921343ba1f8636");
    expect(b).toBe("40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880");
  });
});

import {
  buildEscInit,
  buildFsI,
  buildFsF,
  buildEscE,
  buildFsG,
  buildEscCleanup,
  buildPageEject,
  buildEscZ,
  buildEscI,
  buildEscLowerI,
  buildEscE2,
} from "./commands.js";

describe("esci-legacy command builders", () => {
  it("ESC @ (init) is 2 bytes 1b 40", () => {
    expect(buildEscInit()).toEqual(Buffer.from([0x1b, 0x40]));
  });

  it("FS I (identity) is 2 bytes 1c 49", () => {
    expect(buildFsI()).toEqual(Buffer.from([0x1c, 0x49]));
  });

  it("FS F (status) is 2 bytes 1c 46", () => {
    expect(buildFsF()).toEqual(Buffer.from([0x1c, 0x46]));
  });

  it("ESC e (set source) is 2 bytes 1b 65 (param sent separately)", () => {
    expect(buildEscE()).toEqual(Buffer.from([0x1b, 0x65]));
  });

  it("FS G (start) is 2 bytes 1c 47", () => {
    expect(buildFsG()).toEqual(Buffer.from([0x1c, 0x47]));
  });

  it("ESC ) (cleanup) is 2 bytes 1b 29", () => {
    expect(buildEscCleanup()).toEqual(Buffer.from([0x1b, 0x29]));
  });

  it("page-eject is 2 bytes 0c 00", () => {
    expect(buildPageEject()).toEqual(Buffer.from([0x0c, 0x00]));
  });

  it("ESC z (gamma load command, channel R) is 2 bytes 1b 7a", () => {
    expect(buildEscZ()).toEqual(Buffer.from([0x1b, 0x7a]));
  });

  it("XP-620 setup opcodes", () => {
    expect([...buildEscI()]).toEqual([0x1b, 0x49]);
    expect([...buildEscLowerI()]).toEqual([0x1b, 0x69]);
    expect([...buildEscE2()]).toEqual([0x1b, 0xe2]);
  });
});

import { buildFsWBlock } from "./commands.js";

describe("esci-legacy FS W block", () => {
  // Reference bytes captured verbatim from the six pcaps.
  const FLATBED_JPEG =
    "58020000580200000000000000000000" +
    "5c1300005a1b00001308000004040001" +
    "00000000000000000000000000000000" +
    "00000000000000000000000000000000";
  const FLATBED_PDF =
    "2c0100002c0100000000000000000000" +
    "ae090000ad0d00001308000008040001" +
    "00000000000000000000000000000000" +
    "00000000000000000000000000000000";
  const ADF_SIMPLEX_JPEG =
    "58020000580200008e000000000000005c1300005a1b000013080100040400010000000000000000000000000000000000000000000000000000000000000000";
  const ADF_DUPLEX_JPEG =
    "58020000580200008e000000000000005c1300005a1b000013080200040400010000000000000000000000000000000000000000000000000000000000000000";
  const ADF_SIMPLEX_PDF =
    "2c0100002c0100004700000000000000ae090000ad0d000013080100080400010000000000000000000000000000000000000000000000000000000000000000";

  it("flatbed JPEG matches the captured bytes", () => {
    const block = buildFsWBlock({ source: "flatbed", format: "jpg" });
    expect(block.toString("hex")).toBe(FLATBED_JPEG.replaceAll(/\s/g, ""));
    expect(block.length).toBe(64);
  });

  it("flatbed PDF matches the captured bytes", () => {
    const block = buildFsWBlock({ source: "flatbed", format: "pdf" });
    expect(block.toString("hex")).toBe(FLATBED_PDF.replaceAll(/\s/g, ""));
  });

  it("ADF simplex JPEG matches", () => {
    const block = buildFsWBlock({ source: "adf-simplex", format: "jpg" });
    expect(block.toString("hex")).toBe(ADF_SIMPLEX_JPEG);
  });

  it("ADF duplex JPEG matches", () => {
    const block = buildFsWBlock({ source: "adf-duplex", format: "jpg" });
    expect(block.toString("hex")).toBe(ADF_DUPLEX_JPEG);
  });

  it("ADF simplex PDF matches", () => {
    const block = buildFsWBlock({ source: "adf-simplex", format: "pdf" });
    expect(block.toString("hex")).toBe(ADF_SIMPLEX_PDF);
  });
});

import { parseFsGReply, type FsGReply } from "./commands.js";

describe("esci-legacy FS G reply parser", () => {
  // Reproduced from .reference/wireshark-captures/wf-3620/flatbed-single-page-jpeg.pcap
  // (frame 209, printer→host, 14 bytes).
  const REPLY_HEX = "021250e80000d606000028740000";

  it("parses status word, block size, block count, and the last block's byte count", () => {
    const out = parseFsGReply(Buffer.from(REPLY_HEX, "hex"));
    expect(out).toEqual({
      statusWord: 0x0212,
      chunkSize: 59472, // 4 lines of 4956 px × 3 bytes
      blockCount: 1750,
      lastBlockBytes: 29736, // the 2 lines left over: 7002 = 1750 × 4 + 2
    });
  });

  it("throws on a reply that's not 14 bytes", () => {
    expect(() => parseFsGReply(Buffer.alloc(13))).toThrow(/14 bytes/);
  });
});

import { parseFsIReply } from "./commands.js";
import { buildFsIReply } from "./test-support/fs-i-reply.js";

describe("esci-legacy FS I reply parser", () => {
  // The WF-3620's 80-byte FS I reply, from
  // tools/pcap-extract/captures/wf-3620/flatbed-single-page-jpeg.jsonl line 10.
  const WF3620_REPLY_HEX =
    "44370000b00400004b000000b0040000f07f0000d8270000d8360000d8270000a041000000000000" +
    "00000000112050494420303842382020202020202020312e32301008000000000000000000000000";

  it("decodes the WF-3620's PID and firmware", () => {
    expect(parseFsIReply(Buffer.from(WF3620_REPLY_HEX, "hex"))).toEqual({
      productName: "PID 08B8",
      firmware: "1.20",
    });
  });

  it("canonicalises the PID the same way as the push-scan trigger", () => {
    expect(parseFsIReply(buildFsIReply("pid 08c8", "1.10")).productName).toBe("PID 08C8");
  });

  it("keeps a non-PID product name as trimmed text, NUL padding included", () => {
    expect(parseFsIReply(buildFsIReply("WF-9999", "1.00", "\0")).productName).toBe("WF-9999");
  });

  it("escapes bytes outside printable ASCII, so a log line can't carry them raw", () => {
    const buf = buildFsIReply("", "");
    Buffer.from([0x41, 0x1b, 0x5b, 0x0a, 0xff, 0x00, 0x42]).copy(buf, 46);
    expect(parseFsIReply(buf).productName).toBe("A\\x1b[\\x0a\\xff\\x00B");
  });

  it("returns null for blank fields", () => {
    expect(parseFsIReply(Buffer.alloc(80))).toEqual({ productName: null, firmware: null });
  });

  it("throws on a reply that's not 80 bytes", () => {
    expect(() => parseFsIReply(Buffer.alloc(16))).toThrow(/80 bytes/);
  });
});

import { buildStreamConfigPayload } from "./commands.js";

describe("esci-legacy IS-0x2200 stream-config payload", () => {
  // Reference bytes verified against capture frames 210+212 (JPEG)
  // and frames 198+200 (PDF) from the respective pcap files.
  // The 0x1e constant sits at byte index 3 (BE u32 at offset 0), not index 6
  // as the plan's comment suggested — capture is ground truth.
  it("JPEG mode payload matches the captured 38 bytes", () => {
    const reply = parseFsGReply(Buffer.from("021250e80000d606000028740000", "hex"));
    const payload = buildStreamConfigPayload(reply, "jpg");
    expect(payload.length).toBe(38);
    expect(payload.toString("hex")).toBe(
      "0000001e00000000" + "000006d6000000000000e851000000010000e85106000000010000742906",
    );
  });

  it("PDF mode payload matches the captured 38 bytes", () => {
    const reply = parseFsGReply(Buffer.from("021250e80000b501000032910000", "hex"));
    const payload = buildStreamConfigPayload(reply, "pdf");
    expect(payload.toString("hex")).toBe(
      "0000001e00000000" + "000001b5000000000000e851000000010000e85106000000010000913306",
    );
  });
});

import { ET_FSW_BLOCK, ET_STREAM_CONFIG } from "./dialects/et2550-data.js";
import { XP_FSW_BLOCK, XP_STREAM_CONFIG } from "./dialects/xp620-data.js";

describe("esci-legacy block layout across FS W, FS G and the stream config", () => {
  // FS G replies and raster sizes as captured on each model (see the legacy
  // fixtures under tools/pcap-extract/captures/). These pin that the fields
  // agree on captured data; the WF-3620's last-block size is a per-format
  // constant that happens to equal its captured reply's lastBlockBytes.
  const cases = [
    {
      name: "WF-3620 JPG (600 dpi)",
      fsw: buildFsWBlock({ source: "flatbed", format: "jpg" }),
      fsg: "021250e80000d606000028740000",
      streamConfig: (r: FsGReply) => buildStreamConfigPayload(r, "jpg"),
      widthPx: 4956,
      heightPx: 7002,
      linesPerBlock: 4,
    },
    {
      name: "WF-3620 PDF (300 dpi)",
      fsw: buildFsWBlock({ source: "flatbed", format: "pdf" }),
      fsg: "021250e80000b501000032910000",
      streamConfig: (r: FsGReply) => buildStreamConfigPayload(r, "pdf"),
      widthPx: 2478,
      heightPx: 3501,
      linesPerBlock: 8,
    },
    {
      name: "ET-2550",
      fsw: ET_FSW_BLOCK,
      fsg: "020210ef0000b60100006a950000",
      streamConfig: () => ET_STREAM_CONFIG,
      widthPx: 2550,
      heightPx: 3509,
      linesPerBlock: 8,
    },
    {
      name: "XP-620",
      fsw: XP_FSW_BLOCK,
      fsg: "020286dc0300670000005f910000",
      streamConfig: () => XP_STREAM_CONFIG,
      widthPx: 2481,
      heightPx: 3507,
      linesPerBlock: 34,
    },
  ];

  it.each(cases)("$name: FS W byte 28 is the scanline count of each full block", (c) => {
    const reply = parseFsGReply(Buffer.from(c.fsg, "hex"));
    expect(c.fsw[28]).toBe(c.linesPerBlock);
    expect(reply.chunkSize).toBe(c.linesPerBlock * c.widthPx * 3);
  });

  it.each(cases)("$name: the full blocks plus the last block cover the page", (c) => {
    const reply = parseFsGReply(Buffer.from(c.fsg, "hex"));
    expect(reply.blockCount * reply.chunkSize + reply.lastBlockBytes).toBe(
      c.widthPx * c.heightPx * 3,
    );
  });

  it.each(cases)(
    "$name: the stream config carries the block count, each block's size plus its status byte, and the last block's size plus one before the 0x06 terminator",
    (c) => {
      const reply = parseFsGReply(Buffer.from(c.fsg, "hex"));
      const sc = c.streamConfig(reply);
      expect(sc.readUInt32BE(8)).toBe(reply.blockCount);
      expect(sc.readUInt32BE(16)).toBe(reply.chunkSize + 1);
      expect(sc.readUInt32BE(24)).toBe(reply.chunkSize + 1);
      expect(sc.readUInt32BE(33)).toBe(reply.lastBlockBytes + 1);
      expect(sc[37]).toBe(0x06);
    },
  );
});

import { legacyDetectSource, fsFAdfInstalled } from "./commands.js";

describe("fsFAdfInstalled", () => {
  // FS F replies as captured in the committed legacy fixtures.
  it.each([
    ["WF-3620 flatbed, ready", "018000c0000000000000000000000000", true],
    ["WF-3620 flatbed, busy", "81e800c0000000000000000000000000", true],
    ["WF-3620 ADF, paper loaded", "01c000c0000000000000000000000000", true],
    ["WF-3620 ADF duplex", "01c100c0000000000000000000000000", true],
    ["WF-3620 ADF duplex, mid-feed", "03c100c0000000000000000000000000", true],
    ["WF-3620 ADF empty", "81e900c0000000000000000000000000", true],
    ["ET-2550", "010000c0000000000000000000000000", false],
    ["XP-620", "010000c0000000000000000000000000", false],
  ])("%s (%s) → ADF installed: %s", (_model, hex, expected) => {
    expect(fsFAdfInstalled(Buffer.from(hex, "hex"))).toBe(expected);
  });

  it("reads byte 1 bit 7, not byte 0's high bit", () => {
    const reply = (b0: number, b1: number) => Buffer.from([b0, b1, ...Array<number>(14).fill(0)]);
    expect(fsFAdfInstalled(reply(0x81, 0x7f))).toBe(false);
    expect(fsFAdfInstalled(reply(0x00, 0x80))).toBe(true);
  });
});

describe("legacyDetectSource", () => {
  it("0x81 + simplex → flatbed", () => {
    expect(legacyDetectSource(0x81, false)).toEqual({ ok: true, source: "flatbed" });
  });

  it("0x81 + duplex → flatbed (panel-says-duplex on glass is impossible; flatbed wins)", () => {
    expect(legacyDetectSource(0x81, true)).toEqual({ ok: true, source: "flatbed" });
  });

  it("0x01 + simplex → adf-simplex", () => {
    expect(legacyDetectSource(0x01, false)).toEqual({ ok: true, source: "adf-simplex" });
  });

  it("0x01 + duplex → adf-duplex", () => {
    expect(legacyDetectSource(0x01, true)).toEqual({ ok: true, source: "adf-duplex" });
  });

  it("0x00 + simplex → { ok: false, byte: 0x00 }", () => {
    expect(legacyDetectSource(0x00, false)).toEqual({ ok: false, byte: 0x00 });
  });

  it("0xFF + duplex → { ok: false, byte: 0xFF }", () => {
    expect(legacyDetectSource(0xff, true)).toEqual({ ok: false, byte: 0xff });
  });
});
