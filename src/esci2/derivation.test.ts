import { describe, it, expect } from "vitest";
import {
  capabilityFields,
  deriveCapabilities,
  judgeStatusErrors,
  sourceFromStatusErrors,
  type DerivedCapabilities,
} from "./derivation.js";
import { parseCapaTokens, parseInfoTokens, parseStatErrors } from "./capabilities.js";
import { OVERRIDES_BY_FINGERPRINT, type ModelOverride } from "./dialects/model-overrides.js";
import { computeCapaFingerprint } from "./capa-fingerprint.js";
import {
  DIAGNOSTICS,
  REPLAY_FIXTURES,
  bodiesFromDiagnostic,
  readFirstInitPollStatus,
  readInit1Bodies,
  readPreParaStatus,
} from "./test-support/capability-bodies.js";

const NO_INFO = Buffer.alloc(0);
const NO_CAPA = Buffer.alloc(0);
const derive = (info: Buffer, capa: Buffer) =>
  deriveCapabilities(parseInfoTokens(info), parseCapaTokens(capa));
const ascii = (s: string) => Buffer.from(s, "ascii");

describe("deriveCapabilities — rules", () => {
  it("QIT and CCT are present exactly when their list carries the value PARA sends", () => {
    expect(derive(NO_INFO, ascii("#QITLISTPREFON  OFF #CCTLISTPREFCOL MONO"))).toEqual(
      expect.objectContaining({ qit: true, cct: true }),
    );
    expect(derive(NO_INFO, ascii("#GMMLISTUG10UG18"))).toEqual(
      expect.objectContaining({ qit: false, cct: false }),
    );
    // Synthetic: every recorded list carries OFF and COL.
    expect(derive(NO_INFO, ascii("#QITLISTPREFON  #CCTLISTPREFMONO"))).toEqual(
      expect.objectContaining({ qit: false, cct: false }),
    );
  });

  it("a list segment with no items advertises nothing", () => {
    // Matches the diagnostic block, which renders a bare #XXXLIST as (absent).
    expect(derive(NO_INFO, ascii("#QITLIST#CCTLIST"))).toEqual(
      expect.objectContaining({ qit: false, cct: false }),
    );
  });

  it("ADF duplex is present exactly when CAPA carries #ADFDPLX and INFO an ADF scan area", () => {
    const adf = ascii("#ADFAREAd850i0001400");
    expect(derive(adf, ascii("#ADFDPLX#GMMLISTUG10")).adfDuplex).toBe(true);
    expect(derive(adf, ascii("#ADFRSMSLISTd300d600")).adfDuplex).toBe(false);
    expect(derive(ascii("#FB AREAd850i0001170"), ascii("#ADFDPLX")).adfDuplex).toBe(false);
  });

  it("capabilityFields puts the live fields in the dialect's shape", () => {
    const derived = derive(
      ascii("#ADFAREAd850i0001550#ADFDPLX2SCN"),
      ascii("#ADFDPLX#ADFCRP #QITLISTPREFON  OFF "),
    );
    expect(capabilityFields(derived)).toEqual({
      adfDuplex: true,
      optionalSegments: { qit: true, cct: false },
      paraProfile: "adf-crp",
      sourceDetection: "fixed-adf",
      duplexBackRotated: true,
    });
  });
});

describe("deriveCapabilities — sources and source detection", () => {
  const FB = "#FB AREAd850i0001170";
  const ADF = "#ADFAREAd850i0001400";

  it("each source with a scan area in INFO is present", () => {
    expect(derive(ascii(ADF + FB), NO_CAPA).sources).toEqual({ flatbed: true, adf: true });
    expect(derive(ascii(FB), NO_CAPA).sources).toEqual({ flatbed: true, adf: false });
    expect(derive(ascii(ADF), NO_CAPA).sources).toEqual({ flatbed: false, adf: true });
  });

  it("both sources read the status before PARA; one source is fixed to it", () => {
    expect(derive(ascii(ADF + FB), NO_CAPA).sourceDetection).toBe("pre-para-status");
    expect(derive(ascii(FB), NO_CAPA).sourceDetection).toBe("fixed-flatbed");
    expect(derive(ascii(ADF), NO_CAPA).sourceDetection).toBe("fixed-adf");
  });

  it("a scan-area segment with no value advertises no source", () => {
    expect(derive(ascii("#ADFAREA" + FB), NO_CAPA)).toEqual(
      expect.objectContaining({
        sources: { flatbed: true, adf: false },
        sourceDetection: "fixed-flatbed",
      }),
    );
  });

  it("no scan area at all derives no source detection", () => {
    expect(derive(ascii("#FB ALGNLEFT#PRDh010PID 1147        "), NO_CAPA)).toEqual(
      expect.objectContaining({
        sources: { flatbed: false, adf: false },
        sourceDetection: null,
      }),
    );
  });
});

describe("deriveCapabilities — PARA profile and back-page rotation", () => {
  it("adf-crp needs an ADF that lists crop and no flatbed", () => {
    const adfOnly = ascii("#ADFAREAd850i0001550");
    const both = ascii("#ADFAREAd850i0001400#FB AREAd850i0001170");
    expect(derive(adfOnly, ascii("#ADFDPLX#ADFCRP #ADFSKEW")).paraProfile).toBe("adf-crp");
    expect(derive(both, ascii("#ADFCRP ")).paraProfile).toBe("standard");
    expect(derive(adfOnly, ascii("#ADFDPLX#ADFSKEW")).paraProfile).toBe("standard");
  });

  it("back pages are rotated exactly for a two-pass (2SCN) duplex ADF", () => {
    const DUPLEX = ascii("#ADFDPLX");
    const area = "#ADFAREAd850i0001400";
    expect(derive(ascii(area + "#ADFDPLX2SCN"), DUPLEX).duplexBackRotated).toBe(true);
    expect(derive(ascii(area + "#ADFDPLX1SCN"), DUPLEX).duplexBackRotated).toBe(false);
    expect(derive(ascii(area), DUPLEX).duplexBackRotated).toBe(false);
  });

  it("no duplex ADF means no rotated back pages, whatever INFO's duplex type says", () => {
    // CAPA lacks #ADFDPLX, or INFO has no ADF scan area: adfDuplex is false.
    expect(derive(ascii("#ADFAREAd850i0001400#ADFDPLX2SCN"), NO_CAPA).duplexBackRotated).toBe(
      false,
    );
    expect(derive(ascii("#ADFDPLX2SCN"), ascii("#ADFDPLX")).duplexBackRotated).toBe(false);
  });
});

// Synthetic beyond ADF PE: no fixture's status reports any other error.
// Codes are from Epson's ESC/I-2 error vocabulary; ADF PJ is the jam a
// reporter's printer sent (#65).
const errorsOf = (status: string) => parseStatErrors(ascii(status));

describe("sourceFromStatusErrors — a printer with both sources", () => {
  const detect = (status: string) => sourceFromStatusErrors(errorsOf(status));

  it("no error → the ADF; ADF paper empty → the flatbed", () => {
    expect(detect("")).toBe("adf");
    expect(detect("#ERRADF PE  ")).toBe("flatbed");
  });

  it("any other ADF code reads as a document loaded → the ADF", () => {
    expect(detect("#ERRADF PJ  ")).toBe("adf");
    expect(detect("#ERRFB  LTF #ERRTPU OPN ")).toBe("adf");
  });

  it("keeps the last code the reply gives the ADF", () => {
    expect(detect("#ERRADF PE  #ERRADF PJ  ")).toBe("adf");
    expect(detect("#ERRADF PJ  #ERRADF PE  ")).toBe("flatbed");
  });
});

describe("judgeStatusErrors — the status before PARA, against the unit being scanned", () => {
  const judge = (status: string, source: "flatbed" | "adf") =>
    judgeStatusErrors(errorsOf(status), source);

  it("no error carries on", () => {
    expect(judge("", "flatbed")).toEqual({ warnings: [] });
    expect(judge("", "adf")).toEqual({ warnings: [] });
  });

  it("flatbed: a flatbed error stops; any other unit's error warns", () => {
    expect(judge("#ERRFB  LOCK", "flatbed")).toEqual({ blocking: "FB LOCK" });
    expect(judge("#ERRADF PE  #ERRFB  LOCK", "flatbed")).toEqual({ blocking: "FB LOCK" });
    expect(judge("#ERRADF PJ  #ERRTPU OPN #ERRZZZZERR ", "flatbed")).toEqual({
      warnings: ["ADF PJ", "TPU OPN", "ZZZZ ERR"],
    });
  });

  it("flatbed: ADF paper empty is a state, not a fault, so it never warns", () => {
    expect(judge("#ERRADF PE  ", "flatbed")).toEqual({ warnings: [] });
  });

  it("ADF: every ADF code stops, paper empty included", () => {
    for (const code of ["PE", "PJ", "OPN", "DFED", "ERR", "BTLO", "ZZZZ"]) {
      expect(judge(`#ERRADF ${code.padEnd(4)}`, "adf")).toEqual({ blocking: `ADF ${code}` });
    }
  });

  it("ADF: flatbed, TPU and unknown-unit errors warn", () => {
    expect(judge("#ERRFB  LTF #ERRTPU OPN #ERRZZZZPJ  ", "adf")).toEqual({
      warnings: ["FB LTF", "TPU OPN", "ZZZZ PJ"],
    });
  });

  it("keeps one code per unit, the last the reply gives", () => {
    expect(judge("#ERRADF PE  #ERRADF PJ  ", "adf")).toEqual({ blocking: "ADF PJ" });
    expect(judge("#ERRADF PJ  #ERRADF PE  ", "adf")).toEqual({ blocking: "ADF PE" });
    expect(judge("#ERRADF PJ  #ERRADF PE  ", "flatbed")).toEqual({ warnings: [] });
    expect(judge("#ERRFB  LOCK#ERRFB  LTF ", "flatbed")).toEqual({ blocking: "FB LTF" });
  });
});

describe("a printer with both sources: the source, then the errors on it", () => {
  // One status, the one before PARA, decides the source and is judged on it.
  const scan = (status: string) => {
    const source = sourceFromStatusErrors(errorsOf(status));
    return { source, ...judgeStatusErrors(errorsOf(status), source) };
  };

  it("ADF paper empty, then a jam: the ADF is loaded and jammed → stop", () => {
    expect(scan("#ERRADF PE  #ERRADF PJ  ")).toEqual({ source: "adf", blocking: "ADF PJ" });
  });

  it("a jam, then ADF paper empty: the ADF is empty → the flatbed, silently", () => {
    expect(scan("#ERRADF PJ  #ERRADF PE  ")).toEqual({ source: "flatbed", warnings: [] });
  });
});

/** The sources a model override has a window for, own or inherited. */
const entrySources = (entry: ModelOverride) => ({
  flatbed: entry.fbExtents !== null,
  adf: entry.adfExtents !== null,
});

describe("derived sources agree with the model override on every replay fixture", () => {
  it.each(REPLAY_FIXTURES)("$model: $path", ({ path }) => {
    const { info, capa } = readInit1Bodies(path);
    const entry = OVERRIDES_BY_FINGERPRINT.get(computeCapaFingerprint(capa));
    expect(entry).toBeDefined();
    expect(derive(info, capa).sources).toEqual(entrySources(entry!));
  });

  it("adf-crp is derived for exactly the FF-680W and DS-575W", () => {
    const crp = REPLAY_FIXTURES.filter(({ path }) => {
      const { info, capa } = readInit1Bodies(path);
      return derive(info, capa).paraProfile === "adf-crp";
    });
    expect(new Set(crp.map((f) => f.model))).toEqual(new Set(["FF-680W", "DS-575W"]));
  });
});

describe("content-based source decision lands on the recorded source on every fixture", () => {
  // Only a printer with both sources reads its status; the rest are fixed to
  // their one source and never consult it.
  const statusFixtures = REPLAY_FIXTURES.filter(({ path }) => {
    const { info, capa } = readInit1Bodies(path);
    return derive(info, capa).sourceDetection === "pre-para-status";
  });

  it("covers flatbed and ADF sessions of every fixture model that reads its status", () => {
    const models = ["ET-4950 family", "XP-7100", "ET-4800"];
    expect(new Set(statusFixtures.map((f) => f.model))).toEqual(new Set(models));
    for (const model of models) {
      const sources = statusFixtures.filter((f) => f.model === model).map((f) => f.source);
      expect(new Set(sources), model).toEqual(new Set(["flatbed", "adf"]));
    }
  });

  it.each(statusFixtures)("$model: $path", ({ path, source }) => {
    const { header, body } = readPreParaStatus(path);
    expect(sourceFromStatusErrors(statusErrors(header, body))).toBe(source);
    // Every recorded flatbed status is the 12-byte "ADF paper empty"; every
    // recorded ADF status is empty.
    expect(body?.length ?? 0).toBe(source === "flatbed" ? 12 : 0);
    // The first status, which once decided the source, says the same: moving
    // the decision to the status before PARA changed no recorded session.
    const first = readFirstInitPollStatus(path);
    expect(sourceFromStatusErrors(statusErrors(first.header, first.body))).toBe(source);
  });

  it.each(REPLAY_FIXTURES)(
    "$model: no recorded status before PARA stops or warns: $path",
    ({ path, source }) => {
      const { header, body } = readPreParaStatus(path);
      expect(judgeStatusErrors(statusErrors(header, body), source)).toEqual({ warnings: [] });
    },
  );

  it("DS-575W: its first statuses say paper-empty; its status before PARA is clear", () => {
    // The duplex capture reports ADF PE for its first 4 polls and nothing
    // after. Judged on the first, the ADF scan would stop; the session
    // judges the last one before PARA, which is clear. An ADF-only
    // printer never reads its status for the source, though if it did, the
    // first status would say the flatbed and the one before PARA the ADF.
    const path = "tools/pcap-extract/captures/ds-575w/adf-duplex-600-mono-jpg.jsonl";
    const first = readFirstInitPollStatus(path);
    expect(statusErrors(first.header, first.body)).toEqual(["ADF PE"]);
    const prePara = readPreParaStatus(path);
    expect(statusErrors(prePara.header, prePara.body)).toEqual([]);
    const { info, capa } = readInit1Bodies(path);
    expect(derive(info, capa).sourceDetection).toBe("fixed-adf");
  });
});

/** A status reply's errors: its header frame's inline tokens, then its body's. */
function statusErrors(header: Buffer, body: Buffer | null): string[] {
  return [header, body ?? Buffer.alloc(0)].flatMap((b) => parseStatErrors(b));
}

/**
 * The live fields every recorded model derives: the values its model
 * override carried before they were derived. Each one is asserted from that
 * model's own replies: every replay fixture, and every issue diagnostic for
 * the fields its block determines.
 */
type LiveFields = Pick<
  DerivedCapabilities,
  "qit" | "cct" | "adfDuplex" | "paraProfile" | "sourceDetection" | "duplexBackRotated"
>;
// Source detection: "pre-para-status" was "init-poll-status", and before
// that the entry's "stat-length".
const STATUS = "pre-para-status";
const LIVE_FIELDS: Record<string, Partial<LiveFields>> = {
  "ET-4950 family": {
    qit: true,
    cct: true,
    adfDuplex: true,
    paraProfile: "standard",
    sourceDetection: STATUS,
    duplexBackRotated: true, // two-pass ADF (#ADFDPLX2SCN)
  },
  "ET-2750": {
    qit: false,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: "fixed-flatbed",
    duplexBackRotated: false,
  },
  "XP-7100": {
    qit: true,
    cct: false,
    adfDuplex: true,
    paraProfile: "standard",
    sourceDetection: STATUS,
    duplexBackRotated: true, // two-pass ADF (#ADFDPLX2SCN)
  },
  "ET-4800": {
    qit: false,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: STATUS,
    duplexBackRotated: false,
  },
  "ET-7700": {
    qit: true,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: "fixed-flatbed",
    duplexBackRotated: false,
  },
  "FF-680W": {
    qit: false,
    cct: false,
    adfDuplex: true,
    paraProfile: "adf-crp",
    sourceDetection: "fixed-adf",
    // Single-pass ADF (#ADFDPLX1SCN). The entry used to rotate: the one
    // value this cutover changes.
    duplexBackRotated: false,
  },
  "DS-575W": {
    qit: false,
    cct: false,
    adfDuplex: true,
    paraProfile: "adf-crp",
    sourceDetection: "fixed-adf",
    duplexBackRotated: false, // single-pass ADF (#ADFDPLX1SCN)
  },
  // Its block has no CCT line, so its session sends #CCT exactly when its
  // own CAPA lists COL; nothing recorded says which.
  "ET-2950": {
    qit: true,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: "fixed-flatbed",
  },
  "ET-15000": {
    qit: false,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: STATUS,
  },
  "ET-2810": {
    qit: false,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: "fixed-flatbed",
  },
  "ET-8500": {
    qit: true,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: "fixed-flatbed",
  },
  "WF-3835": {
    qit: true,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: STATUS,
  },
};
const LIVE = [
  "qit",
  "cct",
  "adfDuplex",
  "paraProfile",
  "sourceDetection",
  "duplexBackRotated",
] as const;
// A diagnostic block doesn't carry INFO's duplex type, so back-page rotation
// is checked on fixtures only. No diagnostic-only model has a duplex ADF.
const LIVE_IN_DIAGNOSTICS = LIVE.filter((f) => f !== "duplexBackRotated");

describe("live fields derived for every replay fixture", () => {
  it.each(REPLAY_FIXTURES)("$model: $path", ({ model, path }) => {
    const { info, capa } = readInit1Bodies(path);
    const derived = derive(info, capa);
    for (const field of LIVE) expect(derived[field], field).toBe(LIVE_FIELDS[model][field]);
  });
});

describe("live fields derived for models known only from issue diagnostics", () => {
  it.each(DIAGNOSTICS)("$model (#$issue)", ({ model, block }) => {
    const { info, capa, fields } = bodiesFromDiagnostic(block);
    const derived = derive(info, capa);
    for (const field of LIVE_IN_DIAGNOSTICS.filter((f) => fields.includes(f))) {
      expect(LIVE_FIELDS[model][field], field).toBeDefined();
      expect(derived[field], field).toBe(LIVE_FIELDS[model][field]);
    }
  });

  it("checks every live field of every block except the ET-2950's CCT", () => {
    for (const { model, block } of DIAGNOSTICS) {
      const { fields } = bodiesFromDiagnostic(block);
      const unchecked = LIVE_IN_DIAGNOSTICS.filter((f) => !fields.includes(f));
      expect(unchecked, model).toEqual(model === "ET-2950" ? ["cct"] : []);
    }
  });
});

describe("derived sources agree with the model override for models known only from issue diagnostics", () => {
  it.each(DIAGNOSTICS)("$model (#$issue)", ({ fp, block }) => {
    const entry: ModelOverride | undefined = OVERRIDES_BY_FINGERPRINT.get(fp);
    expect(entry).toBeDefined();
    const { info, capa, fields } = bodiesFromDiagnostic(block);
    // A block determines the sources only when it carries both area lines;
    // every recorded block does.
    expect(fields).toContain("sources");
    expect(derive(info, capa).sources).toEqual(entrySources(entry!));
  });
});
