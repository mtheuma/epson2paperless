import { describe, it, expect } from "vitest";
import {
  buildFsY,
  buildFsX,
  buildFsZ,
  buildEsci2Command,
  buildParaHeader,
  buildParaPayload,
  parseEsci2ReplyHeader,
  parseTokens,
} from "./esci.js";

describe("buildFsY", () => {
  it("returns exactly the 2 bytes 0x1c 0x59", () => {
    expect(buildFsY().equals(Buffer.from([0x1c, 0x59]))).toBe(true);
  });
});

describe("buildFsX", () => {
  it("returns exactly the 2 bytes 0x1c 0x58", () => {
    expect(buildFsX().equals(Buffer.from([0x1c, 0x58]))).toBe(true);
  });
});

describe("buildFsZ", () => {
  it("returns the 2-byte legacy FS Z command", () => {
    expect(buildFsZ()).toEqual(Buffer.from([0x1c, 0x5a]));
  });
});

describe("buildEsci2Command", () => {
  it("builds a 12-byte header for a 4-char name", () => {
    expect(buildEsci2Command("STAT").toString("ascii")).toBe("STATx0000000");
    expect(buildEsci2Command("TRDT").toString("ascii")).toBe("TRDTx0000000");
    expect(buildEsci2Command("IMG ").toString("ascii")).toBe("IMG x0000000");
  });

  it("right-pads short names with spaces to 4 chars", () => {
    expect(buildEsci2Command("FIN").toString("ascii")).toBe("FIN x0000000");
    expect(buildEsci2Command("IMG").toString("ascii")).toBe("IMG x0000000");
  });

  it("returns exactly 12 bytes", () => {
    expect(buildEsci2Command("STAT").length).toBe(12);
    expect(buildEsci2Command("FIN").length).toBe(12);
  });
});

describe("buildParaHeader", () => {
  it("builds a 'PARAx<7-hex-length>' header — matches capture record 115 for length 0x3A8 (uppercase)", () => {
    const header = buildParaHeader(0x3a8);
    expect(header.toString("ascii")).toBe("PARAx00003A8");
    expect(header.length).toBe(12);
  });

  it("pads the hex length to 7 digits with uppercase hex (driver convention)", () => {
    expect(buildParaHeader(1).toString("ascii")).toBe("PARAx0000001");
    // 0xABCDEF = "ABCDEF" (uppercase in the driver's output), padded to 7 = "0ABCDEF"
    expect(buildParaHeader(0xabcdef).toString("ascii")).toBe("PARAx0ABCDEF");
  });
});

describe("buildParaPayload", () => {
  it("returns the 936-byte parameter block transcribed from the Frida capture", () => {
    const payload = buildParaPayload({ source: "adf", duplex: false });
    expect(payload.length).toBe(936);
    // Byte-exact expectation — matches Frida capture record 116 exactly.
    const expectedHex =
      "234144462352534d693030303033303023525353693030303033303023434f4c" +
      "4330323423464d544a504720234a50476430393023474d4d5547313023474d54" +
      "47524e2068313030000102030405060708090a0b0c0d0e0f1011121314151617" +
      "18191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353637" +
      "38393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f5051525354555657" +
      "58595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f7071727374757677" +
      "78797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f9091929394959697" +
      "98999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7" +
      "b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7" +
      "d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7" +
      "f8f9fafbfcfdfeff23474d545245442068313030000102030405060708090a0b" +
      "0c0d0e0f1011121315161718191a1b1c1d1e1f202122232425262728292a2b2c" +
      "2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c" +
      "4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c" +
      "6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c" +
      "8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabac" +
      "adaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c6c7c8c9cacb" +
      "cccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaeb" +
      "ecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff23474d54424c552068313030" +
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
      "20212223242425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e" +
      "3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e" +
      "5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e" +
      "7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e" +
      "9fa0a1a2a3a4a5a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
      "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
      "e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff" +
      "235149544f46462023434354434f4c2023504147643030302341435169303030" +
      "303036396930303030303030693030303234383169303030333530362342535a" +
      "6931303438353736";
    expect(payload.toString("hex")).toBe(expectedHex);
  });

  it("starts with the expected ASCII parameter tokens", () => {
    const payload = buildParaPayload({ source: "adf", duplex: false });
    // First 64 bytes are all printable ASCII
    const prefix = payload.subarray(0, 64).toString("ascii");
    expect(prefix).toContain("#ADF");
    expect(prefix).toContain("#RSMi0000300");
    expect(prefix).toContain("#RSSi0000300");
    expect(prefix).toContain("#COLC024");
    expect(prefix).toContain("#FMTJPG ");
  });

  it("ends with ACQ + BSZ parameter tokens", () => {
    const payload = buildParaPayload({ source: "adf", duplex: false });
    const suffix = payload.subarray(-64).toString("ascii");
    expect(suffix).toContain("#ACQi0000069i0000000i0002481i0003506");
    expect(suffix).toContain("#BSZi1048576");
  });

  it("returns the 940-byte duplex parameter block when duplex=true", () => {
    const payload = buildParaPayload({ source: "adf", duplex: true });
    expect(payload.length).toBe(940);
    // #ADFDPLX at offset 0 (hex 23 41 44 46 44 50 4c 58)
    expect(payload.subarray(0, 8).toString("hex")).toBe("2341444644504c58");
    // First 64 ASCII bytes should start with the full token and continue into #RSM
    const prefix = payload.subarray(0, 64).toString("ascii");
    expect(prefix.startsWith("#ADFDPLX#RSMi0000300")).toBe(true);
  });

  it("isolates the simplex→duplex difference to a 4-byte insertion at offset 4", () => {
    const simplex = buildParaPayload({ source: "adf", duplex: false });
    const duplex = buildParaPayload({ source: "adf", duplex: true });
    // Bytes 0..3 identical ("#ADF")
    expect(duplex.subarray(0, 4).equals(simplex.subarray(0, 4))).toBe(true);
    // Bytes 4..7 of duplex are "DPLX"; simplex byte 4 starts "#RSM"
    expect(duplex.subarray(4, 8).toString("ascii")).toBe("DPLX");
    // Everything after the insertion is byte-identical:
    //   simplex[4:] === duplex[8:]
    expect(duplex.subarray(8).equals(simplex.subarray(4))).toBe(true);
  });

  it("returns the 928-byte flatbed parameter block when source=flatbed", () => {
    const payload = buildParaPayload({ source: "flatbed", duplex: false });
    expect(payload.length).toBe(928);
    // Byte-exact expectation — matches Frida capture
    // 2026-04-24T09-05-08-flatbed-1p-jpg.jsonl record 191 (the PARA body).
    const expectedHex =
      "234642202352534d693030303033303023525353693030303033303023434f4c" +
      "4330323423464d544a504720234a50476430393023474d4d5547313023474d54" +
      "47524e2068313030000102030405060708090a0b0c0d0e0f1011121314151617" +
      "18191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353637" +
      "38393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f5051525354555657" +
      "58595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f7071727374757677" +
      "78797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f9091929394959697" +
      "98999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7" +
      "b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7" +
      "d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7" +
      "f8f9fafbfcfdfeff23474d545245442068313030000102030405060708090a0b" +
      "0c0d0e0f1011121315161718191a1b1c1d1e1f202122232425262728292a2b2c" +
      "2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c" +
      "4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c" +
      "6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c" +
      "8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabac" +
      "adaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c6c7c8c9cacb" +
      "cccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaeb" +
      "ecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff23474d54424c552068313030" +
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
      "20212223242425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e" +
      "3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e" +
      "5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e" +
      "7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e" +
      "9fa0a1a2a3a4a5a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
      "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
      "e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff" +
      "235149544f46462023434354434f4c2023414351693030303030303069303030" +
      "30303030693030303234383169303030333530362342535a6931303438353736";
    expect(payload.toString("hex")).toBe(expectedHex);
  });

  it("starts with #FB (no DPLX) and omits #PAG", () => {
    const payload = buildParaPayload({ source: "flatbed", duplex: false });
    // Source token at offset 0 is "#FB " (trailing space); no "#ADF".
    expect(payload.subarray(0, 4).toString("ascii")).toBe("#FB ");
    expect(payload.toString("ascii")).not.toContain("#ADF");
    // #PAGd000 absent (vs ADF which has it; this is the 8-byte size diff).
    expect(payload.toString("ascii")).not.toContain("#PAG");
  });

  it("carries a zero ACQ y-start offset (vs ADF's 0x69 lead-in)", () => {
    const payload = buildParaPayload({ source: "flatbed", duplex: false });
    expect(payload.toString("ascii")).toContain("#ACQi0000000i0000000i0002481i0003506");
  });

  it("ignores duplex=true with a warn log (physically impossible combo)", () => {
    // We don't have a logger-spy harness in this test file, so assert the
    // return value only — the warn is a defensive log, not a test contract.
    // Verify the combo still produces the 928-byte flatbed blob (same bytes
    // as duplex=false).
    const a = buildParaPayload({ source: "flatbed", duplex: false });
    const b = buildParaPayload({ source: "flatbed", duplex: true });
    expect(b.equals(a)).toBe(true);
  });
});

describe("parseEsci2ReplyHeader", () => {
  it("parses 'IMG x000025F' — length is the second hex field", () => {
    const body = Buffer.from("IMG x000025F#pst#typIMGA", "ascii");
    const parsed = parseEsci2ReplyHeader(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.cmd).toBe("IMG");
    expect(parsed!.length).toBe(0x25f);
  });

  it("parses 'STATx0000000' — length=0", () => {
    const body = Buffer.from("STATx0000000#---", "ascii");
    const parsed = parseEsci2ReplyHeader(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.cmd).toBe("STAT");
    expect(parsed!.length).toBe(0);
  });

  it("parses 'PARAx0000000' — length=0 and cmd name preserved", () => {
    const body = Buffer.from("PARAx0000000#parOK", "ascii");
    const parsed = parseEsci2ReplyHeader(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.cmd).toBe("PARA");
    expect(parsed!.length).toBe(0);
  });

  it("trims trailing spaces from 3-char command names", () => {
    const body = Buffer.from("FIN x0000000#---", "ascii");
    const parsed = parseEsci2ReplyHeader(body);
    expect(parsed!.cmd).toBe("FIN");
  });

  it("returns null for a body shorter than 12 bytes", () => {
    expect(parseEsci2ReplyHeader(Buffer.from("short", "ascii"))).toBeNull();
  });

  it("returns null when the 5th byte is not 'x'", () => {
    expect(parseEsci2ReplyHeader(Buffer.from("IMG Y000025F", "ascii"))).toBeNull();
  });

  it("returns null when the hex field contains non-hex chars", () => {
    expect(parseEsci2ReplyHeader(Buffer.from("IMG x00ZZ25F", "ascii"))).toBeNull();
  });
});

describe("parseTokens", () => {
  it("parses a tail with one valued token", () => {
    const tail = Buffer.from("#parOK", "ascii");
    const tokens = parseTokens(tail);
    expect(tokens.get("par")).toBe("OK");
  });

  it("parses multiple tokens with mixed valued and valueless markers", () => {
    const tail = Buffer.from("#pst#typIMGA#pen", "ascii");
    const tokens = parseTokens(tail);
    expect(tokens.has("pst")).toBe(true);
    expect(tokens.get("pst")).toBe("");
    expect(tokens.get("typ")).toBe("IMGA");
    expect(tokens.has("pen")).toBe(true);
    expect(tokens.get("pen")).toBe("");
  });

  it("preserves trailing padding in values (callers trim if needed)", () => {
    const tail = Buffer.from("#parOK  #---", "ascii");
    const tokens = parseTokens(tail);
    expect(tokens.get("par")).toBe("OK  ");
  });

  it("ignores parts shorter than 3 chars", () => {
    const tail = Buffer.from("##ab#cdeXX", "ascii");
    const tokens = parseTokens(tail);
    expect(tokens.has("ab")).toBe(false); // too short
    expect(tokens.get("cde")).toBe("XX");
  });

  it("returns an empty map for an empty tail", () => {
    expect(parseTokens(Buffer.alloc(0)).size).toBe(0);
  });
});
