import { describe, it, expect, vi } from "vitest";
import {
  lookupRegistryEntry,
  applyEntrySourceOverride,
  makeParaSpec,
  assertSourceSupported,
} from "./dispatch.js";
import { REGISTRY } from "./registry.js";
import { UnsupportedDialectError } from "../diagnostic.js";
import { computeCapaFingerprint } from "../capa-fingerprint.js";
import { parseCapaTokens, parseInfoTokens } from "../capabilities.js";
import { deriveCapabilities } from "../derivation.js";
import { composePara } from "../para-composer.js";
import { parseParaSegments } from "../test-support/para-parse.js";
import { REPLAY_FIXTURES, readInit1Bodies } from "../test-support/capability-bodies.js";
import { recordedDialect } from "../test-support/dialects.js";

const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";
const ET2750_FP = "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7";
const ET2810_FP = "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e";
const FF680W_FP = "5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd";
const UNKNOWN_FP = "0000000000000000000000000000000000000000000000000000000000000000";
const ET4800_FP = "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2";

const STUB_CAPA = Buffer.from("#GMMLISTUG10UG18#CMXLISTUNITUM08#FMTLISTRAW JPG ", "ascii"); // minimal stub
const UNKNOWN_PID_INFO = Buffer.from("#PRDh010PID 9999        #FB AREAd850i0001170", "ascii");

const ET4950 = readInit1Bodies(
  "tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl",
);
const XP7100 = readInit1Bodies("tools/pcap-extract/captures/xp-7100/jpg-flatbed.jsonl");
const FF680W = readInit1Bodies("tools/pcap-extract/captures/ff-680w/adf-simplex-200.jsonl");

/** A CAPA body no registry entry was recorded with: one extra segment. */
const doctored = (capa: Buffer) => Buffer.concat([capa, Buffer.from("#ZZZZd001", "ascii")]);

/**
 * Runs the lookup with the console captured; returns the result, the
 * warnings, and the info lines.
 */
function lookup(info: Buffer, capa: Buffer, fingerprint = computeCapaFingerprint(capa)) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const resolved = lookupRegistryEntry({
      info: parseInfoTokens(info),
      capa: parseCapaTokens(capa),
      fingerprint,
      infoBody: info,
      capaBody: capa,
      transport: "plain",
    });
    return {
      resolved,
      warnings: warn.mock.calls.map((args) => args.join(" ")),
      infos: log.mock.calls.map((args) => args.join(" ")),
    };
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
}

describe("lookupRegistryEntry", () => {
  it("resolves by the INFO product ID first", () => {
    const { resolved, warnings } = lookup(ET4950.info, ET4950.capa);
    expect(resolved.entry).toMatchObject(REGISTRY.get(ET4950_FP)!);
    expect(resolved.matchedBy).toBe("pid");
    expect(warnings).toEqual([]);
  });

  it("resolves by the INFO product name when the printer reports a name", () => {
    const { resolved, warnings } = lookup(FF680W.info, FF680W.capa);
    expect(resolved.entry).toMatchObject(REGISTRY.get(FF680W_FP)!);
    expect(resolved.matchedBy).toBe("name");
    expect(warnings).toEqual([]);
  });

  // The ET-3950 and XP-4100 case: a model whose PID isn't recorded resolves
  // through the CAPA fingerprint it shares with a sibling.
  it("falls back to the CAPA fingerprint when the PID isn't recorded", () => {
    const { resolved, warnings } = lookup(UNKNOWN_PID_INFO, ET4950.capa);
    expect(resolved.entry).toMatchObject(REGISTRY.get(ET4950_FP)!);
    expect(resolved.matchedBy).toBe("fingerprint");
    expect(warnings).toEqual([]);
  });

  it("matches the PID case-insensitively", () => {
    const info = Buffer.from("#PRDh010PID 11d1        ", "ascii");
    expect(lookup(info, STUB_CAPA, UNKNOWN_FP).resolved.entry).toMatchObject(
      REGISTRY.get(ET4950_FP)!,
    );
  });

  describe("a PID or name hit with a CAPA fingerprint the model wasn't recorded with", () => {
    it("warns with the diagnostic and proceeds with the identified model (PID)", () => {
      const capa = doctored(ET4950.capa);
      const fingerprint = computeCapaFingerprint(capa);
      expect(REGISTRY.has(fingerprint)).toBe(false);
      const { resolved, warnings } = lookup(ET4950.info, capa, fingerprint);
      expect(resolved.entry).toMatchObject(REGISTRY.get(ET4950_FP)!);
      expect(resolved.matchedBy).toBe("pid");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("by its PID 11D1");
      expect(warnings[0]).toContain(`CAPA fingerprint:  ${fingerprint}`);
      expect(warnings[0]).toContain("PRD:               PID 11D1");
    });

    it("warns with the diagnostic and proceeds with the identified model (name)", () => {
      const { resolved, warnings } = lookup(FF680W.info, doctored(FF680W.capa));
      expect(resolved.entry).toMatchObject(REGISTRY.get(FF680W_FP)!);
      expect(resolved.matchedBy).toBe("name");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("by its product name FF-680W");
      expect(warnings[0]).toContain("PRD:               FF-680W");
    });

    it("names the model the fingerprint belongs to, and still follows the PID", () => {
      const { resolved, warnings } = lookup(ET4950.info, XP7100.capa);
      expect(resolved.entry).toMatchObject(REGISTRY.get(ET4950_FP)!);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("it is the XP-7100");
    });
  });

  describe("a printer whose PID, name and fingerprint are all unknown", () => {
    it("gets the generic dialect, with a warning and the diagnostic block at info", () => {
      const { resolved, warnings, infos } = lookup(UNKNOWN_PID_INFO, STUB_CAPA, UNKNOWN_FP);
      expect(resolved.matchedBy).toBe("generic");
      expect(resolved.entry.displayName).toBe("generic ESC/I-2 dialect (PID 9999)");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        "PID 9999 not recognised — generic ESC/I-2 dialect, experimental, please report",
      );
      const diagnostic = infos.filter((line) => line.includes("CAPA fingerprint:"));
      expect(diagnostic).toHaveLength(1);
      expect(diagnostic[0]).toContain("[INFO]");
      expect(diagnostic[0]).toContain(`CAPA fingerprint:  ${UNKNOWN_FP}`);
      expect(diagnostic[0]).toContain("PRD:               PID 9999");
      expect(diagnostic[0]).toContain("esci2-plain");
    });

    it("an unknown product name is named in the warning and the diagnostic", () => {
      const info = Buffer.from("#PRDh007XX-000W\0#ADFAREAd850i0001400", "latin1");
      const { resolved, warnings, infos } = lookup(info, STUB_CAPA, UNKNOWN_FP);
      expect(resolved.matchedBy).toBe("generic");
      expect(warnings[0]).toContain("XX-000W not recognised");
      expect(infos.join("\n")).toContain("PRD:               XX-000W");
    });

    it("fails fast with the diagnostic when INFO advertises no scan area", () => {
      const info = Buffer.from("#PRDh010PID 9999        ", "ascii");
      try {
        lookup(info, STUB_CAPA, UNKNOWN_FP);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedDialectError);
        const e = err as UnsupportedDialectError;
        expect(e.reason).toBe("its INFO reply advertises no scan area");
        expect(e.capaFingerprint).toBe(UNKNOWN_FP);
        expect(e.diagnostic).toContain("PRD:               PID 9999");
      }
    });

    it("fails fast with the diagnostic when CAPA can't be parsed", () => {
      try {
        lookup(UNKNOWN_PID_INFO, Buffer.from("garbage", "ascii"), UNKNOWN_FP);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedDialectError);
        expect((err as UnsupportedDialectError).reason).toBe("its CAPA reply couldn't be parsed");
      }
    });
  });

  // Every replay fixture must resolve by its model identity to the entry its
  // fingerprint names, silently: the identity lookup changes nothing sent.
  // The FF-680W and DS-575W resolve by name, so no trigger has to supply one.
  it.each(REPLAY_FIXTURES)("resolves the $model fixture $path by identity", ({ model, path }) => {
    const { info, capa } = readInit1Bodies(path);
    const { resolved, warnings } = lookup(info, capa);
    expect(resolved.entry).toMatchObject(REGISTRY.get(computeCapaFingerprint(capa))!);
    expect(resolved.matchedBy).toBe(model === "FF-680W" || model === "DS-575W" ? "name" : "pid");
    expect(warnings).toEqual([]);
  });
});

describe("applyEntrySourceOverride", () => {
  it("pins ctx.source = 'flatbed' for fixed-flatbed entries", () => {
    const entry = recordedDialect(ET2750_FP); // fixed-flatbed
    const ctx = { source: "adf" as "adf" | "flatbed", duplex: false };
    applyEntrySourceOverride(ctx, entry);
    expect(ctx.source).toBe("flatbed");
  });

  it("pins ctx.source = 'adf' for fixed-adf entries", () => {
    const entry = recordedDialect(FF680W_FP); // fixed-adf
    const ctx = { source: "flatbed" as "adf" | "flatbed", duplex: false };
    applyEntrySourceOverride(ctx, entry);
    expect(ctx.source).toBe("adf");
  });

  it("leaves ctx.source unchanged for stat-length entries", () => {
    const entry = recordedDialect(ET4950_FP); // stat-length
    const ctx = { source: "adf" as "adf" | "flatbed", duplex: false };
    applyEntrySourceOverride(ctx, entry);
    expect(ctx.source).toBe("adf");
  });
});

describe("makeParaSpec", () => {
  it("projects entry + flatbed onto ParaSpec.fbExtents", () => {
    const entry = recordedDialect(ET4950_FP);
    const spec = makeParaSpec(entry, "flatbed", "jpg");
    expect(spec.source).toBe("flatbed");
    expect(spec.action).toBe("jpg");
    expect(spec.gmm).toBe("UG10");
    expect(spec.fbExtents).toEqual(entry.fbExtents);
    expect(spec.adfExtents).toEqual(entry.adfExtents);
    expect(spec.optionalSegments).toEqual({ qit: true, cct: true });
  });

  it("projects entry + adf-simplex correctly", () => {
    const entry = recordedDialect(ET4950_FP);
    const spec = makeParaSpec(entry, "adf-simplex", "jpg");
    expect(spec.source).toBe("adf-simplex");
  });

  it("projects entry + adf-duplex correctly", () => {
    const entry = recordedDialect(ET4950_FP);
    const spec = makeParaSpec(entry, "adf-duplex", "pdf");
    expect(spec.source).toBe("adf-duplex");
    expect(spec.action).toBe("pdf");
  });

  it("projects FF-680W paraProfile", () => {
    const entry = recordedDialect(FF680W_FP);
    const spec = makeParaSpec(entry, "adf-duplex", "jpg");
    expect(spec.profile).toBe("adf-crp");
  });
});

describe("an override's capability fields follow the printer's own replies", () => {
  // The ET-2950 (PID 11D0) is known only from a diagnostic with no CCT line,
  // so whether it sends #CCT is whatever its live CAPA lists.
  const ET2950_INFO = Buffer.from("#PRDh010PID 11D0        #FB AREAd850i0001170", "ascii");

  it.each([
    ["#QITLISTPREFON  OFF #CCTLISTPREFCOL MONO", { qit: true, cct: true }],
    ["#QITLISTPREFON  OFF ", { qit: true, cct: false }],
    ["#CCTLISTPREFMONO", { qit: false, cct: false }],
  ])("ET-2950 with CAPA lists %j sends %o", (lists, segments) => {
    const { resolved } = lookup(ET2950_INFO, Buffer.from(lists + "#GMMLISTUG10", "ascii"));
    expect(resolved.matchedBy).toBe("pid");
    expect(resolved.entry.displayName).toMatch(/ET-2950/);
    expect(resolved.entry.optionalSegments).toEqual(segments);
    expect(resolved.entry.paraProfile).toBe("standard");
  });

  it("a known crop-mode scanner whose CAPA drops #ADFCRP gets the standard profile", () => {
    const text = FF680W.capa.toString("latin1");
    expect(text).toContain("#ADFCRP");
    const capa = Buffer.from(text.replace(/#ADFCRP[^#]*/, ""), "latin1");
    const { resolved } = lookup(FF680W.info, capa);
    expect(resolved.matchedBy).toBe("name");
    expect(resolved.entry.paraProfile).toBe("standard");
    // Its window (1700 x 7200 at 200 DPI, 8.5 x 36 in) keeps its physical
    // size at the standard profile's 300 DPI reference, and on the wire.
    expect(resolved.entry.adfExtents).toEqual({ x0: 0, y0: 0, w: 2550, h: 10800 });
    const para = composePara(makeParaSpec(resolved.entry, "adf-simplex", "jpg", 300));
    const acq = parseParaSegments(para).find((s) => s.code === "ACQ");
    expect(acq?.values).toEqual([0, 0, 2550, 10800]);
  });

  it("keeps a crop-mode scanner's window as recorded when its profile matches", () => {
    const { resolved } = lookup(FF680W.info, FF680W.capa);
    expect(resolved.entry.paraProfile).toBe("adf-crp");
    expect(resolved.entry.adfExtents).toEqual(REGISTRY.get(FF680W_FP)!.adfExtents);
  });

  it("returns the derivation the dialect was completed with", () => {
    const { resolved } = lookup(ET4950.info, ET4950.capa);
    expect(resolved.derived).toEqual(
      deriveCapabilities(parseInfoTokens(ET4950.info), parseCapaTokens(ET4950.capa)),
    );
    expect(resolved.entry.optionalSegments).toEqual({
      qit: resolved.derived.qit,
      cct: resolved.derived.cct,
    });
  });
});

describe("assertSourceSupported", () => {
  it("rejects adf-duplex on a simplex-only ADF", () => {
    const entry = recordedDialect(ET4800_FP);
    expect(() => assertSourceSupported(entry, "adf-duplex")).toThrow(/no duplex ADF/);
  });

  it("names the model and the fix in the error", () => {
    const entry = recordedDialect(ET4800_FP);
    expect(() => assertSourceSupported(entry, "adf-duplex")).toThrow(/ET-4800/);
    expect(() => assertSourceSupported(entry, "adf-duplex")).toThrow(/SCAN_SIDES=simplex/);
  });

  it("allows adf-simplex on a simplex-only ADF", () => {
    const entry = recordedDialect(ET4800_FP);
    expect(() => assertSourceSupported(entry, "adf-simplex")).not.toThrow();
  });

  it("refuses adf-duplex on a known duplex model whose CAPA doesn't advertise it", () => {
    // The ET-4950 family's ADF is duplex, but the session goes by the
    // printer's own CAPA: without #ADFDPLX, its dialect has no duplex ADF.
    const text = ET4950.capa.toString("latin1");
    expect(text).toContain("#ADFDPLX");
    const capa = Buffer.from(text.replace("#ADFDPLX", ""), "latin1");
    const { resolved } = lookup(ET4950.info, capa);
    expect(resolved.matchedBy).toBe("pid");
    expect(resolved.entry.adfDuplex).toBe(false);
    expect(() => assertSourceSupported(resolved.entry, "adf-duplex")).toThrow(/no duplex ADF/);
    expect(() => assertSourceSupported(resolved.entry, "adf-simplex")).not.toThrow();
  });

  it("allows adf-duplex on duplex-capable hardware", () => {
    const entry = recordedDialect(ET4950_FP);
    expect(() => assertSourceSupported(entry, "adf-duplex")).not.toThrow();
  });

  // Regression: the ET-2810 is flatbed-only and SCAN_SIDES defaults to "duplex",
  // so every default-config host-triggered scan on it arrives here with
  // duplex=true. The source resolves to flatbed, so duplex is inert and the
  // guard must not fire. An earlier design rejected on `duplex` at entry
  // resolution and broke exactly this case.
  it("allows flatbed on a flatbed-only entry even though duplex was requested", () => {
    const entry = recordedDialect(ET2810_FP);
    expect(() => assertSourceSupported(entry, "flatbed")).not.toThrow();
  });
});
