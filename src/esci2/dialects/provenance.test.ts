// src/esci2/dialects/provenance.test.ts
//
// Holds every model override's provenance to the README compatibility table.
// Provenance has no runtime effect: these checks are the only thing that reads it.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MODEL_OVERRIDES, type Evidence, type ModelOverride } from "./model-overrides.js";
import {
  colourSettingsHash,
  provenanceProblems,
  provisionalColourModels,
  verifiedReadmeModels,
} from "../test-support/provenance.js";

const README = readFileSync("README.md", "utf8");

// ✅ models that reached an existing override by sharing its CAPA fingerprint,
// with a report of their own, but whose override was never recorded: no log
// from them names the dialect they resolved. Each leaves this list when a
// debug log places it in an override's siblings.
const UNPLACED: Readonly<Record<string, readonly Evidence[]>> = {
  "WF-2845": [{ kind: "reporter-report", link: { issue: 178 } }],
  "ET-3700": [{ kind: "reporter-report", link: { issue: 228 } }],
};

/** A copy of the overrides with one changed, by model name. */
function withOverride(model: string, change: (o: ModelOverride) => ModelOverride): ModelOverride[] {
  const at = MODEL_OVERRIDES.findIndex((o) => o.provenance.models.includes(model));
  if (at < 0) throw new Error(`no override records ${model}`);
  return MODEL_OVERRIDES.map((o, i) => (i === at ? change(o) : o));
}

const overrideFor = (model: string): ModelOverride =>
  MODEL_OVERRIDES.find((o) => o.provenance.models.includes(model))!;

describe("colourSettingsHash", () => {
  const et4800 = overrideFor("ET-4800");

  it("is the same for two models sending the same colour settings", () => {
    // The WF-3835 inherited the ET-4800's pair.
    expect(colourSettingsHash(overrideFor("WF-3835"))).toBe(colourSettingsHash(et4800));
  });

  it("changes with any colour byte: gamma, matrix, gamma mode or mono gamma", () => {
    const base = colourSettingsHash(et4800);
    const changed = [
      { ...et4800, gammaClass: { ...et4800.gammaClass, pdf: "et4950-stock" as const } },
      { ...et4800, cmxClass: { ...et4800.cmxClass, jpg: "et2750-um08" as const } },
      { ...et4800, gmm: "UG10" },
      { ...et4800, monoGammaClass: "ds575w-mono" as const },
    ].map(colourSettingsHash);
    for (const hash of changed) expect(hash).not.toBe(base);
    expect(new Set(changed).size).toBe(changed.length);
  });

  it("tells the JPG settings from the PDF ones", () => {
    const xp7100 = overrideFor("XP-7100");
    const swapped = {
      ...xp7100,
      gammaClass: { jpg: xp7100.gammaClass.pdf, pdf: xp7100.gammaClass.jpg },
      cmxClass: { jpg: xp7100.cmxClass.pdf, pdf: xp7100.cmxClass.jpg },
    };
    expect(colourSettingsHash(swapped)).not.toBe(colourSettingsHash(xp7100));
  });
});

describe("verifiedReadmeModels", () => {
  // Guards the provenance check against passing vacuously: if the README
  // table's format drifts so no row parses, every ✅ model goes unchecked.
  it("reads every ✅ row of the real README, splitting shared rows", () => {
    const models = verifiedReadmeModels(README);
    expect(models).toEqual(
      expect.arrayContaining(["ET-4950", "ET-4956", "ET-2750", "XP-7100", "WF-3620", "XP-620"]),
    );
    expect(models).not.toContain("DS-575W"); // 🟡 Experimental
    // A looser read of the table, any row whose status cell starts with ✅,
    // finds the same rows: a ✅ row whose format drifted fails here.
    const rows = README.split(/\r?\n/).filter((line) => /^\|[^|]*\|\s*✅/.test(line));
    const loose = rows.flatMap((row) =>
      row
        .split("|")[1]
        .replace(/\*/g, "")
        .split("/")
        .map((m) => m.trim()),
    );
    expect(models).toEqual(loose);
  });
});

describe("provenance", () => {
  it("passes for every override and every ✅ model in the README", () => {
    expect(provenanceProblems(README, MODEL_OVERRIDES, UNPLACED)).toEqual([]);
  });

  it("gives every override a provenance list for colour, window and poll count", () => {
    for (const o of MODEL_OVERRIDES) {
      expect(o.provenance.models.length, o.displayName).toBeGreaterThan(0);
      for (const group of [o.provenance.colour, o.provenance.window, o.provenance.pollCount]) {
        expect(group.length, o.displayName).toBeGreaterThan(0);
      }
    }
  });

  it("pins the models that share another model's override, and those not yet placed", () => {
    const siblings = Object.fromEntries(
      MODEL_OVERRIDES.flatMap((o) =>
        Object.keys(o.provenance.siblings ?? {}).map((m) => [m, o.provenance.models[0]]),
      ),
    );
    expect(siblings).toEqual({ "ET-3950": "ET-4950", "XP-4100": "ET-2750", "XP-3200": "ET-2810" });
    expect(Object.keys(UNPLACED)).toEqual(["WF-2845", "ET-3700"]);
  });

  describe("colour", () => {
    it("fails when a ✅ model's colour bytes change without new evidence", () => {
      // The ET-4800 sending the identity matrix with only its old capture.
      const fixed = withOverride("ET-4800", (o) => ({
        ...o,
        cmxClass: { jpg: "identity-um08", pdf: "identity-um08" },
      }));
      expect(provenanceProblems(README, fixed, UNPLACED)).toEqual([
        expect.stringMatching(/^ET-4800 .*: no colour evidence vouches for its current colour/),
      ]);
    });

    it("passes again once evidence vouches for the new bytes", () => {
      const fixed = withOverride("ET-4800", (o) => {
        const next = { ...o, cmxClass: { jpg: "identity-um08", pdf: "identity-um08" } as const };
        const scan: (typeof o.provenance.colour)[number] = {
          kind: "reporter-scan",
          link: { issue: 120 },
          vouchesFor: colourSettingsHash(next),
        };
        return { ...next, provenance: { ...o.provenance, colour: [...o.provenance.colour, scan] } };
      });
      expect(provenanceProblems(README, fixed, UNPLACED)).toEqual([]);
    });

    it("is never satisfied by an own capture or an inherited setting", () => {
      // The ET-7700's colour without its reporter's compatibility-page scan.
      const unscanned = withOverride("ET-7700", (o) => ({
        ...o,
        provenance: {
          ...o.provenance,
          colour: o.provenance.colour.filter((e) => e.kind !== "reporter-scan"),
        },
      }));
      expect(overrideFor("ET-7700").provenance.colour.map((e) => e.kind)).toEqual([
        "inherited:ET-8500",
        "own-capture",
        "reporter-scan",
      ]);
      expect(provenanceProblems(README, unscanned, UNPLACED)).toEqual([
        expect.stringMatching(/^ET-7700 .*: no colour evidence vouches/),
      ]);
    });
  });

  describe("provisional colour", () => {
    const XP7100_CAPTURE = "tools/pcap-extract/captures/xp-7100/jpg-flatbed.jsonl";

    /**
     * The ET-4800, whose colour is confirmed, given the XP-7100's colour pair
     * and resting only on that inheritance and provisional evidence for those
     * bytes: its capture vouched for the old ones.
     */
    const provisionalEt4800 = (): ModelOverride[] =>
      withOverride("ET-4800", (o) => {
        const { gmm, gammaClass, cmxClass } = overrideFor("XP-7100");
        const next = { ...o, gmm, gammaClass, cmxClass };
        const hash = colourSettingsHash(next);
        return {
          ...next,
          provenance: {
            ...o.provenance,
            colour: [
              ...o.provenance.colour.filter((e) => !e.kind.startsWith("inherited:")),
              { kind: "inherited:XP-7100", link: { fixture: XP7100_CAPTURE }, vouchesFor: hash },
              { kind: "provisional", link: { fixture: XP7100_CAPTURE }, vouchesFor: hash },
            ],
          },
        };
      });

    /** The README with a Notes cell gaining the caveat, by model row. */
    const withCaveat = (readme: string, row: string): string =>
      readme
        .split("\n")
        .map((line) => {
          if (!line.startsWith(`| **${row}**`)) return line;
          const cells = line.split("|");
          cells[3] = ` ${cells[3].trim()}; colours not yet confirmed on hardware `;
          return cells.join("|");
        })
        .join("\n");

    it("pins the ✅ models whose colour rests only on provisional evidence", () => {
      // Adding a model here, or removing one, is a deliberate change: each
      // listed model carries the README caveat until a scan or capture
      // supersedes its provisional evidence.
      expect(provisionalColourModels(README, MODEL_OVERRIDES)).toEqual(["ET-8500"]);
    });

    it("satisfies the ✅ colour check, and is reported as provisional", () => {
      const overrides = provisionalEt4800();
      expect(provisionalColourModels(README, overrides)).toEqual(["ET-4800", "ET-8500"]);
      expect(provenanceProblems(withCaveat(README, "ET-4800"), overrides, UNPLACED)).toEqual([]);
    });

    it("fails for a provisional model whose README Notes lack the caveat", () => {
      expect(provenanceProblems(README, provisionalEt4800(), UNPLACED)).toEqual([
        'ET-4800: its colour rests only on provisional evidence, but its README Notes lack "colours not yet confirmed on hardware"',
      ]);
    });

    it("is superseded by a reporter scan of the same bytes", () => {
      const scanned = provisionalEt4800().map((o) => {
        if (!o.provenance.models.includes("ET-4800")) return o;
        const scan = {
          kind: "reporter-scan",
          link: { issue: 120 },
          vouchesFor: colourSettingsHash(o),
        } as const;
        return { ...o, provenance: { ...o.provenance, colour: [...o.provenance.colour, scan] } };
      });
      expect(provisionalColourModels(README, scanned)).toEqual(["ET-8500"]);
      expect(provenanceProblems(README, scanned, UNPLACED)).toEqual([]);
    });

    it("must sit next to an inherited setting and link its capture", () => {
      const at = (colour: ModelOverride["provenance"]["colour"]): ModelOverride[] =>
        withOverride("ET-4800", (o) => ({ ...o, provenance: { ...o.provenance, colour } }));
      const hash = colourSettingsHash(overrideFor("ET-4800"));
      const report = { kind: "reporter-report", link: { issue: 120 }, vouchesFor: hash } as const;
      expect(
        provenanceProblems(
          README,
          at([
            report,
            { kind: "provisional", link: { fixture: XP7100_CAPTURE }, vouchesFor: hash },
          ]),
          UNPLACED,
        ),
      ).toEqual([
        "ET-4800 (ESC/I-2 over plain TCP): its provisional colour evidence sits next to no inherited setting",
      ]);
      expect(
        provenanceProblems(
          README,
          at([
            report,
            { kind: "inherited:ET-4950", link: { pr: 121 }, vouchesFor: hash },
            { kind: "provisional", link: { pr: 121 }, vouchesFor: hash },
          ]),
          UNPLACED,
        ),
      ).toEqual([
        "ET-4800 (ESC/I-2 over plain TCP): its provisional colour evidence links no capture (a fixture)",
      ]);
    });

    it("is evidence for colour only", () => {
      const misplaced = withOverride("ET-2810", (o) => ({
        ...o,
        provenance: {
          ...o.provenance,
          window: [
            ...o.provenance.window,
            { kind: "provisional", link: { fixture: XP7100_CAPTURE } },
          ],
          siblings: { "XP-3200": [{ kind: "provisional", link: { fixture: XP7100_CAPTURE } }] },
        },
      }));
      expect(provenanceProblems(README, misplaced, UNPLACED)).toEqual([
        "XP-3200: shares the ET-2810 / XP-3200 (ESC/I-2) override but has no report of its own",
        "ET-2810 / XP-3200 (ESC/I-2): window carries provisional evidence, which is for colour only",
        "ET-2810 / XP-3200 (ESC/I-2): XP-3200 carries provisional evidence, which is for colour only",
      ]);
    });

    it("doesn't vouch for colour bytes changed after it was recorded", () => {
      const changed = provisionalEt4800().map((o) =>
        o.provenance.models.includes("ET-4800") ? { ...o, gmm: "UG10" } : o,
      );
      expect(provisionalColourModels(README, changed)).toEqual(["ET-8500"]);
      expect(provenanceProblems(README, changed, UNPLACED)).toEqual([
        expect.stringMatching(/^ET-4800 .*: no colour evidence vouches for its current colour/),
      ]);
    });

    it("fails for a caveat left on a model whose colour is confirmed", () => {
      // A reporter scan supersedes the provisional entry; the caveat goes with it.
      expect(provenanceProblems(withCaveat(README, "ET-2750"), MODEL_OVERRIDES, UNPLACED)).toEqual([
        'ET-2750: its README Notes say "colours not yet confirmed on hardware", but its colour isn\'t provisional',
      ]);
    });
  });

  describe("README ✅ models", () => {
    it("fails for a ✅ fingerprint sibling with no report of its own", () => {
      const unreported = withOverride("ET-4950", (o) => ({
        ...o,
        provenance: { ...o.provenance, siblings: { "ET-3950": [] } },
      }));
      expect(provenanceProblems(README, unreported, UNPLACED)).toEqual([
        "ET-3950: shares the ET-4950 / ET-3950 / ET-4956 (ESC/I-2 over TLS) override but has no report of its own",
      ]);
    });

    it("doesn't count an inheritance as a sibling's own report", () => {
      const inherited = withOverride("ET-2750", (o) => ({
        ...o,
        provenance: {
          ...o.provenance,
          siblings: { "XP-4100": [{ kind: "inherited:ET-2750", link: { pr: 142 } }] },
        },
      }));
      expect(provenanceProblems(README, inherited, UNPLACED)).toEqual([
        "XP-4100: shares the ET-2750 / XP-4100 (ESC/I-2 over plain TCP) override but has no report of its own",
      ]);
    });

    it("holds an unplaced model's report to the same rules", () => {
      expect(
        provenanceProblems(README, MODEL_OVERRIDES, {
          ...UNPLACED,
          "WF-2845": [{ kind: "reporter-report", link: { fixture: "tools/no-such-report.md" } }],
          "ET-3700": [{ kind: "inherited:ET-2750", link: { issue: 228 } }],
        }),
      ).toEqual([
        "ET-3700: ✅ in the README, but no model override serves it",
        "WF-2845: its report links a fixture that doesn't exist (tools/no-such-report.md)",
      ]);
    });

    it("fails for a ✅ model no override serves", () => {
      expect(provenanceProblems(README, MODEL_OVERRIDES, {})).toEqual([
        "ET-3700: ✅ in the README, but no model override serves it",
        "WF-2845: ✅ in the README, but no model override serves it",
      ]);
    });

    it("leaves the legacy ESC/I models to their own dialects", () => {
      const legacyOnly = provenanceProblems(
        "| **WF-3620** | ✅&nbsp;Verified | |\n| **XP-620** | ✅&nbsp;Verified | |\n| **ET-2550** | ✅&nbsp;Verified | Colours not yet confirmed on hardware |",
        MODEL_OVERRIDES,
        {},
      );
      expect(legacyOnly).toEqual([]);
    });

    it("holds only ✅ models to the checks", () => {
      // The WF-3835 is 🟡: its inherited colour carries no reporter scan.
      const wf3835 = overrideFor("WF-3835");
      const bare = withOverride("WF-3835", (o) => ({
        ...o,
        provenance: {
          ...o.provenance,
          colour: o.provenance.colour.filter((e) => e.kind.startsWith("inherited:")),
          window: o.provenance.window.filter((e) => e.kind.startsWith("inherited:")),
          pollCount: o.provenance.pollCount.filter((e) => e.kind.startsWith("inherited:")),
        },
      }));
      expect(wf3835.provenance.colour.length).toBeGreaterThan(0);
      expect(provenanceProblems(README, bare, UNPLACED)).toEqual([]);
    });
  });

  describe("window and poll count", () => {
    it("fail for a ✅ model whose evidence is inherited only", () => {
      const inheritedOnly = withOverride("ET-2810", (o) => ({
        ...o,
        provenance: {
          ...o.provenance,
          window: o.provenance.window.filter((e) => e.kind.startsWith("inherited:")),
          pollCount: o.provenance.pollCount.filter((e) => e.kind.startsWith("inherited:")),
        },
      }));
      expect(provenanceProblems(README, inheritedOnly, UNPLACED)).toEqual([
        "ET-2810 / XP-3200 (ESC/I-2): its window evidence is inherited only",
        "ET-2810 / XP-3200 (ESC/I-2): its pollCount evidence is inherited only",
      ]);
    });

    it("are satisfied by an own capture", () => {
      const ownOnly = withOverride("ET-7700", (o) => ({
        ...o,
        provenance: {
          ...o.provenance,
          window: o.provenance.window.filter((e) => e.kind === "own-capture"),
          pollCount: o.provenance.pollCount.filter((e) => e.kind === "own-capture"),
        },
      }));
      expect(provenanceProblems(README, ownOnly, UNPLACED)).toEqual([]);
    });
  });

  describe("links", () => {
    it("fail for a fixture that isn't in the tree", () => {
      const missing = withOverride("ET-2750", (o) => ({
        ...o,
        provenance: {
          ...o.provenance,
          window: [{ kind: "epson-capture", link: { fixture: "tools/no-such-capture.jsonl" } }],
        },
      }));
      expect(provenanceProblems(README, missing, UNPLACED)).toEqual([
        "ET-2750 / XP-4100 (ESC/I-2 over plain TCP): window links a fixture that doesn't exist (tools/no-such-capture.jsonl)",
      ]);
    });

    it("fail for an inheritance from a model no override records", () => {
      const stray = withOverride("ET-2950", (o) => ({
        ...o,
        provenance: {
          ...o.provenance,
          pollCount: [{ kind: "inherited:ET-9999", link: { pr: 94 } }],
        },
      }));
      expect(provenanceProblems(README, stray, UNPLACED)).toEqual([
        "ET-2950 (ESC/I-2 over TLS): pollCount is inherited from ET-9999, which no override records",
      ]);
    });
  });
});
