import { describe, it, expect } from "vitest";
import {
  buildGenericEntry,
  genericColourPair,
  genericParaFields,
  GenericDialectUnusableError,
} from "./generic.js";
import { makeParaSpec } from "./dispatch.js";
import { parseArea, parseCapaTokens, parseInfoTokens } from "../capabilities.js";
import { checkColourPair } from "../data/colour-pair.js";
import { isIdentityCmx, CMX_CLASSES } from "../data/cmx-classes.js";
import { composePara, type ParaSpec } from "../para-composer.js";
import { advertisedDpiSet } from "../resolution.js";
import { toPixels } from "../scan-window.js";
import { REPLAY_FIXTURES, readInit1Bodies } from "../test-support/capability-bodies.js";
import { parseParaSegments } from "../test-support/para-parse.js";

const ascii = (text: string) => Buffer.from(text, "ascii");
const info = (text: string) => parseInfoTokens(ascii(text));
const capa = (text: string) => parseCapaTokens(ascii(text));

const FB = "#FB AREAd850i0001170#FB ALGNLEFT";
const ADF = "#ADFAREAd850i0001400#ADFALGNRIGT";
const NEUTRAL_CAPA = "#GMMLISTUG10UG18#CMXLISTUNITUM08#FMTLISTRAW JPG ";

/** One fixture per model: the generic path reads only INIT1, which every session of a model shares. */
const FIXTURE_MODELS = REPLAY_FIXTURES.filter(
  (f, i) => REPLAY_FIXTURES.findIndex((g) => g.model === f.model) === i,
);
const ADF_CRP_MODELS = ["FF-680W", "DS-575W"];

describe("the generic dialect, on every fixture model with its override ignored", () => {
  describe.each(FIXTURE_MODELS)("$model", ({ model, path }) => {
    const bodies = readInit1Bodies(path);
    const infoTokens = parseInfoTokens(bodies.info);
    const capaTokens = parseCapaTokens(bodies.capa);
    const entry = buildGenericEntry(infoTokens, capaTokens);

    const sources: ParaSpec["source"][] = [];
    if (entry.fbExtents !== null) sources.push("flatbed");
    if (entry.adfExtents !== null) sources.push("adf-simplex");
    if (entry.adfDuplex) sources.push("adf-duplex");

    it("is adf-crp exactly for the FF-680W and DS-575W", () => {
      expect(entry.paraProfile === "adf-crp").toBe(ADF_CRP_MODELS.includes(model));
    });

    it("sends the neutral pair", () => {
      expect(
        checkColourPair({ gmm: entry.gmm, gamma: entry.gammaClass.jpg, cmx: entry.cmxClass.jpg }),
      ).toEqual({ valid: true, kind: "neutral" });
    });

    it.each(sources)("composes a valid PARA for %s at every advertised DPI", (source) => {
      const area = parseArea(source === "flatbed" ? infoTokens.fbArea : infoTokens.adfArea)!;
      const dpis = advertisedDpiSet(capaTokens, source);
      expect(dpis.length).toBeGreaterThan(0);
      for (const dpi of dpis) {
        for (const action of ["jpg", "pdf"] as const) {
          const spec = {
            ...makeParaSpec(entry, source, action, dpi),
            ...genericParaFields(entry),
          };
          const segments = parseParaSegments(composePara(spec));
          const values = (code: string) => segments.find((s) => s.code === code)?.values;

          expect(values("RSM"), `${source} @ ${dpi}`).toEqual([dpi]);
          expect(values("RSS"), `${source} @ ${dpi}`).toEqual([dpi]);
          expect(values("GMM")).toEqual([entry.gmm]);
          const [x0, y0, w, h] = values("ACQ") as number[];
          expect(w, `${source} @ ${dpi}`).toBeGreaterThan(0);
          expect(h, `${source} @ ${dpi}`).toBeGreaterThan(0);
          expect(x0 + w, `${source} @ ${dpi}`).toBeLessThanOrEqual(toPixels(area.width, dpi));
          expect(y0 + h, `${source} @ ${dpi}`).toBeLessThanOrEqual(toPixels(area.height, dpi));
          const crop = segments[0].code === "ADF" && segments[0].values[0] === "CRP ";
          expect(crop).toBe(entry.paraProfile === "adf-crp");
        }
      }
    });
  });
});

describe("genericColourPair", () => {
  it("is the neutral pair in UG18 when the printer lists it", () => {
    const pair = genericColourPair(capa(NEUTRAL_CAPA), "standard");
    expect(pair).toEqual({ gmm: "UG18", gamma: "et4950-stock", cmx: "et2750-um08" });
    expect(checkColourPair(pair)).toEqual({ valid: true, kind: "neutral" });
  });

  it("falls back to UG10 when that is all the printer lists", () => {
    const pair = genericColourPair(capa("#GMMLISTUG10#CMXLISTUNITUM08"), "standard");
    expect(pair.gmm).toBe("UG10");
    expect(checkColourPair(pair)).toEqual({ valid: true, kind: "neutral" });
  });

  it("uses the identity matrix", () => {
    const { cmx } = genericColourPair(capa(NEUTRAL_CAPA), "standard");
    expect(isIdentityCmx(CMX_CLASSES[cmx!])).toBe(true);
  });

  it("is SoC-style (UG10, no matrix) on a standard printer that lists no UM08", () => {
    const pair = genericColourPair(
      capa("#GMMLISTUG10UG18#CMXLISTUNIT#FMTLISTRAW JPG "),
      "standard",
    );
    expect(pair).toEqual({ gmm: "UG10", gamma: "et4950-stock", cmx: null });
    expect(checkColourPair(pair)).toEqual({ valid: true, kind: "soc-style" });
  });

  it("fails on an adf-crp printer that lists no UM08", () => {
    expect(() =>
      genericColourPair(capa("#GMMLISTUG10UG18#CMXLISTUNIT#FMTLISTRAW JPG "), "adf-crp"),
    ).toThrow(GenericDialectUnusableError);
  });

  it("fails rather than sending SoC-style UG10 to a printer that doesn't list it", () => {
    expect(() => genericColourPair(capa("#GMMLISTUG18#CMXLISTUNIT"), "standard")).toThrow(
      /no UG10 gamma mode/,
    );
  });

  it("fails when the printer lists neither UG18 nor UG10", () => {
    expect(() => genericColourPair(capa("#GMMLISTUG22#CMXLISTUNITUM08"), "standard")).toThrow(
      /no gamma mode/,
    );
  });
});

describe("buildGenericEntry", () => {
  it("reads its source from the status content and polls 3 times with a flatbed and an ADF", () => {
    const entry = buildGenericEntry(info(FB + ADF), capa(NEUTRAL_CAPA));
    expect(entry.sourceDetection).toBe("init-poll-status");
    expect(entry.initPollIterations).toBe(3);
  });

  it("is fixed to the flatbed, polled 3 times, on a flatbed-only printer", () => {
    const entry = buildGenericEntry(info(FB), capa(NEUTRAL_CAPA));
    expect(entry.sourceDetection).toBe("fixed-flatbed");
    expect(entry.initPollIterations).toBe(3);
    expect(entry.adfExtents).toBeNull();
    expect(entry.adfDuplex).toBe(false);
  });

  it("is fixed to the ADF, polled 12 times, on an ADF-only printer", () => {
    const entry = buildGenericEntry(info(ADF), capa(NEUTRAL_CAPA));
    expect(entry.sourceDetection).toBe("fixed-adf");
    expect(entry.initPollIterations).toBe(12);
    expect(entry.fbExtents).toBeNull();
  });

  it("is SoC-style on a standard printer that lists no UM08", () => {
    const entry = buildGenericEntry(info(FB), capa("#GMMLISTUG10UG18#CMXLISTUNIT#FMTLISTRAW JPG "));
    expect(entry.gmm).toBe("UG10");
    expect(entry.cmxClass).toEqual({ jpg: null, pdf: null });
    const segments = parseParaSegments(composePara(makeParaSpec(entry, "flatbed", "jpg")));
    expect(segments.map((s) => s.code)).not.toContain("CMX");
  });

  it("fails on an adf-crp printer that lists no UM08", () => {
    const crp = "#ADFCRP #GMMLISTUG10UG18#CMXLISTUNIT#FMTLISTRAW JPG ";
    expect(() => buildGenericEntry(info(ADF), capa(crp))).toThrow(/UM08/);
  });

  it("is A4 at 300 DPI, right-aligned in a right-aligned ADF", () => {
    const entry = buildGenericEntry(info(FB + ADF), capa(NEUTRAL_CAPA));
    expect(entry.fbExtents).toMatchObject({ x0: 0, y0: 0, w: 2481, h: 3506 });
    expect(entry.adfExtents).toMatchObject({ x0: 69, y0: 0, w: 2481, h: 3506 });
  });

  it("sends #QIT / #CCT only when their list carries the value it sends", () => {
    const listed = buildGenericEntry(
      info(FB),
      capa(NEUTRAL_CAPA + "#QITLISTPREFON  OFF#CCTLISTPREFCOL MONO"),
    );
    expect(listed.optionalSegments).toEqual({ qit: true, cct: true });
    const other = buildGenericEntry(info(FB), capa(NEUTRAL_CAPA + "#QITLISTPREFON  #CCTLISTMONO"));
    expect(other.optionalSegments).toEqual({ qit: false, cct: false });
  });

  it("takes the crop-mode #DFA length from the printer's ADF area", () => {
    const adf = "#ADFAREAd850i0001400#ADFALGNCNTR";
    const entry = buildGenericEntry(info(adf), capa("#ADFCRP " + NEUTRAL_CAPA));
    const spec = {
      ...makeParaSpec(entry, "adf-simplex", "jpg", 200),
      ...genericParaFields(entry),
    };
    const segments = parseParaSegments(composePara(spec));
    expect(segments.find((s) => s.code === "DFA")?.values).toEqual([0, 1400]);
  });

  describe("fails fast", () => {
    it("when CAPA lists no JPG format", () => {
      expect(() =>
        buildGenericEntry(info(FB), capa("#GMMLISTUG10UG18#CMXLISTUNITUM08#FMTLISTRAW ")),
      ).toThrow("its CAPA reply lists no JPG format");
    });

    it("when INFO advertises no scan area", () => {
      expect(() => buildGenericEntry(info("#PRDh010PID 9999        "), capa(NEUTRAL_CAPA))).toThrow(
        "its INFO reply advertises no scan area",
      );
    });

    it("when an advertised scan area is unusable", () => {
      expect(() => buildGenericEntry(info("#FB AREAd000i0000000"), capa(NEUTRAL_CAPA))).toThrow(
        "its flatbed scan area (d000i0000000) isn't usable",
      );
    });

    it("when CAPA can't be parsed", () => {
      expect(() => buildGenericEntry(info(FB), capa("not a CAPA reply"))).toThrow(
        "its CAPA reply couldn't be parsed",
      );
    });
  });
});
