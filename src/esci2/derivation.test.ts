import { describe, it, expect } from "vitest";
import {
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
  EXPECTED_DISAGREEMENTS,
  REPLAY_FIXTURES,
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
  it("QIT and CCT are present exactly when CAPA advertises the matching list", () => {
    expect(derive(NO_INFO, ascii("#QITLISTPREFON  OFF #CCTLISTPREFCOL MONO"))).toEqual(
      expect.objectContaining({ qit: true, cct: true }),
    );
    expect(derive(NO_INFO, ascii("#GMMLISTUG10UG18"))).toEqual(
      expect.objectContaining({ qit: false, cct: false }),
    );
  });

  it("a list segment with no items advertises nothing", () => {
    // Matches the diagnostic block, which renders a bare #XXXLIST as (absent).
    expect(derive(NO_INFO, ascii("#QITLIST#CCTLIST"))).toEqual(
      expect.objectContaining({ qit: false, cct: false }),
    );
  });

  it("ADF duplex is present exactly when CAPA carries an #ADFDPLX segment", () => {
    expect(derive(NO_INFO, ascii("#ADFDPLX#GMMLISTUG10")).adfDuplex).toBe(true);
    expect(derive(NO_INFO, ascii("#ADFRSMSLISTd300d600")).adfDuplex).toBe(false);
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
    expect(compareWithEntry({ ...agreeing, cct: false, adfDuplex: false }, entry)).toEqual([
      { field: "cct", derived: false, entry: true },
      { field: "adfDuplex", derived: false, entry: true },
    ]);
  });

  it("compares sources structurally and maps the entry's stat-length to the status read", () => {
    expect(
      compareWithEntry(
        { ...agreeing, sources: { flatbed: true, adf: false }, sourceDetection: "fixed-flatbed" },
        entry,
      ),
    ).toEqual([
      {
        field: "sources",
        derived: { flatbed: true, adf: false },
        entry: { flatbed: true, adf: true },
      },
      { field: "sourceDetection", derived: "fixed-flatbed", entry: "init-poll-status" },
    ]);
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
  // Only stat-length entries make a length-based decision; for the rest the
  // source is fixed and the status content is never consulted.
  const statLengthFixtures = REPLAY_FIXTURES.filter(({ path }) => {
    const entry = REGISTRY.get(computeCapaFingerprint(readInit1Bodies(path).capa));
    return entry?.sourceDetection === "stat-length";
  });

  it("covers flatbed and ADF sessions of every stat-length fixture model", () => {
    expect(new Set(statLengthFixtures.map((f) => f.model))).toEqual(
      new Set(["ET-4950 family", "XP-7100", "ET-4800"]),
    );
  });

  it.each(statLengthFixtures)("$model: $path", ({ path, source }) => {
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

// Models with no replay fixture: the facts their reporters posted in the
// unsupported-printer diagnostic block. A diagnostic carries only the lists,
// the duplex flag and the scan areas (and older blocks have no CCT line), so
// INFO and CAPA bodies are rebuilt from the lines present and only the
// fields they determine are compared.
const DIAGNOSTICS: ReadonlyArray<{ model: string; issue: number; fp: string; block: string }> = [
  {
    model: "ET-2950",
    issue: 92,
    fp: "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
Scan area (FB):    d850i0001170
Scan area (ADF):   (absent)
QIT list:          PREFON  OFF`,
  },
  {
    model: "ET-15000",
    issue: 106,
    fp: "d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55",
    block: `
Source caps:       flatbed: Y  ADF: Y  duplex: N
Scan area (FB):    d850i0001400
Scan area (ADF):   d850i0001400
QIT list:          (absent)
CCT list:          (absent)`,
  },
  {
    model: "ET-2810",
    issue: 132,
    fp: "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
Scan area (FB):    d850i0001170
Scan area (ADF):   (absent)
QIT list:          (absent)
CCT list:          (absent)`,
  },
  {
    model: "ET-8500",
    issue: 120,
    fp: "05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
Scan area (FB):    d850i0001170
Scan area (ADF):   (absent)
QIT list:          PREFON  OFF
CCT list:          (absent)`,
  },
  {
    model: "WF-3835",
    issue: 174,
    fp: "860a899be9dc4fc27b68f8aed21a49ccfe87733a3974813f0c2ade6810e89dc7",
    block: `
Source caps:       flatbed: Y  ADF: Y  duplex: N
Scan area (FB):    d850i0001170
Scan area (ADF):   d850i0001400
QIT list:          PREFON  OFF
CCT list:          (absent)`,
  },
];

function bodiesFromDiagnostic(block: string): { info: Buffer; capa: Buffer; fields: string[] } {
  const infoSegments: string[] = [];
  const capaSegments: string[] = [];
  const fields: string[] = [];
  const duplex = block.match(/duplex: ([YN])/);
  if (duplex) {
    fields.push("adfDuplex");
    if (duplex[1] === "Y") capaSegments.push("#ADFDPLX");
  }
  for (const [label, token, field] of [
    ["QIT", "#QITLIST", "qit"],
    ["CCT", "#CCTLIST", "cct"],
  ] as const) {
    const line = block.match(new RegExp(`^${label} list: +(.+)$`, "m"));
    if (!line) continue;
    fields.push(field);
    if (line[1] !== "(absent)") capaSegments.push(token + line[1]);
  }
  const fbArea = block.match(/^Scan area \(FB\): +(.+)$/m);
  const adfArea = block.match(/^Scan area \(ADF\): +(.+)$/m);
  if (fbArea && adfArea) {
    fields.push("sources", "sourceDetection");
    if (fbArea[1] !== "(absent)") infoSegments.push("#FB AREA" + fbArea[1]);
    if (adfArea[1] !== "(absent)") infoSegments.push("#ADFAREA" + adfArea[1]);
  }
  return { info: ascii(infoSegments.join("")), capa: ascii(capaSegments.join("")), fields };
}

describe("shadow derivation agrees with models known only from issue diagnostics", () => {
  it.each(DIAGNOSTICS)("$model (#$issue)", ({ fp, block }) => {
    const entry: RegistryEntry | undefined = REGISTRY.get(fp);
    expect(entry).toBeDefined();
    const { info, capa, fields } = bodiesFromDiagnostic(block);
    const disagreements = compareWithEntry(derive(info, capa), entry!);
    expect(disagreements.filter((d) => fields.includes(d.field))).toEqual([]);
  });

  it("the ET-2950 block predates the CCT line, so CCT goes unchecked for it", () => {
    const et2950 = DIAGNOSTICS.find((d) => d.model === "ET-2950")!;
    expect(bodiesFromDiagnostic(et2950.block).fields).toEqual([
      "adfDuplex",
      "qit",
      "sources",
      "sourceDetection",
    ]);
  });
});
