import { describe, it, expect } from "vitest";
import { buildFsY, buildFsX, buildFsZ } from "../commands-fs.js";
import {
  buildEsci2Command,
  buildParaHeader,
  parseEsci2ReplyHeader,
  parseTokens,
} from "./commands.js";

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
