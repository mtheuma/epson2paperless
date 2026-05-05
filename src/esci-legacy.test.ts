import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GAMMA_LUT_R, GAMMA_LUT_G, GAMMA_LUT_B } from "./esci-legacy-luts.js";

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
} from "./esci-legacy.js";

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
});

import { buildFsWBlock } from "./esci-legacy.js";

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

import { parseFsGReply } from "./esci-legacy.js";

describe("esci-legacy FS G reply parser", () => {
  // Reproduced from .reference/wireshark-captures/wf-3620/flatbed-single-page-jpeg.pcap
  // (frame 209, printer→host, 14 bytes).
  const REPLY_HEX = "021250e80000d606000028740000";

  it("parses status word, chunk size, bytes-per-line, and total lines", () => {
    const out = parseFsGReply(Buffer.from(REPLY_HEX, "hex"));
    expect(out.statusWord).toBe(0x0212);
    expect(out.chunkSize).toBe(0x0000e850);
    expect(out.bytesPerLine).toBe(0x000006d6);
    expect(out.totalLines).toBe(0x00007428);
  });

  it("throws on a reply that's not 14 bytes", () => {
    expect(() => parseFsGReply(Buffer.alloc(13))).toThrow(/14 bytes/);
  });
});

import { buildStreamConfigPayload } from "./esci-legacy.js";

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
    const reply = parseFsGReply(Buffer.from("021250e80000b501000028740000", "hex"));
    const payload = buildStreamConfigPayload(reply, "pdf");
    expect(payload.toString("hex")).toBe(
      "0000001e00000000" + "000001b5000000000000e851000000010000e85106000000010000913306",
    );
  });
});

import { legacyDetectSource } from "./esci-legacy.js";

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
