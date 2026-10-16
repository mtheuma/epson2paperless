import { describe, it, expect } from "vitest";
import {
  capabilityFields,
  compareWithEntry,
  deriveCapabilities,
  isExpectedDisagreement,
  sourceFromStatLength,
  sourceFromStatusErrors,
  type DerivedCapabilities,
} from "./derivation.js";
import { parseCapaTokens, parseInfoTokens, parseStatErrors } from "./capabilities.js";
import { REGISTRY, type RegistryEntry } from "./dialects/registry.js";
import { computeCapaFingerprint } from "./capa-fingerprint.js";
import {
  DIAGNOSTICS,
  EXPECTED_DISAGREEMENTS,
  REPLAY_FIXTURES,
  bodiesFromDiagnostic,
  readFirstInitPollStatus,
  readInit1Bodies,
} from "./test-support/capability-bodies.js";

const NO_INFO = Buffer.alloc(0);
const NO_CAPA = Buffer.alloc(0);
const derive = (info: Buffer, capa: Buffer) =>
  deriveCapabilities(parseInfoTokens(info), parseCapaTokens(capa));
const ascii = (s: string) => Buffer.from(s, "ascii");
const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";

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
      ascii("#ADFAREAd850i0001550"),
      ascii("#ADFDPLX#ADFCRP #QITLISTPREFON  OFF "),
    );
    expect(capabilityFields(derived)).toEqual({
      adfDuplex: true,
      optionalSegments: { qit: true, cct: false },
      paraProfile: "adf-crp",
      sourceDetection: "fixed-adf",
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

  it("both sources read the init poll's status; one source is fixed to it", () => {
    expect(derive(ascii(ADF + FB), NO_CAPA).sourceDetection).toBe("init-poll-status");
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
    expect(derive(ascii("#ADFDPLX2SCN"), NO_CAPA).duplexBackRotated).toBe(true);
    expect(derive(ascii("#ADFDPLX1SCN"), NO_CAPA).duplexBackRotated).toBe(false);
    expect(derive(ascii("#ADFAREAd850i0001400"), NO_CAPA).duplexBackRotated).toBe(false);
  });
});

describe("sourceFromStatusErrors — content-based source decision", () => {
  it("ADF paper empty means the flatbed; no error means the ADF", () => {
    expect(sourceFromStatusErrors(parseStatErrors(ascii("#ERRADF PE  ")))).toEqual({
      source: "flatbed",
    });
    expect(sourceFromStatusErrors(parseStatErrors(Buffer.alloc(0)))).toEqual({ source: "adf" });
  });

  it("any other error is reported as one a content-based decision would fail on", () => {
    // Synthetic: no fixture carries a status error other than ADF PE.
    expect(sourceFromStatusErrors(parseStatErrors(ascii("#ERRADF JAM #ERRADF PE  ")))).toEqual({
      unexpectedErrors: ["ADF JAM"],
    });
  });
});

describe("compareWithEntry", () => {
  const entry = REGISTRY.get(ET4950_FP)!;
  const agreeing: DerivedCapabilities = {
    qit: true,
    cct: true,
    adfDuplex: true,
    sources: { flatbed: true, adf: true },
    sourceDetection: "init-poll-status",
    paraProfile: "standard",
    duplexBackRotated: true,
  };

  it("returns nothing when every field agrees", () => {
    expect(compareWithEntry(agreeing, entry)).toEqual([]);
  });

  it("returns one disagreement per differing field, naming both values", () => {
    expect(
      compareWithEntry(
        { ...agreeing, sources: { flatbed: false, adf: true }, duplexBackRotated: false },
        entry,
      ),
    ).toEqual([
      {
        field: "sources",
        derived: { flatbed: false, adf: true },
        entry: { flatbed: true, adf: true },
      },
      { field: "duplexBackRotated", derived: false, entry: true },
    ]);
  });

  it("never compares the live fields: the entry has none to compare with", () => {
    const live = {
      qit: false,
      cct: false,
      adfDuplex: false,
      paraProfile: "adf-crp",
      sourceDetection: "fixed-adf",
    } as const;
    expect(compareWithEntry({ ...agreeing, ...live }, entry)).toEqual([]);
  });
});

describe("shadow derivation agrees with every replay fixture", () => {
  it.each(REPLAY_FIXTURES)("$model: $path", ({ model, path }) => {
    const { info, capa } = readInit1Bodies(path);
    const entry = REGISTRY.get(computeCapaFingerprint(capa));
    expect(entry).toBeDefined();
    expect(compareWithEntry(derive(info, capa), entry!)).toEqual(
      EXPECTED_DISAGREEMENTS[model] ?? [],
    );
  });

  it("every expected disagreement is one its entry flags as unconfirmed", () => {
    for (const { model, path } of REPLAY_FIXTURES) {
      const entry = REGISTRY.get(computeCapaFingerprint(readInit1Bodies(path).capa))!;
      for (const d of EXPECTED_DISAGREEMENTS[model] ?? []) {
        expect(isExpectedDisagreement(d, entry)).toBe(true);
      }
    }
    // And only those: the same field on an entry that doesn't flag it counts.
    const et4950 = REGISTRY.get(ET4950_FP)!;
    expect(
      isExpectedDisagreement({ field: "duplexBackRotated", derived: false, entry: true }, et4950),
    ).toBe(false);
  });

  it("every expected disagreement names a fixture model", () => {
    const models = new Set(REPLAY_FIXTURES.map((f) => f.model));
    for (const model of Object.keys(EXPECTED_DISAGREEMENTS)) expect(models).toContain(model);
  });

  it("adf-crp is derived for exactly the FF-680W and DS-575W", () => {
    const crp = REPLAY_FIXTURES.filter(({ path }) => {
      const { info, capa } = readInit1Bodies(path);
      return derive(info, capa).paraProfile === "adf-crp";
    });
    expect(new Set(crp.map((f) => f.model))).toEqual(new Set(["FF-680W", "DS-575W"]));
  });
});

describe("content-based source decision agrees with the length-based one on every fixture", () => {
  // Only a printer with both sources reads its status; the rest are fixed to
  // their one source and never consult it.
  const statusFixtures = REPLAY_FIXTURES.filter(({ path }) => {
    const { info, capa } = readInit1Bodies(path);
    return derive(info, capa).sourceDetection === "init-poll-status";
  });

  it("covers flatbed and ADF sessions of every fixture model that reads its status", () => {
    expect(new Set(statusFixtures.map((f) => f.model))).toEqual(
      new Set(["ET-4950 family", "XP-7100", "ET-4800"]),
    );
    expect(new Set(statusFixtures.map((f) => f.source))).toEqual(new Set(["flatbed", "adf"]));
  });

  it.each(statusFixtures)("$model: $path", ({ path, source }) => {
    const { header, body } = readFirstInitPollStatus(path);
    const lengthBased = sourceFromStatLength(body?.length ?? 0);
    const errors = [header, body ?? Buffer.alloc(0)].flatMap((b) => parseStatErrors(b));
    expect(sourceFromStatusErrors(errors)).toEqual({ source: lengthBased });
    // Both agree with the source the session was recorded scanning from.
    expect(lengthBased).toBe(source);
  });

  it("DS-575W: its first statuses say paper-empty, yet it stays fixed to the ADF", () => {
    // The duplex capture reports ADF PE for its first 4 polls and nothing
    // after; read by content, the first would say flatbed. An ADF-only
    // printer never consults it.
    const path = "tools/pcap-extract/captures/ds-575w/adf-duplex-600-mono-jpg.jsonl";
    const { body } = readFirstInitPollStatus(path);
    expect(parseStatErrors(body!)).toEqual(["ADF PE"]);
    const { info, capa } = readInit1Bodies(path);
    expect(derive(info, capa).sourceDetection).toBe("fixed-adf");
  });
});

/**
 * The live fields every recorded model derives: the values its registry
 * entry carried before they were derived. Each one is asserted from that
 * model's own replies: every replay fixture, and every issue diagnostic for
 * the fields its block determines.
 */
type LiveFields = Pick<
  DerivedCapabilities,
  "qit" | "cct" | "adfDuplex" | "paraProfile" | "sourceDetection"
>;
// Source detection: "init-poll-status" was the entry's "stat-length".
const STATUS = "init-poll-status";
const LIVE_FIELDS: Record<string, Partial<LiveFields>> = {
  "ET-4950 family": {
    qit: true,
    cct: true,
    adfDuplex: true,
    paraProfile: "standard",
    sourceDetection: STATUS,
  },
  "ET-2750": {
    qit: false,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: "fixed-flatbed",
  },
  "XP-7100": {
    qit: true,
    cct: false,
    adfDuplex: true,
    paraProfile: "standard",
    sourceDetection: STATUS,
  },
  "ET-4800": {
    qit: false,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: STATUS,
  },
  "ET-7700": {
    qit: true,
    cct: false,
    adfDuplex: false,
    paraProfile: "standard",
    sourceDetection: "fixed-flatbed",
  },
  "FF-680W": {
    qit: false,
    cct: false,
    adfDuplex: true,
    paraProfile: "adf-crp",
    sourceDetection: "fixed-adf",
  },
  "DS-575W": {
    qit: false,
    cct: false,
    adfDuplex: true,
    paraProfile: "adf-crp",
    sourceDetection: "fixed-adf",
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
const LIVE = ["qit", "cct", "adfDuplex", "paraProfile", "sourceDetection"] as const;

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
    for (const field of LIVE.filter((f) => fields.includes(f))) {
      expect(LIVE_FIELDS[model][field], field).toBeDefined();
      expect(derived[field], field).toBe(LIVE_FIELDS[model][field]);
    }
  });

  it("checks every live field of every block except the ET-2950's CCT", () => {
    for (const { model, block } of DIAGNOSTICS) {
      const { fields } = bodiesFromDiagnostic(block);
      const unchecked = LIVE.filter((f) => !fields.includes(f));
      expect(unchecked, model).toEqual(model === "ET-2950" ? ["cct"] : []);
    }
  });
});

describe("shadow derivation agrees with models known only from issue diagnostics", () => {
  it.each(DIAGNOSTICS)("$model (#$issue)", ({ fp, block }) => {
    const entry: RegistryEntry | undefined = REGISTRY.get(fp);
    expect(entry).toBeDefined();
    const { info, capa, fields } = bodiesFromDiagnostic(block);
    const disagreements = compareWithEntry(derive(info, capa), entry!);
    expect(disagreements.filter((d) => fields.includes(d.field))).toEqual([]);
  });
});
