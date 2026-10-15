import { describe, it, expect } from "vitest";
import {
  alignedX0,
  genericWindow,
  genericWindowDifferences,
  sourceGeometry,
  toPixels,
  windowProblems,
  type WindowSource,
} from "./scan-window.js";
import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";
import { REGISTRY, type RegistryEntry } from "./dialects/registry.js";
import { computeCapaFingerprint } from "./capa-fingerprint.js";
import { scaleAcqExtents } from "./para-composer.js";
import { advertisedDpiSet } from "./resolution.js";
import { REPLAY_FIXTURES, readInit1Bodies } from "./test-support/capability-bodies.js";

const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";
const info = (s: string) => parseInfoTokens(Buffer.from(s, "ascii"));

function fixture(path: string) {
  const { info: infoBody, capa } = readInit1Bodies(path);
  const entry = REGISTRY.get(computeCapaFingerprint(capa))!;
  return { info: parseInfoTokens(infoBody), capa: parseCapaTokens(capa), entry };
}

// One fixture per model is enough here: a model's INFO doesn't vary by session.
const FIXTURE_MODELS = REPLAY_FIXTURES.filter(
  (f, i) => REPLAY_FIXTURES.findIndex((g) => g.model === f.model) === i,
);

describe("sourceGeometry", () => {
  it("reads each source's area (1/100 inch) and alignment from INFO", () => {
    const tokens = info(
      "#ADFALGNRIGT#ADFAREAd850i0001400#ADFAMAXd850i0002000#FB ALGNLEFT#FB AREAd850i0001170",
    );
    expect(sourceGeometry(tokens, "flatbed")).toEqual({
      area: { width: 850, height: 1170 },
      maxArea: { width: 850, height: 1170 },
      align: "LEFT",
    });
    expect(sourceGeometry(tokens, "adf")).toEqual({
      area: { width: 850, height: 1400 },
      maxArea: { width: 850, height: 2000 },
      align: "RIGT",
    });
  });

  it("is null for a source with no area", () => {
    expect(sourceGeometry(info("#FB AREAd850i0001170"), "adf")).toBeNull();
  });

  it("converts 1/100 inch to pixels without overshooting", () => {
    expect(toPixels(850, 300)).toBe(2550);
    expect(toPixels(1170, 300)).toBe(3510);
    expect(toPixels(850, 75)).toBe(637); // 637.5
  });
});

describe("alignedX0", () => {
  it("RIGT is flush with the far edge, LEFT at 0, CNTR centred", () => {
    expect(alignedX0("RIGT", 2550, 2481)).toBe(69);
    expect(alignedX0("LEFT", 2550, 2481)).toBe(0);
    expect(alignedX0("CNTR", 1700, 1700)).toBe(0);
    expect(alignedX0("CNTR", 2550, 2480)).toBe(35);
  });

  it("is null for an unknown or missing alignment", () => {
    expect(alignedX0(null, 2550, 2481)).toBeNull();
    expect(alignedX0("XXXX", 2550, 2481)).toBeNull();
  });
});

describe("windowProblems", () => {
  const entry = REGISTRY.get(ET4950_FP)!;
  const et4950Info = info(
    "#ADFALGNRIGT#ADFAREAd850i0001400#ADFAMAXd850i0002000#FB ALGNLEFT#FB AREAd850i0001170",
  );

  it("finds none for an entry that fits and follows the alignment", () => {
    expect(windowProblems(et4950Info, entry)).toEqual([]);
  });

  it("reports a window that leaves the largest scan region", () => {
    const tall: RegistryEntry = { ...entry, fbExtents: { x0: 0, y0: 0, w: 2481, h: 3600 } };
    expect(windowProblems(et4950Info, tall)).toEqual([
      expect.objectContaining({ source: "flatbed", problem: "outside-scan-area" }),
    ]);
  });

  it("bounds a standard ADF window by the ADF area, not its long-paper maximum", () => {
    // 4300 rows fit the 20-inch #ADFAMAX (6000) but not the 14-inch area (4200).
    const long: RegistryEntry = { ...entry, adfExtents: { x0: 69, y0: 0, w: 2481, h: 4300 } };
    expect(windowProblems(et4950Info, long)).toEqual([
      expect.objectContaining({ source: "adf", problem: "outside-scan-area" }),
    ]);
  });

  it("reports an x0 the alignment rule doesn't give", () => {
    const shifted: RegistryEntry = { ...entry, adfExtents: { x0: 0, y0: 0, w: 2481, h: 3506 } };
    expect(windowProblems(et4950Info, shifted)).toEqual([
      expect.objectContaining({ source: "adf", problem: "x0-misaligned", expectedX0: 69 }),
    ]);
  });

  it("skips the x0 check when INFO gives no alignment", () => {
    const shifted: RegistryEntry = { ...entry, adfExtents: { x0: 0, y0: 0, w: 2481, h: 3506 } };
    const noAlign = info("#ADFAREAd850i0001400#FB AREAd850i0001170");
    expect(windowProblems(noAlign, shifted)).toEqual([]);
  });

  it.each(FIXTURE_MODELS)("finds none for the $model entry against its own INFO", ({ path }) => {
    const { info: tokens, entry: e } = fixture(path);
    expect(windowProblems(tokens, e)).toEqual([]);
  });
});

describe("genericWindow", () => {
  it("standard: A4 at 300 DPI, placed by the alignment rule", () => {
    const tokens = info("#ADFALGNRIGT#ADFAREAd850i0001400#FB ALGNLEFT#FB AREAd850i0001170");
    expect(genericWindow(tokens, "flatbed", "standard", 300)).toEqual({
      x0: 0,
      y0: 0,
      w: 2481,
      h: 3506,
    });
    expect(genericWindow(tokens, "adf", "standard", 300)).toEqual({
      x0: 69,
      y0: 0,
      w: 2481,
      h: 3506,
    });
  });

  it("adf-crp: the full ADF area at 200 DPI", () => {
    const tokens = info("#ADFALGNCNTR#ADFAREAd850i0001550#ADFAMAXd850i0024000");
    expect(genericWindow(tokens, "adf", "adf-crp", 200)).toEqual({
      x0: 0,
      y0: 0,
      w: 1700,
      h: 3100,
    });
  });

  it("clips an area narrower or shorter than A4", () => {
    const tokens = info("#FB ALGNLEFT#FB AREAd800i0001000");
    expect(genericWindow(tokens, "flatbed", "standard", 300)).toEqual({
      x0: 0,
      y0: 0,
      w: 2400,
      h: 3000,
    });
  });

  it("is null for a source with no area", () => {
    expect(genericWindow(info("#FB AREAd850i0001170"), "adf", "standard", 300)).toBeNull();
  });

  it("is null when clipping leaves nothing to scan", () => {
    expect(
      genericWindow(info("#FB ALGNLEFT#FB AREAd000i0001170"), "flatbed", "standard", 300),
    ).toBeNull();
  });

  // Every source of every fixture model, at every DPI the printer advertises
  // for that source: the window stays inside the scan area at that DPI.
  const cases = FIXTURE_MODELS.flatMap(({ model, path }) => {
    const { info: tokens, capa, entry } = fixture(path);
    const profile = entry.paraProfile ?? "standard";
    return (["flatbed", "adf"] as WindowSource[]).flatMap((source) => {
      const geometry = sourceGeometry(tokens, source);
      if (geometry === null) return [];
      const dpis = advertisedDpiSet(capa, source === "flatbed" ? "flatbed" : "adf-simplex");
      return dpis.map((dpi) => ({ model, source, dpi, tokens, profile, geometry }));
    });
  });

  it("covers both sources and a half-scale DPI", () => {
    expect(new Set(cases.map((c) => c.source))).toEqual(new Set(["flatbed", "adf"]));
    expect(cases.some((c) => c.dpi === 150)).toBe(true);
    expect(cases.some((c) => c.dpi === 75)).toBe(true);
  });

  it.each(cases)(
    "$model $source at $dpi DPI stays inside the scan area",
    ({ source, dpi, tokens, profile, geometry }) => {
      const w = genericWindow(tokens, source, profile, dpi)!;
      expect(w.x0).toBeGreaterThanOrEqual(0);
      expect(w.y0).toBeGreaterThanOrEqual(0);
      expect(w.w).toBeGreaterThan(0);
      expect(w.h).toBeGreaterThan(0);
      expect(w.x0 + w.w).toBeLessThanOrEqual(toPixels(geometry.area.width, dpi));
      expect(w.y0 + w.h).toBeLessThanOrEqual(toPixels(geometry.area.height, dpi));
    },
  );

  it("clipping is load-bearing: adf-crp scaling alone overruns the area at 75 DPI", () => {
    // 1700 x 75/200 = 637.5 rounds to 638; the area is 637 pixels wide there.
    const full = { x0: 0, y0: 0, w: 1700, h: 3100 };
    expect(scaleAcqExtents("adf-crp", full, 75).w).toBe(638);
    const tokens = info("#ADFALGNCNTR#ADFAREAd850i0001550");
    expect(genericWindow(tokens, "adf", "adf-crp", 75)!.w).toBe(637);
  });
});

describe("genericWindowDifferences — on record for a future paper-size decision", () => {
  it("the generic window matches every entry except the captured non-A4 sizes", () => {
    const differences = FIXTURE_MODELS.flatMap(({ model, path }) => {
      const { info: tokens, entry } = fixture(path);
      return genericWindowDifferences(tokens, entry).map((d) => ({ model, ...d }));
    });
    expect(differences).toEqual([
      // 2477 x 3500: a few pixels under A4.
      {
        model: "ET-2750",
        source: "flatbed",
        entry: { x0: 0, y0: 0, w: 2477, h: 3500 },
        generic: { x0: 0, y0: 0, w: 2481, h: 3506 },
      },
      // US Letter, flush with the right edge on the ADF.
      {
        model: "XP-7100",
        source: "flatbed",
        entry: { x0: 0, y0: 0, w: 2550, h: 3300 },
        generic: { x0: 0, y0: 0, w: 2481, h: 3506 },
      },
      {
        model: "XP-7100",
        source: "adf",
        entry: { x0: 0, y0: 0, w: 2550, h: 3300 },
        generic: { x0: 69, y0: 0, w: 2481, h: 3506 },
      },
      // A 36-inch page at 200 DPI (long paper), past the 15.5-inch ADF area.
      {
        model: "FF-680W",
        source: "adf",
        entry: { x0: 0, y0: 0, w: 1700, h: 7200 },
        generic: { x0: 0, y0: 0, w: 1700, h: 3100 },
      },
    ]);
  });
});
