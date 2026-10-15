import { describe, it, expect } from "vitest";
import { parseCapaTokens, parseInfoTokens, parseStatErrors } from "./capabilities.js";
import { REPLAY_FIXTURES, readInit1Bodies } from "./test-support/capability-bodies.js";

describe("parseInfoTokens", () => {
  it("extracts PRD PID and firmware from an XP-7100-style INFO body", () => {
    // Hand-built ASCII shape matching the wire format Epson uses.
    const info = Buffer.from("#PRDh010PID 1147        #VERh008FB  2.00", "ascii");
    const parsed = parseInfoTokens(info);
    expect(parsed.prdPid).toBe("1147");
    expect(parsed.firmware).toBe("FB  2.00");
  });

  it("returns null fields for tokens that aren't present", () => {
    const info = Buffer.from("#FB ALGNLEFT#FB AREAd850i0001170", "ascii");
    const parsed = parseInfoTokens(info);
    expect(parsed.prdPid).toBeNull();
    expect(parsed.prdName).toBeNull();
    expect(parsed.firmware).toBeNull();
  });

  it("parses a PID-form PRD to a PID and no name", () => {
    const parsed = parseInfoTokens(Buffer.from("#PRDh010PID 11D1        #VERh008FB  2.00"));
    expect(parsed.prdPid).toBe("11D1");
    expect(parsed.prdName).toBeNull();
  });

  it("canonicalises the PID's hex casing and spacing", () => {
    expect(parseInfoTokens(Buffer.from("#PRDh010PID 11d1        ")).prdPid).toBe("11D1");
    expect(parseInfoTokens(Buffer.from("#PRDh008PID11D1 ")).prdPid).toBe("11D1");
  });

  // The FF-680W and DS-575W shape: the length field counts the name alone,
  // and a NUL pad byte follows it.
  it("parses a name-form PRD to a product name and no PID", () => {
    const parsed = parseInfoTokens(Buffer.from("#PRDh007FF-680W\0#VERh008ADF 1.00", "latin1"));
    expect(parsed.prdName).toBe("FF-680W");
    expect(parsed.prdPid).toBeNull();
    expect(parsed.firmware).toBe("ADF 1.00");
  });

  it.each(REPLAY_FIXTURES)("parses the $model fixture's PRD ($path)", ({ model, path }) => {
    const parsed = parseInfoTokens(readInit1Bodies(path).info);
    const expected: Record<string, { prdPid: string | null; prdName: string | null }> = {
      "ET-4950 family": { prdPid: "11D1", prdName: null },
      "ET-2750": { prdPid: "112A", prdName: null },
      "XP-7100": { prdPid: "1147", prdName: null },
      "ET-4800": { prdPid: "1185", prdName: null },
      "ET-7700": { prdPid: "112B", prdName: null },
      "FF-680W": { prdPid: null, prdName: "FF-680W" },
      "DS-575W": { prdPid: null, prdName: "DS-575W" },
    };
    expect({ prdPid: parsed.prdPid, prdName: parsed.prdName }).toEqual(expected[model]);
  });
});

describe("parseCapaTokens", () => {
  it("extracts known capability prefixes as raw value text", () => {
    // CAPA values are compact (no consistent separator inside a segment), so
    // we expose them as raw strings after the prefix and let callers do
    // their own slicing for specific values.
    const capa = Buffer.from(
      "#GMMLISTUG10UG18#CMXLISTUNITUM08#QITLISTPREFON  OFF #FMTLISTRAW JPG #CCTLISTCOL MONOPREF",
      "ascii",
    );
    const parsed = parseCapaTokens(capa);
    expect(parsed.gmmList).toBe("UG10UG18");
    expect(parsed.cmxList).toBe("UNITUM08");
    expect(parsed.qitList).toBe("PREFON  OFF");
    expect(parsed.fmtList).toBe("RAW JPG");
    expect(parsed.cctList).toBe("COL MONOPREF");
  });

  it("detects ADF duplex by presence of #ADFDPLX segment", () => {
    const withDuplex = Buffer.from("#ADFDPLX#GMMLISTUG10", "ascii");
    const withoutDuplex = Buffer.from("#GMMLISTUG10", "ascii");
    expect(parseCapaTokens(withDuplex).adfDuplex).toBe(true);
    expect(parseCapaTokens(withoutDuplex).adfDuplex).toBe(false);
  });

  it("returns null for absent capability prefixes", () => {
    const capa = Buffer.from("#GMMLISTUG10", "ascii");
    const parsed = parseCapaTokens(capa);
    expect(parsed.cmxList).toBeNull();
    expect(parsed.qitList).toBeNull();
    expect(parsed.cctList).toBeNull();
  });
});

describe("parseInfoTokens — extended fields for diagnostics", () => {
  it("extracts FB and ADF scan-area tokens when present", () => {
    const info = Buffer.from("#ADFAREAd850i0001400#FB AREAd850i0001170#FB ALGNLEFT", "ascii");
    const parsed = parseInfoTokens(info);
    expect(parsed.fbArea).toBe("d850i0001170");
    expect(parsed.adfArea).toBe("d850i0001400");
  });

  it("returns null for absent scan-area fields (e.g. flatbed-only printer)", () => {
    const info = Buffer.from("#FB AREAd850i0001170", "ascii");
    const parsed = parseInfoTokens(info);
    expect(parsed.fbArea).toBe("d850i0001170");
    expect(parsed.adfArea).toBeNull();
  });
});

describe("parseCapaTokens — resolution lists and JPEG quality range", () => {
  it("parses mixed d/i resolution lists", () => {
    const body = Buffer.from(
      "#RSMLISTd050d075d100d150d200d300d600i0001200#RSSLISTd050d075d100d150d200d300d600i0001200i0002400",
      "ascii",
    );
    const t = parseCapaTokens(body);
    expect(t.rsmList).toEqual([50, 75, 100, 150, 200, 300, 600, 1200]);
    expect(t.rssList).toEqual([50, 75, 100, 150, 200, 300, 600, 1200, 2400]);
  });

  it("parses per-source RSMSLIST segments, including #FB 's embedded space", () => {
    const body = Buffer.from(
      "#ADFRSMSLISTd075d150d200d300d600#FB RSMSLISTd075d150d200d300d600i0001200",
      "ascii",
    );
    const t = parseCapaTokens(body);
    expect(t.adfRsmsList).toEqual([75, 150, 200, 300, 600]);
    expect(t.fbRsmsList).toEqual([75, 150, 200, 300, 600, 1200]);
  });

  it("parses #JPGRANG min/max", () => {
    const t = parseCapaTokens(Buffer.from("#JPGRANGd001d100", "ascii"));
    expect(t.jpgRange).toEqual({ min: 1, max: 100 });
  });

  it("returns null for all new fields when segments are absent", () => {
    const t = parseCapaTokens(Buffer.from("#GMMLISTUG10", "ascii"));
    expect(t.rsmList).toBeNull();
    expect(t.adfRsmsList).toBeNull();
    expect(t.fbRsmsList).toBeNull();
    expect(t.jpgRange).toBeNull();
  });

  it("doesn't confuse #FB RSMSLIST with a #FB AREA-prefixed segment (CAPA is not INFO)", () => {
    // #FB AREA doesn't actually appear in real CAPA bodies (it's an INFO-only
    // token) but textAfterPrefix takes the first startsWith match, so prove
    // the two "#FB " prefixes don't shadow each other when both are present.
    const body = Buffer.from("#FB AREAd850i0001170#FB RSMSLISTd075d150d200", "ascii");
    const t = parseCapaTokens(body);
    expect(t.fbRsmsList).toEqual([75, 150, 200]);
  });
});

describe("parseStatErrors", () => {
  it("returns each #ERR token as location and code, trimmed", () => {
    expect(parseStatErrors(Buffer.from("#ERRADF PE  ", "ascii"))).toEqual(["ADF PE"]);
    expect(parseStatErrors(Buffer.from("#ERRADF JAM #ERRFB  OPN ", "ascii"))).toEqual([
      "ADF JAM",
      "FB OPN",
    ]);
  });

  it("returns nothing for a reply with no error, including #--- filler", () => {
    expect(parseStatErrors(Buffer.alloc(0))).toEqual([]);
    expect(parseStatErrors(Buffer.from("STATx0000000#---#---#---", "ascii"))).toEqual([]);
    expect(parseStatErrors(Buffer.from("#ERR    #---", "ascii"))).toEqual([]);
  });
});

describe("ADF duplex type (INFO) and crop (CAPA)", () => {
  it("parses the INFO #ADFDPLX value: 2SCN, 1SCN, or null when absent", () => {
    expect(parseInfoTokens(Buffer.from("#ADFTYPEFEED#ADFDPLX2SCN#ADFFORDPF1N")).adfDuplexType).toBe(
      "2SCN",
    );
    expect(parseInfoTokens(Buffer.from("#ADFDPLX1SCN#ADFFORDPF1N")).adfDuplexType).toBe("1SCN");
    expect(parseInfoTokens(Buffer.from("#ADFTYPEFEED#ADFFORDPF1N")).adfDuplexType).toBeNull();
  });

  it("detects #ADFCRP in CAPA", () => {
    expect(parseCapaTokens(Buffer.from("#ADFDPLX#ADFCRP #ADFSKEW")).adfCrop).toBe(true);
    expect(parseCapaTokens(Buffer.from("#ADFDPLX#ADFSKEW")).adfCrop).toBe(false);
  });
});
