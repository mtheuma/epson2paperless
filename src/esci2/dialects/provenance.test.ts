// src/esci2/dialects/provenance.test.ts
//
// Holds every model override's provenance to the README compatibility table.
// Provenance has no runtime effect: these checks are the only thing that reads it.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MODEL_OVERRIDES, type Evidence, type ModelOverride } from "./model-overrides.js";
import { colourSettingsHash, provenanceProblems } from "../test-support/provenance.js";

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
      // The ET-8500's colour fix (an identity matrix) with only its old reports.
      const fixed = withOverride("ET-8500", (o) => ({
        ...o,
        cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      }));
      expect(provenanceProblems(README, fixed, UNPLACED)).toEqual([
        expect.stringMatching(/^ET-8500 .*: no colour evidence vouches for its current colour/),
      ]);
    });

    it("passes again once evidence vouches for the new bytes", () => {
      const fixed = withOverride("ET-8500", (o) => {
        const next = { ...o, cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" } as const };
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

    it("fails for a ✅ model no override serves", () => {
      expect(provenanceProblems(README, MODEL_OVERRIDES, {})).toEqual([
        "ET-3700: ✅ in the README, but no model override serves it",
        "WF-2845: ✅ in the README, but no model override serves it",
      ]);
    });

    it("leaves the legacy ESC/I models to their own dialects", () => {
      const legacyOnly = provenanceProblems(
        "| **WF-3620** | ✅&nbsp;Verified | |\n| **XP-620** | ✅&nbsp;Verified | |\n| **ET-2550** | ✅&nbsp;Verified | |",
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
