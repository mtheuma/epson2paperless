// src/esci2/dialects/model-overrides.test.ts
import { describe, it, expect } from "vitest";
import {
  OVERRIDES_BY_FINGERPRINT,
  MODEL_OVERRIDES,
  supportsWireGrayscale,
  type ModelOverride,
} from "./model-overrides.js";
import { recordedDialect } from "../test-support/dialects.js";
import { STANDARD_BASE_DPI, baseDpiFor } from "../para-composer.js";

describe("OVERRIDES_BY_FINGERPRINT", () => {
  it("contains exactly twelve known fingerprints", () => {
    expect(OVERRIDES_BY_FINGERPRINT.size).toBe(12);
  });

  it("includes ET-4950 family entry", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
    );
    expect(e).toBeDefined();
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG10");
    expect(e!.adfExtents).not.toBeNull();
  });

  it("includes ET-2750 entry", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7",
    );
    expect(e).toBeDefined();
    expect(e!.initPollIterations).toBe(2);
    expect(e!.gmm).toBe("UG18");
    expect(e!.adfExtents).toBeNull();
    expect(e!.cmxClass.jpg).toBe("et2750-um08");
  });

  it("includes XP-7100 entry", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e",
    );
    expect(e).toBeDefined();
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass.jpg).toBe("xp7100-jpg");
    expect(e!.gammaClass.pdf).toBe("xp7100-pdf");
    expect(e!.cmxClass.jpg).toBe("xp7100-jpg");
    expect(e!.cmxClass.pdf).toBe("xp7100-pdf");
  });

  it("includes ET-2950 entry that reuses ET-4950 LUT", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
    );
    expect(e).toBeDefined();
    expect(e!.gammaClass).toEqual({ jpg: "et4950-stock", pdf: "et4950-stock" });
    expect(e!.cmxClass).toEqual({ jpg: null, pdf: null });
    expect(e!.adfExtents).toBeNull();
  });

  it("includes ET-4800 entry (flatbed + ADF simplex, plain TCP)", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2",
    );
    expect(e).toBeDefined();
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "et4800-stock", pdf: "et4800-stock" });
    expect(e!.cmxClass).toEqual({ jpg: "et4800-um08", pdf: "et4800-um08" });
    expect(e!.fbExtents).toBe("generic");
    expect(e!.adfExtents).toBe("generic");
  });

  it("includes ET-15000 entry (flatbed + ADF simplex, plain TCP)", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55",
    );
    expect(e).toBeDefined();
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "et4800-stock", pdf: "et4800-stock" });
    expect(e!.cmxClass).toEqual({ jpg: "et4800-um08", pdf: "et4800-um08" });
    expect(e!.fbExtents).toEqual({ x0: 0, y0: 0, w: 2481, h: 3506 });
    expect(e!.adfExtents).toEqual({ x0: 69, y0: 0, w: 2481, h: 3506 });
  });

  it("includes ET-8500 entry (flatbed-only; ET-4950 gamma + identity CMX, a neutral pair)", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467",
    );
    expect(e).toBeDefined();
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "et4950-stock", pdf: "et4950-stock" });
    expect(e!.cmxClass).toEqual({ jpg: "identity-um08", pdf: "identity-um08" });
    expect(e!.fbExtents).toEqual({ x0: 0, y0: 0, w: 2481, h: 3506 });
    expect(e!.adfExtents).toBeNull();
  });

  it("includes ET-7700 entry (flatbed-only; XP-7100 gamma + identity CMX, a neutral pair)", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "72319314b621fea0aab6cc16f4fd891534cec08f33ce80116a849f6f6e1e58d4",
    );
    expect(e).toBeDefined();
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "xp7100-pdf", pdf: "xp7100-pdf" });
    expect(e!.cmxClass).toEqual({ jpg: "identity-um08", pdf: "identity-um08" });
    expect(e!.fbExtents).toBe("generic");
    expect(e!.adfExtents).toBeNull();
  });

  it("includes WF-3835 entry (flatbed + ADF simplex, plain TCP; speculative from #174)", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "860a899be9dc4fc27b68f8aed21a49ccfe87733a3974813f0c2ade6810e89dc7",
    );
    expect(e).toBeDefined();
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "et4800-stock", pdf: "et4800-stock" });
    expect(e!.cmxClass).toEqual({ jpg: "et4800-um08", pdf: "et4800-um08" });
    expect(e!.fbExtents).toEqual({ x0: 0, y0: 0, w: 2481, h: 3506 });
    expect(e!.adfExtents).toEqual({ x0: 69, y0: 0, w: 2481, h: 3506 });
  });

  it("includes FF-680W entry (ADF-only, plain TCP)", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd",
    );
    expect(e).toBeDefined();
    expect(e!.fbExtents).toBeNull(); // ADF-only hardware — no fabricated flatbed extents
    expect(e!.initPollIterations).toBe(8);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "ff680w-adf", pdf: "ff680w-adf" });
    expect(e!.cmxClass).toEqual({ jpg: "et2750-um08", pdf: "et2750-um08" });
    expect(e!.adfExtents).toEqual({ x0: 0, y0: 0, w: 1700, h: 7200 });
    expect(e!.monoGammaClass).toBeUndefined();
  });

  it("includes DS-575W entry (ADF-only, greyscale-capable, plain TCP)", () => {
    const e = OVERRIDES_BY_FINGERPRINT.get(
      "90f98ad1ef34fc40fcd9b49f880b0599569c80b343ab9b05c92d15cfac30b074",
    );
    expect(e).toBeDefined();
    expect(e!.fbExtents).toBeNull(); // ADF-only hardware — no fabricated flatbed extents
    expect(e!.initPollIterations).toBe(12);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass).toEqual({ jpg: "ff680w-adf", pdf: "ff680w-adf" });
    expect(e!.cmxClass).toEqual({ jpg: "et2750-um08", pdf: "et2750-um08" });
    expect(e!.adfExtents).toEqual({ x0: 0, y0: 0, w: 1700, h: 3100 });
    expect(e!.monoGammaClass).toBe("ds575w-mono");
  });

  it("supportsWireGrayscale matches composePara's gate (adf-crp + monoGammaClass)", () => {
    // DS-575W: adf-crp profile with a mono LUT — the wire honours grayscale.
    expect(
      supportsWireGrayscale(
        recordedDialect("90f98ad1ef34fc40fcd9b49f880b0599569c80b343ab9b05c92d15cfac30b074"),
      ),
    ).toBe(true);
    // FF-680W: adf-crp but colour-only (no mono LUT).
    expect(
      supportsWireGrayscale(
        recordedDialect("5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd"),
      ),
    ).toBe(false);
    // ET-4950 family: standard profile — composeStandardPara never reads
    // colorMode, so even a (mistaken) monoGammaClass could not reach the wire.
    expect(
      supportsWireGrayscale(
        recordedDialect("2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2"),
      ),
    ).toBe(false);
    expect(supportsWireGrayscale(undefined)).toBe(false);
  });

  it("every recorded model derives the profile its windows are pinned for", () => {
    // So no recorded printer's windows are rescaled (withCapabilities).
    for (const [fp, e] of OVERRIDES_BY_FINGERPRINT) {
      const profile = recordedDialect(fp).paraProfile;
      expect(baseDpiFor(profile), e.displayName).toBe(e.windowDpi ?? STANDARD_BASE_DPI);
    }
  });

  it("no entry carries a capability-derived field: sessions take those from the printer", () => {
    for (const e of MODEL_OVERRIDES) {
      for (const field of [
        "adfDuplex",
        "optionalSegments",
        "paraProfile",
        "sourceDetection",
        "duplexBackRotated",
      ]) {
        expect(e, `${e.displayName}`).not.toHaveProperty(field);
      }
    }
  });

  it("pins which models' duplex orientation is confirmed, and which way", () => {
    // A checked capture or a hardware report, by model: whether back pages
    // were confirmed turned 180°.
    const confirmed = Object.fromEntries(
      MODEL_OVERRIDES.flatMap((e) =>
        e.duplexOrientationEvidence
          ? [[e.displayName, e.duplexOrientationEvidence.backRotated]]
          : [],
      ),
    );
    expect(confirmed).toEqual({
      "ET-4950 / ET-3950 / ET-4956 (ESC/I-2 over TLS)": true,
      "XP-7100 (ESC/I-2 over plain TCP)": true,
      "FF-680W (ESC/I-2 over plain TCP)": false,
      "DS-575W (ESC/I-2 over plain TCP)": false,
    });
  });

  it("holds every piece of orientation evidence to a duplex model whose replies derive it", () => {
    for (const [fp, e] of OVERRIDES_BY_FINGERPRINT) {
      if (e.duplexOrientationEvidence === undefined) continue;
      const dialect = recordedDialect(fp);
      // Evidence is about duplex back pages: a model without duplex has none to give.
      expect(dialect.adfDuplex, e.displayName).toBe(true);
      expect(dialect.duplexBackRotated, e.displayName).toBe(
        e.duplexOrientationEvidence.backRotated,
      );
    }
  });

  it("never claims adfDuplex without ADF extents", () => {
    for (const [fp, e] of OVERRIDES_BY_FINGERPRINT) {
      if (recordedDialect(fp).adfDuplex) {
        expect(e.adfExtents, `entry ${fp} (${e.displayName})`).not.toBeNull();
      }
    }
  });

  it("declares verifiedWireDpis as an array on every entry", () => {
    for (const [fp, e] of OVERRIDES_BY_FINGERPRINT) {
      expect(Array.isArray(e.verifiedWireDpis), `entry ${fp} (${e.displayName})`).toBe(true);
    }
  });

  it("pins verifiedWireDpis per model (committed replay fixture or documented hardware validation -> that DPI; neither -> empty)", () => {
    const expected: Record<string, number[]> = {
      // ET-4950 / ET-3950 / ET-4956 — Frida-captured replay fixtures at 300 DPI;
      // 75/150/200/600/1200 hardware-verified on an ET-4956 (2026-09-02, #81).
      "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2": [
        75, 150, 200, 300, 600, 1200,
      ],
      // ET-2750 / XP-4100 — pcap-extracted replay fixture at 300 DPI.
      de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7: [300],
      // XP-7100 — pcap-extracted replay fixture at 300 DPI.
      "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e": [300],
      // ET-2950 — no replay fixture, no reporter retest (README: 🟡 Experimental, #92).
      b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb: [],
      // ET-4800 — pcap-extracted replay fixture at 300 DPI.
      "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2": [300],
      // ET-15000 — hardware-validated at 300 DPI.
      d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55: [300],
      // FF-680W — pcap-extracted replay fixtures at 200 and 300 DPI.
      "5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd": [200, 300],
      // DS-575W — 200: README-recorded hardware validation (only duplex
      // colour PDF @ 200 DPI hardware-verified); 400/600: pcap-extracted
      // replay fixtures.
      "90f98ad1ef34fc40fcd9b49f880b0599569c80b343ab9b05c92d15cfac30b074": [200, 400, 600],
      // ET-2810 / XP-3200 — hardware-validated at 300 DPI (#132).
      "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e": [300],
      // ET-8500 — hardware-confirmed at 300 DPI (#120).
      "05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467": [300],
      // ET-7700 — pcap-extracted replay fixtures at 300 DPI (#145).
      "72319314b621fea0aab6cc16f4fd891534cec08f33ce80116a849f6f6e1e58d4": [300],
      // WF-3835 — awaiting reporter validation (#174); flatbed evidence not in the tree yet.
      "860a899be9dc4fc27b68f8aed21a49ccfe87733a3974813f0c2ade6810e89dc7": [],
    };
    for (const [fp, want] of Object.entries(expected)) {
      expect(OVERRIDES_BY_FINGERPRINT.get(fp)!.verifiedWireDpis, `fingerprint ${fp}`).toEqual(want);
    }
  });
});

describe("MODEL_OVERRIDES model identity", () => {
  it("pins each entry's PIDs and product names", () => {
    const identities = MODEL_OVERRIDES.map((e) => [e.displayName, e.pids, e.names]);
    expect(identities).toEqual([
      // ET-3950: PID unknown, resolves by fingerprint.
      ["ET-4950 / ET-3950 / ET-4956 (ESC/I-2 over TLS)", ["11D1"], []],
      // XP-4100: PID unknown, resolves by fingerprint.
      ["ET-2750 / XP-4100 (ESC/I-2 over plain TCP)", ["112A"], []],
      ["XP-7100 (ESC/I-2 over plain TCP)", ["1147"], []],
      ["ET-2950 (ESC/I-2 over TLS)", ["11D0"], []],
      ["ET-4800 (ESC/I-2 over plain TCP)", ["1185"], []],
      ["ET-15000 (ESC/I-2 over plain TCP)", ["116E"], []],
      ["FF-680W (ESC/I-2 over plain TCP)", [], ["FF-680W"]],
      ["DS-575W (ESC/I-2 over plain TCP)", [], ["DS-575W"]],
      ["ET-2810 / XP-3200 (ESC/I-2)", ["118A", "11AF"], []],
      ["ET-8500 (ESC/I-2)", ["1193"], []],
      ["ET-7700 (ESC/I-2)", ["112B"], []],
      ["WF-3835 (ESC/I-2 over plain TCP)", ["117A"], []],
    ]);
  });

  it("gives every entry at least one CAPA fingerprint", () => {
    for (const e of MODEL_OVERRIDES) {
      expect(e.capaFingerprints.length, e.displayName).toBeGreaterThan(0);
    }
  });

  // A key in two entries would make the lookup order decide the dialect.
  it.each([
    ["PID", (e: ModelOverride) => e.pids],
    ["product name", (e: ModelOverride) => e.names],
    ["CAPA fingerprint", (e: ModelOverride) => e.capaFingerprints],
  ] as const)("lists no %s in two entries", (_kind, keysOf) => {
    const owners = new Map<string, string>();
    for (const e of MODEL_OVERRIDES) {
      for (const key of keysOf(e)) {
        expect(owners.get(key), `${key} in ${e.displayName}`).toBeUndefined();
        owners.set(key, e.displayName);
      }
    }
  });

  // The lookup compares keys exactly, against the canonical PID and the
  // upper-cased reported name, so the stored spelling must be canonical too.
  it("stores PIDs as four upper-case hex digits and names in upper case", () => {
    for (const pid of MODEL_OVERRIDES.flatMap((e) => e.pids)) {
      expect(pid).toMatch(/^[0-9A-F]{4}$/);
    }
    for (const name of MODEL_OVERRIDES.flatMap((e) => e.names)) {
      expect(name).toBe(name.toUpperCase());
    }
  });
});
