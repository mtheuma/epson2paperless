import { describe, it, expect } from "vitest";
import { compareWithEntry, deriveCapabilities, type DerivedCapabilities } from "./derivation.js";
import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";
import { REGISTRY, type RegistryEntry } from "./dialects/registry.js";
import { computeCapaFingerprint } from "./capa-fingerprint.js";
import { REPLAY_FIXTURES, readInit1Bodies } from "./test-support/capability-bodies.js";

const NO_INFO = Buffer.alloc(0);
const derive = (info: Buffer, capa: Buffer) =>
  deriveCapabilities(parseInfoTokens(info), parseCapaTokens(capa));
const capa = (s: string) => Buffer.from(s, "ascii");
const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";

describe("deriveCapabilities — rules", () => {
  it("QIT and CCT are present exactly when CAPA advertises the matching list", () => {
    expect(derive(NO_INFO, capa("#QITLISTPREFON  OFF #CCTLISTPREFCOL MONO"))).toEqual(
      expect.objectContaining({ qit: true, cct: true }),
    );
    expect(derive(NO_INFO, capa("#GMMLISTUG10UG18"))).toEqual(
      expect.objectContaining({ qit: false, cct: false }),
    );
  });

  it("a list segment with no items advertises nothing", () => {
    // Matches the diagnostic block, which renders a bare #XXXLIST as (absent).
    expect(derive(NO_INFO, capa("#QITLIST#CCTLIST"))).toEqual(
      expect.objectContaining({ qit: false, cct: false }),
    );
  });

  it("ADF duplex is present exactly when CAPA carries an #ADFDPLX segment", () => {
    expect(derive(NO_INFO, capa("#ADFDPLX#GMMLISTUG10")).adfDuplex).toBe(true);
    expect(derive(NO_INFO, capa("#ADFRSMSLISTd300d600")).adfDuplex).toBe(false);
  });
});

describe("compareWithEntry", () => {
  const entry = REGISTRY.get(ET4950_FP)!;
  const agreeing: DerivedCapabilities = { qit: true, cct: true, adfDuplex: true };

  it("returns nothing when every field agrees", () => {
    expect(compareWithEntry(agreeing, entry)).toEqual([]);
  });

  it("returns one disagreement per differing field, naming both values", () => {
    expect(compareWithEntry({ ...agreeing, cct: false, adfDuplex: false }, entry)).toEqual([
      { field: "cct", derived: false, entry: true },
      { field: "adfDuplex", derived: false, entry: true },
    ]);
  });
});

describe("shadow derivation agrees with every replay fixture", () => {
  it.each(REPLAY_FIXTURES)("$model: $path", ({ path }) => {
    const { info, capa } = readInit1Bodies(path);
    const entry = REGISTRY.get(computeCapaFingerprint(capa));
    expect(entry).toBeDefined();
    expect(compareWithEntry(derive(info, capa), entry!)).toEqual([]);
  });
});

// Models with no replay fixture: the CAPA facts their reporters posted in the
// unsupported-printer diagnostic block. A diagnostic carries only the lists
// and the duplex flag (and older blocks have no CCT line), so a CAPA body is
// rebuilt from the lines present and only the fields it determines are
// compared.
const DIAGNOSTICS: ReadonlyArray<{ model: string; issue: number; fp: string; block: string }> = [
  {
    model: "ET-2950",
    issue: 92,
    fp: "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
QIT list:          PREFON  OFF`,
  },
  {
    model: "ET-15000",
    issue: 106,
    fp: "d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55",
    block: `
Source caps:       flatbed: Y  ADF: Y  duplex: N
QIT list:          (absent)
CCT list:          (absent)`,
  },
  {
    model: "ET-2810",
    issue: 132,
    fp: "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
QIT list:          (absent)
CCT list:          (absent)`,
  },
  {
    model: "ET-8500",
    issue: 120,
    fp: "05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467",
    block: `
Source caps:       flatbed: Y  ADF: N  duplex: N
QIT list:          PREFON  OFF
CCT list:          (absent)`,
  },
  {
    model: "WF-3835",
    issue: 174,
    fp: "860a899be9dc4fc27b68f8aed21a49ccfe87733a3974813f0c2ade6810e89dc7",
    block: `
Source caps:       flatbed: Y  ADF: Y  duplex: N
QIT list:          PREFON  OFF
CCT list:          (absent)`,
  },
];

function capaFromDiagnostic(block: string): { body: Buffer; fields: string[] } {
  const segments: string[] = [];
  const fields: string[] = [];
  const duplex = block.match(/duplex: ([YN])/);
  if (duplex) {
    fields.push("adfDuplex");
    if (duplex[1] === "Y") segments.push("#ADFDPLX");
  }
  for (const [label, token, field] of [
    ["QIT", "#QITLIST", "qit"],
    ["CCT", "#CCTLIST", "cct"],
  ] as const) {
    const line = block.match(new RegExp(`^${label} list: +(.+)$`, "m"));
    if (!line) continue;
    fields.push(field);
    if (line[1] !== "(absent)") segments.push(token + line[1]);
  }
  return { body: Buffer.from(segments.join(""), "ascii"), fields };
}

describe("shadow derivation agrees with models known only from issue diagnostics", () => {
  it.each(DIAGNOSTICS)("$model (#$issue)", ({ fp, block }) => {
    const entry: RegistryEntry | undefined = REGISTRY.get(fp);
    expect(entry).toBeDefined();
    const { body, fields } = capaFromDiagnostic(block);
    const disagreements = compareWithEntry(derive(NO_INFO, body), entry!);
    expect(disagreements.filter((d) => fields.includes(d.field))).toEqual([]);
  });

  it("the ET-2950 block predates the CCT line, so CCT goes unchecked for it", () => {
    const et2950 = DIAGNOSTICS.find((d) => d.model === "ET-2950")!;
    expect(capaFromDiagnostic(et2950.block).fields).toEqual(["adfDuplex", "qit"]);
  });
});
