import { describe, it, expect } from "vitest";
import { checkColourPair, type ColourPair } from "./colour-pair.js";
import { GAMMA_CLASSES, type GammaClassName } from "./gamma-classes.js";
import { CMX_CLASSES, type CmxClassName } from "./cmx-classes.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "../dialects/dispatch.js";
import { OVERRIDES_BY_FINGERPRINT, type Dialect } from "../dialects/model-overrides.js";
import { recordedDialect } from "../test-support/dialects.js";

// The colour pair a composed PARA body carries, read back from its #GMM, #GMT
// and #CMX segments and named by matching the class bytes.
function pairOnTheWire(body: Buffer): ColourPair {
  const gmmAt = body.indexOf("#GMM");
  const gammas = (Object.keys(GAMMA_CLASSES) as GammaClassName[]).filter((name) =>
    body.includes(GAMMA_CLASSES[name]),
  );
  if (gmmAt < 0 || gammas.length !== 1) throw new Error(`PARA has no single known #GMM/#GMT`);
  const cmxAt = body.indexOf("#CMX");
  let cmx: CmxClassName | null = null;
  if (cmxAt >= 0) {
    const segment = body.subarray(cmxAt, cmxAt + 24);
    const match = (Object.keys(CMX_CLASSES) as CmxClassName[]).find((name) =>
      CMX_CLASSES[name].equals(segment),
    );
    if (match === undefined) throw new Error(`PARA carries an unknown #CMX segment`);
    cmx = match;
  }
  return { gmm: body.subarray(gmmAt + 4, gmmAt + 8).toString("ascii"), gamma: gammas[0], cmx };
}

// Every pair an entry puts on the wire: composed for each action and colour
// mode. The source doesn't change the pair, so one the entry supports will do.
function sentPairs(entry: Dialect): { label: string; pair: ColourPair }[] {
  const source = entry.fbExtents !== null ? "flatbed" : "adf-simplex";
  return (["jpg", "pdf"] as const).flatMap((action) =>
    (["color", "grayscale"] as const).map((colorMode) => ({
      label: `${action} ${colorMode}`,
      pair: pairOnTheWire(composePara(makeParaSpec(entry, source, action, undefined, colorMode))),
    })),
  );
}

const entries = [...OVERRIDES_BY_FINGERPRINT.values()].map((e) =>
  recordedDialect(e.capaFingerprints[0]),
);

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

  it("rejects SoC-style with an Epson-look tone curve", () => {
    expect(checkColourPair({ gmm: "UG10", gamma: "et4800-stock", cmx: null })).toEqual({
      valid: false,
      reason:
        "SoC-style with et4800-stock tone curve, which is epson-look; SoC-style needs a neutral curve",
    });
  });

  it("rejects a missing colour matrix outside UG10", () => {
    expect(checkColourPair({ gmm: "UG18", gamma: "et4950-stock", cmx: null }).valid).toBe(false);
  });
});

describe("model override colour pairs", () => {
  it.each(entries.map((e) => [e.displayName, e]))("%s sends only valid pairs", (_name, entry) => {
    for (const { label, pair } of sentPairs(entry)) {
      expect(checkColourPair(pair), label).toMatchObject({ valid: true });
    }
  });
});
