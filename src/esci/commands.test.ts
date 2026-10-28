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
    // Re-derive from the WF-3620 flatbed-single-page-jpeg capture before
    // changing (tools/pcap-extract/captures/wf-3620/).
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

import { fsWBlockFor } from "./dialects/entry.js";
import { WF3620_ENTRY } from "./dialects/wf3620.js";
import { ET2550_ENTRY } from "./dialects/et2550.js";
import { XP620_ENTRY } from "./dialects/xp620.js";
import { LEGACY_DIALECT_ENTRIES } from "./dialects/registry.js";

describe("esci-legacy FS W block", () => {
  // Reference bytes captured verbatim: the WF-3620's from its six pcaps, the
  // ET-2550's and XP-620's from their committed flatbed fixtures. Byte 28,
  // the lines per block, comes from linesPerBlock on each dialect's raster
  // width and transfer buffer.
  it.each([
    {
      name: "WF-3620 flatbed JPEG",
      entry: WF3620_ENTRY,
      mode: { source: "flatbed", format: "jpg" },
      hex:
        "58020000580200000000000000000000" +
        "5c1300005a1b00001308000004040001" +
        "00000000000000000000000000000000" +
        "00000000000000000000000000000000",
    },
    {
      name: "WF-3620 flatbed PDF",
      entry: WF3620_ENTRY,
      mode: { source: "flatbed", format: "pdf" },
      hex:
        "2c0100002c0100000000000000000000" +
        "ae090000ad0d00001308000008040001" +
        "00000000000000000000000000000000" +
        "00000000000000000000000000000000",
    },
    {
      name: "WF-3620 ADF simplex JPEG",
      entry: WF3620_ENTRY,
      mode: { source: "adf-simplex", format: "jpg" },
      hex: "58020000580200008e000000000000005c1300005a1b000013080100040400010000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      name: "WF-3620 ADF duplex JPEG",
      entry: WF3620_ENTRY,
      mode: { source: "adf-duplex", format: "jpg" },
      hex: "58020000580200008e000000000000005c1300005a1b000013080200040400010000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      name: "WF-3620 ADF simplex PDF",
      entry: WF3620_ENTRY,
      mode: { source: "adf-simplex", format: "pdf" },
      hex: "2c0100002c0100004700000000000000ae090000ad0d000013080100080400010000000000000000000000000000000000000000000000000000000000000000",
    },
    ...(["jpg", "pdf"] as const).map((format) => ({
      name: `ET-2550 flatbed ${format}`,
      entry: ET2550_ENTRY,
      mode: { source: "flatbed" as const, format },
      hex: "2c0100002c0100000000000000000000f6090000b50d000013080000080400010000000000000000000000000000000000000000000000000000000000000000",
    })),
    ...(["jpg", "pdf"] as const).map((format) => ({
      name: `XP-620 flatbed ${format}`,
      entry: XP620_ENTRY,
      mode: { source: "flatbed" as const, format },
      hex: "2c0100002c0100000000000000000000b1090000b30d000013080000220400000100000000000000000100000000000000000000000000000000000000000000",
    })),
  ] as const)("$name matches the captured bytes", ({ entry, mode, hex }) => {
    const block = fsWBlockFor(entry, mode);
    expect(block.length).toBe(64);
    expect(block.toString("hex")).toBe(hex);
  });

  // Lines per block is worked out from the raster width, so every block must
  // carry that same width (bytes 16-19) or byte 28 would describe another row.
  it.each(
    LEGACY_DIALECT_ENTRIES.flatMap((entry) =>
      (["flatbed", "adf-simplex", "adf-duplex"] as const).flatMap((source) =>
        (["jpg", "pdf"] as const).map((format) => ({ entry, mode: { source, format } })),
      ),
    ),
  )(
    "$entry.name $mode.source $mode.format: the block's width is the raster's",
    ({ entry, mode }) => {
      expect(fsWBlockFor(entry, mode).readUInt32LE(16)).toBe(entry.raster(mode).widthPx);
    },
  );
});

import { linesPerBlock } from "./commands.js";

describe("linesPerBlock", () => {
  // Expected counts are the FS W byte 28 values in the committed captures.
  it.each([
    ["WF-3620 JPG, 4956 px in 64 KiB → 4", 4956, 64 * 1024, 4],
    ["WF-3620 PDF, 2478 px in 64 KiB → 8", 2478, 64 * 1024, 8],
    ["ET-2550, 2550 px in 64 KiB → 8", 2550, 64 * 1024, 8],
    ["XP-620, 2481 px in 256 KiB (35 fit, rounded down to even) → 34", 2481, 256 * 1024, 34],
  ])("%s", (_name, widthPx, bufferBytes, expected) => {
    expect(linesPerBlock(widthPx, bufferBytes)).toBe(expected);
  });

  it("caps at 254, the largest even count that fits the one-byte field", () => {
    expect(linesPerBlock(100, 256 * 1024)).toBe(254);
  });

  it("returns exactly the count that fills the buffer when it is even", () => {
    // 2 rows of 3000 bytes in a 6000-byte buffer.
    expect(linesPerBlock(1000, 6000)).toBe(2);
  });

  it("throws when not even two rows fit the buffer", () => {
    expect(() => linesPerBlock(11000, 64 * 1024)).toThrow(/11000 px.*65536-byte/);
  });
});

import { parseFsGReply } from "./commands.js";

describe("esci-legacy FS G reply parser", () => {
  // Reproduced from the WF-3620 flatbed-single-page-jpeg capture
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

  it("canonicalises the PID the same way as the panel trigger", () => {
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

// The four committed legacy geometries: each model's captured FS G reply and
// the stream config it sent back (see the legacy fixtures under
// tools/pcap-extract/captures/).
const LEGACY_GEOMETRIES = [
  {
    name: "WF-3620 JPG (600 dpi)",
    entry: WF3620_ENTRY,
    mode: { source: "flatbed", format: "jpg" },
    fsg: "021250e80000d606000028740000",
    streamConfig: "0000001e00000000000006d6000000000000e851000000010000e85106000000010000742906",
  },
  {
    name: "WF-3620 PDF (300 dpi)",
    entry: WF3620_ENTRY,
    mode: { source: "flatbed", format: "pdf" },
    fsg: "021250e80000b501000032910000",
    streamConfig: "0000001e00000000000001b5000000000000e851000000010000e85106000000010000913306",
  },
  {
    name: "ET-2550",
    entry: ET2550_ENTRY,
    mode: { source: "flatbed", format: "jpg" },
    fsg: "020210ef0000b60100006a950000",
    streamConfig: "0000001e00000000000001b6000000000000ef11000000010000ef1106000000010000956b06",
  },
  {
    name: "XP-620",
    entry: XP620_ENTRY,
    mode: { source: "flatbed", format: "jpg" },
    fsg: "020286dc0300670000005f910000",
    streamConfig: "0000001e0000000000000067000000000003dc87000000010003dc8706000000010000916006",
  },
] as const;

describe("esci-legacy IS-0x2200 stream-config payload", () => {
  it.each(LEGACY_GEOMETRIES)(
    "$name: built from the FS G reply, matches the captured 38 bytes",
    ({ fsg, streamConfig }) => {
      const payload = buildStreamConfigPayload(parseFsGReply(Buffer.from(fsg, "hex")));
      expect(payload.length).toBe(38);
      expect(payload.toString("hex")).toBe(streamConfig);
    },
  );

  it("follows whatever layout the reply reports, not a fixed geometry", () => {
    const payload = buildStreamConfigPayload({
      statusWord: 0x0212,
      chunkSize: 0x00012345,
      blockCount: 0x00010002, // more than 16 bits' worth
      lastBlockBytes: 0x00000abc,
    });
    expect(payload.toString("hex")).toBe(
      "0000001e00000000" + "0001000200000000000123460000000100012346060000000100000abd06",
    );
  });
});

describe("esci-legacy block layout across FS W, FS G and the stream config", () => {
  it.each(LEGACY_GEOMETRIES)(
    "$name: FS W's lines per block is the scanline count of each full FS G block",
    ({ entry, mode, fsg }) => {
      const reply = parseFsGReply(Buffer.from(fsg, "hex"));
      const { widthPx } = entry.raster(mode);
      expect(reply.chunkSize).toBe(fsWBlockFor(entry, mode)[28] * widthPx * 3);
    },
  );

  it.each(LEGACY_GEOMETRIES)(
    "$name: the full blocks plus the last block cover the page",
    ({ entry, mode, fsg }) => {
      const reply = parseFsGReply(Buffer.from(fsg, "hex"));
      const { widthPx, heightPx } = entry.raster(mode);
      expect(reply.blockCount * reply.chunkSize + reply.lastBlockBytes).toBe(
        widthPx * heightPx * 3,
      );
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
