import { describe, it, expect } from "vitest";
import { checkColourPair, type ColourPair } from "./colour-pair.js";
import { REGISTRY, supportsWireGrayscale, type RegistryEntry } from "../dialects/registry.js";

// Models that send a mixed pair today, by displayName, until their
// reporter-gated colour fix lands.
const KNOWN_MIXED_PAIRS: Readonly<Record<string, string>> = {
  "ET-8500 (ESC/I-2)":
    "ET-4800's Epson-look matrix with a neutral curve picked as the photo default (#120); fix awaits a compatibility-page scan.",
  "ET-7700 (ESC/I-2)":
    "Inherits the ET-8500's pair, pinned by own-capture fixtures (#145); fix awaits a compatibility-page scan.",
};

// Every pair an entry can put on the wire: one per action, plus the greyscale
// LUT with each action's matrix where the entry sends greyscale on the wire.
function sentPairs(entry: RegistryEntry): { label: string; pair: ColourPair }[] {
  return (["jpg", "pdf"] as const).flatMap((action) => {
    const pairs: { label: string; pair: ColourPair }[] = [
      {
        label: action,
        pair: { gmm: entry.gmm, gamma: entry.gammaClass[action], cmx: entry.cmxClass[action] },
      },
    ];
    if (supportsWireGrayscale(entry)) {
      pairs.push({
        label: `${action} grayscale`,
        pair: { gmm: entry.gmm, gamma: entry.monoGammaClass!, cmx: entry.cmxClass[action] },
      });
    }
    return pairs;
  });
}

const entries = [...REGISTRY.values()];

describe("checkColourPair", () => {
  it("accepts a neutral pair", () => {
    expect(checkColourPair({ gmm: "UG18", gamma: "et4950-stock", cmx: "et2750-um08" })).toEqual({
      valid: true,
      kind: "neutral",
    });
  });

  it("accepts an Epson-look pair", () => {
    expect(checkColourPair({ gmm: "UG18", gamma: "et4800-stock", cmx: "et4800-um08" })).toEqual({
      valid: true,
      kind: "epson-look",
    });
  });

  it("rejects a neutral curve with an Epson-look matrix", () => {
    const verdict = checkColourPair({ gmm: "UG18", gamma: "et4950-stock", cmx: "et4800-um08" });
    expect(verdict.valid).toBe(false);
  });

  it("rejects an Epson-look curve with an identity matrix", () => {
    const verdict = checkColourPair({ gmm: "UG18", gamma: "xp7100-jpg", cmx: "xp7100-pdf" });
    expect(verdict).toEqual({
      valid: false,
      reason: "mixed pair: xp7100-jpg tone curve is epson-look, xp7100-pdf matrix is neutral",
    });
  });

  it("accepts SoC-style: UG10 with no colour matrix", () => {
    expect(checkColourPair({ gmm: "UG10", gamma: "et4950-stock", cmx: null })).toEqual({
      valid: true,
      kind: "soc-style",
    });
  });

  it("rejects a missing colour matrix outside UG10", () => {
    expect(checkColourPair({ gmm: "UG18", gamma: "et4950-stock", cmx: null }).valid).toBe(false);
  });
});

describe("registry colour pairs", () => {
  it.each(
    entries.filter((e) => !(e.displayName in KNOWN_MIXED_PAIRS)).map((e) => [e.displayName, e]),
  )("%s sends only valid pairs", (_name, entry) => {
    for (const { label, pair } of sentPairs(entry)) {
      expect(checkColourPair(pair), label).toMatchObject({ valid: true });
    }
  });

  it.each(Object.keys(KNOWN_MIXED_PAIRS))("known exception %s still sends a mixed pair", (name) => {
    const entry = entries.find((e) => e.displayName === name);
    expect(entry, `${name} is not in the registry`).toBeDefined();
    const invalid = sentPairs(entry!).filter(({ pair }) => !checkColourPair(pair).valid);
    expect(invalid, "fixed: drop it from KNOWN_MIXED_PAIRS").not.toHaveLength(0);
  });
});
