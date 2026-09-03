import { describe, it, expect } from "vitest";
import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";

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
    expect(parsed.firmware).toBeNull();
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
