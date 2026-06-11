// src/esci2/para-composer.test.ts
import { describe, it, expect } from "vitest";
import { composePara, type ParaSpec } from "./para-composer.js";

// A reusable baseline spec — ET-4950 flatbed JPG params. Tests override fields
// individually to isolate axes.
function baselineSpec(): ParaSpec {
  return {
    source: "flatbed",
    action: "jpg",
    fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
    gmm: "UG10",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass: { jpg: null, pdf: null },
    optionalSegments: { qit: true, cct: true },
  };
}

function findSegmentOffset(body: Buffer, key: string): number {
  return body.indexOf(Buffer.from(key, "ascii"));
}

describe("composePara — source axis", () => {
  it("flatbed emits #FB  (4 bytes, trailing space) as the leading segment", () => {
    const body = composePara({ ...baselineSpec(), source: "flatbed" });
    expect(body.subarray(0, 4).toString("ascii")).toBe("#FB ");
  });

  it("adf-simplex emits #ADF (4 bytes, no trailing) as the leading segment", () => {
    const body = composePara({ ...baselineSpec(), source: "adf-simplex" });
    expect(body.subarray(0, 4).toString("ascii")).toBe("#ADF");
    expect(body.subarray(0, 8).toString("ascii")).not.toBe("#ADFDPLX");
  });

  it("adf-duplex emits #ADFDPLX (8 bytes) as the leading segment", () => {
    const body = composePara({ ...baselineSpec(), source: "adf-duplex" });
    expect(body.subarray(0, 8).toString("ascii")).toBe("#ADFDPLX");
  });

  it("adf sources emit #PAGd000 (8 bytes); flatbed does not", () => {
    const flatbed = composePara({ ...baselineSpec(), source: "flatbed" });
    expect(findSegmentOffset(flatbed, "#PAG")).toBe(-1);
    const simplex = composePara({ ...baselineSpec(), source: "adf-simplex" });
    const dupl = composePara({ ...baselineSpec(), source: "adf-duplex" });
    for (const body of [simplex, dupl]) {
      const off = findSegmentOffset(body, "#PAG");
      expect(off).toBeGreaterThan(0);
      expect(body.subarray(off, off + 8).toString("ascii")).toBe("#PAGd000");
    }
  });
});

describe("composePara — action axis (gamma + CMX lookup)", () => {
  it("jpg uses spec.gammaClass.jpg bytes; pdf uses spec.gammaClass.pdf bytes", () => {
    const spec: ParaSpec = {
      ...baselineSpec(),
      gammaClass: { jpg: "et4950-stock", pdf: "xp7100-pdf" },
    };
    const jpg = composePara({ ...spec, action: "jpg" });
    const pdf = composePara({ ...spec, action: "pdf" });
    expect(jpg.equals(pdf)).toBe(false);
  });

  it("identical gamma class for both actions => same output ignoring CMX", () => {
    const spec = { ...baselineSpec() };
    const jpg = composePara({ ...spec, action: "jpg" });
    const pdf = composePara({ ...spec, action: "pdf" });
    expect(jpg.equals(pdf)).toBe(true);
  });

  it("cmxClass[action] = null omits the #CMX segment", () => {
    const body = composePara({
      ...baselineSpec(),
      cmxClass: { jpg: null, pdf: null },
    });
    expect(findSegmentOffset(body, "#CMX")).toBe(-1);
  });

  it("cmxClass[action] = 'et2750-um08' inserts the 24-byte CMX segment", () => {
    const body = composePara({
      ...baselineSpec(),
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
    });
    const off = findSegmentOffset(body, "#CMX");
    expect(off).toBeGreaterThan(0);
    expect(body.subarray(off, off + 12).toString("ascii")).toBe("#CMXUM08h009");
  });
});

describe("composePara — optional segments", () => {
  it("qit: false omits #QIT", () => {
    const body = composePara({
      ...baselineSpec(),
      optionalSegments: { qit: false, cct: false },
    });
    expect(findSegmentOffset(body, "#QIT")).toBe(-1);
  });

  it("qit: true emits #QITOFF (no space between key and value)", () => {
    const body = composePara({
      ...baselineSpec(),
      optionalSegments: { qit: true, cct: false },
    });
    const off = findSegmentOffset(body, "#QIT");
    expect(off).toBeGreaterThan(0);
    expect(body.subarray(off, off + 8).toString("ascii")).toBe("#QITOFF ");
  });

  it("cct: true emits #CCTCOL  (4-char value padded with trailing space)", () => {
    const body = composePara({
      ...baselineSpec(),
      optionalSegments: { qit: false, cct: true },
    });
    const off = findSegmentOffset(body, "#CCT");
    expect(off).toBeGreaterThan(0);
    expect(body.subarray(off, off + 8).toString("ascii")).toBe("#CCTCOL ");
  });

  it("segment order is #CMX before #QIT before #CCT (when all present)", () => {
    const body = composePara({
      ...baselineSpec(),
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      optionalSegments: { qit: true, cct: true },
    });
    const cmx = findSegmentOffset(body, "#CMX");
    const qit = findSegmentOffset(body, "#QIT");
    const cct = findSegmentOffset(body, "#CCT");
    expect(cmx).toBeLessThan(qit);
    expect(qit).toBeLessThan(cct);
  });
});

describe("composePara — extents (#ACQ rendering)", () => {
  it("renders fbExtents as four i%07d ASCII integers for flatbed", () => {
    const body = composePara({
      ...baselineSpec(),
      source: "flatbed",
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    });
    const off = findSegmentOffset(body, "#ACQ");
    expect(off).toBeGreaterThan(0);
    expect(body.subarray(off, off + 36).toString("ascii")).toBe(
      "#ACQi0000000i0000000i0002481i0003506",
    );
  });

  it("renders adfExtents for ADF sources", () => {
    const body = composePara({
      ...baselineSpec(),
      source: "adf-simplex",
      adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
    });
    const off = findSegmentOffset(body, "#ACQ");
    expect(body.subarray(off, off + 36).toString("ascii")).toBe(
      "#ACQi0000069i0000000i0002481i0003506",
    );
  });

  it("renders 0-padded values up to 7 digits", () => {
    const body = composePara({
      ...baselineSpec(),
      fbExtents: { x0: 12345, y0: 6789, w: 100, h: 9999999 },
    });
    const off = findSegmentOffset(body, "#ACQ");
    expect(body.subarray(off, off + 36).toString("ascii")).toBe(
      "#ACQi0012345i0006789i0000100i9999999",
    );
  });
});

describe("composePara — GMM rendering", () => {
  it("renders #GMM + 4-char value (e.g. UG10)", () => {
    const body = composePara({ ...baselineSpec(), gmm: "UG10" });
    const off = findSegmentOffset(body, "#GMM");
    expect(body.subarray(off, off + 8).toString("ascii")).toBe("#GMMUG10");
  });

  it("renders different GMM constants distinctly (UG18)", () => {
    const body = composePara({ ...baselineSpec(), gmm: "UG18" });
    const off = findSegmentOffset(body, "#GMM");
    expect(body.subarray(off, off + 8).toString("ascii")).toBe("#GMMUG18");
  });
});

describe("composePara — trailing #BSZ constant", () => {
  it("emits #BSZi1048576 (12 bytes) as the last segment", () => {
    const body = composePara(baselineSpec());
    const tail = body.subarray(body.length - 12);
    expect(tail.toString("ascii")).toBe("#BSZi1048576");
  });
});

describe("composePara — fixed-constant segments", () => {
  it("emits #RSMi0000300, #RSSi0000300 in that order after the source segment", () => {
    const body = composePara(baselineSpec());
    const rsm = findSegmentOffset(body, "#RSM");
    const rss = findSegmentOffset(body, "#RSS");
    expect(rsm).toBeLessThan(rss);
    expect(body.subarray(rsm, rsm + 12).toString("ascii")).toBe("#RSMi0000300");
    expect(body.subarray(rss, rss + 12).toString("ascii")).toBe("#RSSi0000300");
  });

  it("emits #COLC024, #FMTJPG , #JPGd090 fixed constants", () => {
    const body = composePara(baselineSpec());
    expect(body.indexOf("#COLC024")).toBeGreaterThan(0);
    expect(body.indexOf("#FMTJPG ")).toBeGreaterThan(0);
    expect(body.indexOf("#JPGd090")).toBeGreaterThan(0);
  });
});

describe("composePara — gamma LUT placement", () => {
  it("inserts the GammaClass bytes verbatim", async () => {
    const { GAMMA_CLASSES } = await import("./data/gamma-classes.js");
    const body = composePara(baselineSpec());
    const gmtStart = body.indexOf("#GMT");
    expect(gmtStart).toBeGreaterThan(0);
    const slice = body.subarray(gmtStart, gmtStart + 804);
    expect(slice.equals(GAMMA_CLASSES["et4950-stock"])).toBe(true);
  });
});

describe("composePara — FF-680W ADF profile", () => {
  it("matches the Mac-observed FF-680W ADF profile shape", () => {
    const body = composePara({
      ...baselineSpec(),
      source: "adf-duplex",
      adfExtents: { x0: 0, y0: 0, w: 1700, h: 7200 },
      gmm: "UG18",
      gammaClass: { jpg: "ff680w-adf", pdf: "ff680w-adf" },
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      optionalSegments: { qit: false, cct: false },
      profile: "ff680w-adf",
    });

    expect(body.length).toBe(1000);
    expect(body.subarray(0, 68).toString("ascii")).toBe(
      "#ADFCRP SKEWDPLXDFL1#RSMi0000200#RSSi0000200#COLC024#FMTJPG #JPGd090",
    );
    expect(body.indexOf(Buffer.from("#GMTRED h100", "ascii"))).toBeGreaterThan(0);
    expect(body.indexOf(Buffer.from("#CMXUM08h009", "ascii"))).toBeGreaterThan(0);
    expect(body.subarray(body.length - 96).toString("ascii")).toBe(
      "#CRPi0000000#DFAi0000000i0001550#LAMOFF #PAGd000" +
        "#ACQi0000000i0000000i0001700i0007200#BSZi1048576",
    );
  });
});

describe("composePara — validation", () => {
  it("throws when ADF source is requested but adfExtents is null", () => {
    expect(() =>
      composePara({
        ...baselineSpec(),
        source: "adf-simplex",
        adfExtents: null,
      }),
    ).toThrow(/adf.*adfExtents/i);
  });

  it("throws when adf-duplex source is requested but adfExtents is null", () => {
    expect(() =>
      composePara({
        ...baselineSpec(),
        source: "adf-duplex",
        adfExtents: null,
      }),
    ).toThrow(/adf.*adfExtents/i);
  });

  it("throws when any extent value is negative", () => {
    expect(() =>
      composePara({
        ...baselineSpec(),
        fbExtents: { x0: -1, y0: 0, w: 100, h: 100 },
      }),
    ).toThrow(/extent/i);
  });

  it("throws when an extent value exceeds the 7-digit #ACQ field width", () => {
    // 10_000_000 is the first value that no longer fits i%07d; rendering it
    // would widen #ACQ by a byte and desync all following segment offsets.
    expect(() =>
      composePara({
        ...baselineSpec(),
        fbExtents: { x0: 0, y0: 0, w: 100, h: 10_000_000 },
      }),
    ).toThrow(/extent/i);
  });

  it("accepts the maximum 7-digit extent value (9999999)", () => {
    const body = composePara({
      ...baselineSpec(),
      fbExtents: { x0: 0, y0: 0, w: 100, h: 9_999_999 },
    });
    const off = body.indexOf(Buffer.from("#ACQ", "ascii"));
    expect(body.subarray(off, off + 36).toString("ascii")).toBe(
      "#ACQi0000000i0000000i0000100i9999999",
    );
  });

  it("throws when gammaClass name is missing from GAMMA_CLASSES", () => {
    expect(() =>
      composePara({
        ...baselineSpec(),
        // @ts-expect-error testing runtime defence against bad class name
        gammaClass: { jpg: "made-up", pdf: "made-up" },
      }),
    ).toThrow(/gamma.*made-up/i);
  });
});
