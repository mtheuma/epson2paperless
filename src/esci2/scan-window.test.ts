import { describe, it, expect } from "vitest";
import { isDeepStrictEqual } from "node:util";
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
import { REGISTRY, type Dialect } from "./dialects/registry.js";
import { makeParaSpec, withCapabilities } from "./dialects/dispatch.js";
import { deriveCapabilities } from "./derivation.js";
import { computeCapaFingerprint } from "./capa-fingerprint.js";
import { composePara, scaleAcqExtents, type Extents, type ParaSpec } from "./para-composer.js";
import { advertisedDpiSet } from "./resolution.js";
import { REPLAY_FIXTURES, readInit1Bodies } from "./test-support/capability-bodies.js";
import { recordedDialect } from "./test-support/dialects.js";

const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";
const info = (s: string) => parseInfoTokens(Buffer.from(s, "ascii"));

function fixture(path: string) {
  const { info: infoBody, capa } = readInit1Bodies(path);
  const entry = recordedDialect(computeCapaFingerprint(capa));
  return { info: parseInfoTokens(infoBody), capa: parseCapaTokens(capa), entry };
}

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
  const entry = recordedDialect(ET4950_FP);
  const et4950Info = info(
    "#ADFALGNRIGT#ADFAREAd850i0001400#ADFAMAXd850i0002000#FB ALGNLEFT#FB AREAd850i0001170",
  );

  it("finds none for an entry that fits and follows the alignment", () => {
    expect(windowProblems(et4950Info, entry)).toEqual([]);
  });

  it("reports a window that leaves the largest scan region", () => {
    const tall: Dialect = { ...entry, fbExtents: { x0: 0, y0: 0, w: 2481, h: 3600 } };
    expect(windowProblems(et4950Info, tall)).toEqual([
      expect.objectContaining({ source: "flatbed", problem: "outside-scan-area" }),
    ]);
  });

  it("bounds a standard ADF window by the ADF area, not its long-paper maximum", () => {
    // 4300 rows fit the 20-inch #ADFAMAX (6000) but not the 14-inch area (4200).
    const long: Dialect = { ...entry, adfExtents: { x0: 69, y0: 0, w: 2481, h: 4300 } };
    expect(windowProblems(et4950Info, long)).toEqual([
      expect.objectContaining({ source: "adf", problem: "outside-scan-area" }),
    ]);
  });

  it("reports an x0 the alignment rule doesn't give", () => {
    const shifted: Dialect = { ...entry, adfExtents: { x0: 0, y0: 0, w: 2481, h: 3506 } };
    expect(windowProblems(et4950Info, shifted)).toEqual([
      expect.objectContaining({ source: "adf", problem: "x0-misaligned", expectedX0: 69 }),
    ]);
  });

  it("skips the x0 check when INFO gives no alignment", () => {
    const shifted: Dialect = { ...entry, adfExtents: { x0: 0, y0: 0, w: 2481, h: 3506 } };
    const noAlign = info("#ADFAREAd850i0001400#FB AREAd850i0001170");
    expect(windowProblems(noAlign, shifted)).toEqual([]);
  });

  it.each(REPLAY_FIXTURES)("finds none for the $model entry against $path", ({ path }) => {
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

  it("is null for the flatbed on the adf-crp profile, which has none", () => {
    const tokens = info("#ADFAREAd850i0001550#FB ALGNLEFT#FB AREAd850i0001170");
    expect(genericWindow(tokens, "flatbed", "adf-crp", 200)).toBeNull();
  });

  it("right-aligned area narrower than A4: the whole area, as flush-right A4 clipped would be", () => {
    const tokens = info("#ADFALGNRIGT#ADFAREAd800i0001400");
    expect(genericWindow(tokens, "adf", "standard", 300)).toEqual({
      x0: 0,
      y0: 0,
      w: 2400,
      h: 3506,
    });
  });

  it("is null when clipping leaves nothing to scan", () => {
    expect(
      genericWindow(info("#FB ALGNLEFT#FB AREAd000i0001170"), "flatbed", "standard", 300),
    ).toBeNull();
  });

  // Every source of every fixture model, at every DPI the printer advertises
  // for that source: the window stays inside the scan area at that DPI.
  const cases = REPLAY_FIXTURES.flatMap(({ model, path }) => {
    const { info: tokens, capa, entry } = fixture(path);
    const profile = entry.paraProfile;
    return (["flatbed", "adf"] as WindowSource[]).flatMap((source) => {
      const geometry = sourceGeometry(tokens, source);
      if (geometry === null) return [];
      const dpis = advertisedDpiSet(capa, source === "flatbed" ? "flatbed" : "adf-simplex");
      return dpis.map((dpi) => ({ model, path, source, dpi, tokens, profile, geometry }));
    });
  });

  it("covers both sources and a half-scale DPI", () => {
    expect(new Set(cases.map((c) => c.source))).toEqual(new Set(["flatbed", "adf"]));
    expect(cases.some((c) => c.dpi === 150)).toBe(true);
    expect(cases.some((c) => c.dpi === 75)).toBe(true);
  });

  it.each(cases)(
    "$model $source at $dpi DPI stays inside the scan area ($path)",
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
    // Every fixture of a model must report the same differences; one each.
    const seen = new Set<string>();
    const differences = REPLAY_FIXTURES.flatMap(({ model, path }) => {
      const { info: tokens, entry } = fixture(path);
      return genericWindowDifferences(tokens, entry).map((d) => ({ model, ...d }));
    }).filter((d) => {
      const key = JSON.stringify(d);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
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

describe("model overrides inherit the generic window where theirs matches it", () => {
  // Each fixture model's own window as captured, at its reference DPI: the
  // registry's value where the override keeps it, else the value it carried
  // before it inherited the generic window.
  const A4 = { x0: 0, y0: 0, w: 2481, h: 3506 };
  const A4_RIGHT = { x0: 69, y0: 0, w: 2481, h: 3506 };
  const LETTER = { x0: 0, y0: 0, w: 2550, h: 3300 };
  const CAPTURED: Record<string, Record<WindowSource, Extents | null>> = {
    "ET-4950 family": { flatbed: A4, adf: A4_RIGHT },
    "ET-2750": { flatbed: { x0: 0, y0: 0, w: 2477, h: 3500 }, adf: null },
    "XP-7100": { flatbed: LETTER, adf: LETTER },
    "ET-4800": { flatbed: A4, adf: A4_RIGHT },
    "ET-7700": { flatbed: A4, adf: null },
    "FF-680W": { flatbed: null, adf: { x0: 0, y0: 0, w: 1700, h: 7200 } },
    "DS-575W": { flatbed: null, adf: { x0: 0, y0: 0, w: 1700, h: 3100 } },
  };

  /** One fixture per model and CAPA fingerprint: the window rule reads only INIT1. */
  const models = [
    ...new Map(
      REPLAY_FIXTURES.map(({ model, path }) => {
        const bodies = readInit1Bodies(path);
        const fp = computeCapaFingerprint(bodies.capa);
        const tokens = parseInfoTokens(bodies.info);
        const capa = parseCapaTokens(bodies.capa);
        const entry = REGISTRY.get(fp)!;
        if (!(model in CAPTURED)) {
          throw new Error(`${model} has a replay fixture: record its captured window in CAPTURED`);
        }
        const derived = deriveCapabilities(tokens, capa);
        // The override with its captured window, and as the session runs it.
        const captured = withCapabilities(
          { ...entry, fbExtents: CAPTURED[model].flatbed, adfExtents: CAPTURED[model].adf },
          tokens,
          derived,
        );
        const session = withCapabilities(entry, tokens, derived);
        return [`${model} ${fp}`, { model, entry, tokens, capa, captured, session }] as const;
      }),
    ).values(),
  ];

  /**
   * Every (source, advertised DPI) pair of every fixture model, each checked
   * on its own: the window the captured override sends there (scaled the way
   * composePara scales it), and the generic window.
   */
  const pairs = models.flatMap(({ model, tokens, capa, captured }) =>
    (["flatbed", "adf"] as const).flatMap((source) => {
      const window = source === "flatbed" ? captured.fbExtents : captured.adfExtents;
      if (window === null || sourceGeometry(tokens, source) === null) return [];
      const paraSource = source === "flatbed" ? "flatbed" : "adf-simplex";
      return advertisedDpiSet(capa, paraSource).map((dpi) => ({
        model,
        source,
        dpi,
        override: scaleAcqExtents(captured.paraProfile, window, dpi),
        generic: genericWindow(tokens, source, captured.paraProfile, dpi),
      }));
    }),
  );
  const differing = pairs.filter((p) => !isDeepStrictEqual(p.override, p.generic));
  const differingModels = new Set(differing.map((p) => p.model));

  it("covers every fixture model, both sources, and more than the reference DPIs", () => {
    expect(new Set(pairs.map((p) => p.model))).toEqual(new Set(Object.keys(CAPTURED)));
    expect(new Set(pairs.map((p) => p.source))).toEqual(new Set(["flatbed", "adf"]));
    for (const model of Object.keys(CAPTURED)) {
      expect(pairs.filter((p) => p.model === model).length, model).toBeGreaterThan(2);
    }
  });

  it("differs from the generic window on these pairs only", () => {
    const byModel: Record<string, string[]> = {};
    for (const p of differing) (byModel[p.model] ??= []).push(`${p.source} @ ${p.dpi}`);
    const at = (source: string, dpis: number[]) => dpis.map((dpi) => `${source} @ ${dpi}`);
    expect(byModel).toEqual({
      // 2477 x 3500: a few pixels under A4.
      "ET-2750": at("flatbed", [75, 150, 300, 600, 1200]),
      // US Letter, on both sources.
      "XP-7100": [
        ...at("flatbed", [75, 150, 300, 600, 1200]),
        ...at("adf", [75, 150, 300, 600, 1200]),
      ],
      // A 36-inch page (long paper).
      "FF-680W": at("adf", [50, 75, 100, 150, 200, 240, 300, 360, 400, 600]),
      // The full ADF area: the same window at every DPI but this one (below).
      "DS-575W": at("adf", [75]),
    });
  });

  it("DS-575W at 75 DPI: its rounded scaling passes the area's edge; the generic window is clipped", () => {
    const p = differing.find((d) => d.model === "DS-575W")!;
    expect(p.override).toEqual({ x0: 0, y0: 0, w: 638, h: 1163 });
    expect(p.generic).toEqual({ x0: 0, y0: 0, w: 637, h: 1162 });
  });

  it.each(models)(
    "$model inherits the generic window exactly when every pair matches",
    ({ model, entry }) => {
      const inherits = !differingModels.has(model);
      for (const source of ["flatbed", "adf"] as const) {
        const own = source === "flatbed" ? entry.fbExtents : entry.adfExtents;
        const captured = CAPTURED[model][source];
        if (captured === null) expect(own, `${model} ${source}`).toBeNull();
        else expect(own, `${model} ${source}`).toEqual(inherits ? "generic" : captured);
      }
    },
  );

  // For each model that inherits: every source it has, at every DPI it
  // advertises for that source.
  const paraCases = models
    .filter(({ model }) => !differingModels.has(model))
    .flatMap(({ model, capa, captured, session }) => {
      const sources: ParaSpec["source"][] = [];
      if (captured.fbExtents !== null) sources.push("flatbed");
      if (captured.adfExtents !== null) sources.push("adf-simplex");
      if (captured.adfExtents !== null && captured.adfDuplex) sources.push("adf-duplex");
      return sources.flatMap((source) =>
        advertisedDpiSet(capa, source).map((dpi) => ({ model, source, dpi, captured, session })),
      );
    });

  it("checks PARA for the ET-4950 family, ET-4800 and ET-7700 on every source they have", () => {
    expect(new Set(paraCases.map((c) => c.model))).toEqual(
      new Set(["ET-4950 family", "ET-4800", "ET-7700"]),
    );
    expect(new Set(paraCases.map((c) => c.source))).toEqual(
      new Set(["flatbed", "adf-simplex", "adf-duplex"]),
    );
  });

  it.each(paraCases)(
    "$model $source at $dpi DPI: the PARA is byte-identical to the captured window's",
    ({ source, dpi, captured, session }) => {
      for (const action of ["jpg", "pdf"] as const) {
        const before = composePara(makeParaSpec(captured, source, action, dpi));
        const after = composePara(makeParaSpec(session, source, action, dpi));
        expect(after.equals(before), action).toBe(true);
      }
    },
  );
});
