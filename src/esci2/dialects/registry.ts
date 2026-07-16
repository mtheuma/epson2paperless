// src/esci2/dialects/registry.ts
import type { GammaClassName, CmxClassName, Extents, ParaProfile } from "../para-composer.js";
import type { ToneCurveName } from "../../postprocess/tone-curves.js";

export interface RegistryEntry {
  displayName: string;
  sourceDetection: "stat-length" | "fixed-flatbed" | "fixed-adf";
  initPollIterations: number;
  fbExtents: Extents;
  adfExtents: Extents | null;
  /**
   * Whether the hardware's ADF can scan both sides. Read by
   * assertSourceSupported at PARA-build time: composing an `adf-duplex` PARA
   * for a simplex-only ADF sends the printer a segment its firmware never
   * advertised. The panel used to make this unreachable by never offering
   * 2-sided on such models; the host trigger (scan-now) can request it
   * directly, because SCAN_SIDES defaults to "duplex".
   *
   * `false` for flatbed-only models, where it is unreachable but must still
   * be stated.
   */
  adfDuplex: boolean;
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass: { jpg: CmxClassName | null; pdf: CmxClassName | null };
  optionalSegments: { qit: boolean; cct: boolean };
  paraProfile?: ParaProfile;
  /**
   * Pinned perceptual tone curve for the `document` post-process profile
   * (stage 2). Set only for printers with a captured raw→Epson oracle pair;
   * omitted printers get the adaptive white-point clip only.
   */
  toneCurve?: ToneCurveName;
}

export const REGISTRY: ReadonlyMap<string, RegistryEntry> = new Map([
  [
    "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
    {
      displayName: "ET-4950 / ET-3950 / ET-4956 (ESC/I-2 over TLS)",
      sourceDetection: "stat-length",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
      adfDuplex: true,
      gmm: "UG10",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: null, pdf: null },
      optionalSegments: { qit: true, cct: true },
      toneCurve: "et4950-family",
    },
  ],
  [
    "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7",
    {
      displayName: "ET-2750 (ESC/I-2 over plain TCP)",
      sourceDetection: "fixed-flatbed",
      initPollIterations: 2,
      fbExtents: { x0: 0, y0: 0, w: 2477, h: 3500 },
      adfExtents: null,
      adfDuplex: false, // no ADF
      gmm: "UG18",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      optionalSegments: { qit: false, cct: false },
    },
  ],
  [
    "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e",
    {
      displayName: "XP-7100 (ESC/I-2 over plain TCP)",
      sourceDetection: "stat-length",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2550, h: 3300 },
      adfExtents: { x0: 0, y0: 0, w: 2550, h: 3300 },
      adfDuplex: true,
      gmm: "UG18",
      gammaClass: { jpg: "xp7100-jpg", pdf: "xp7100-pdf" },
      cmxClass: { jpg: "xp7100-jpg", pdf: "xp7100-pdf" },
      optionalSegments: { qit: true, cct: false },
    },
  ],
  [
    "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
    {
      displayName: "ET-2950 (ESC/I-2 over TLS)",
      sourceDetection: "fixed-flatbed",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: null,
      adfDuplex: false, // no ADF
      gmm: "UG10",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: null, pdf: null },
      optionalSegments: { qit: true, cct: true },
    },
  ],
  [
    "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2",
    {
      displayName: "ET-4800 (ESC/I-2 over plain TCP)",
      sourceDetection: "stat-length",
      initPollIterations: 3, // same as ET-4950 family; fixtures trimmed to 3 cycles
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
      adfDuplex: false, // ADF simplex
      gmm: "UG18",
      gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
      cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
      optionalSegments: { qit: false, cct: false },
    },
  ],
  [
    // ET-15000: A3-print / A4-scan EcoTank. Flatbed + ADF simplex (no duplex),
    // ESC/I-2 over plain TCP. CAPA advertises GMM "UG10UG18" and CMX "UNITUM08"
    // with QIT/CCT absent — structurally an ET-4800 that additionally lists the
    // UG10 gamma mode. The gamma/CMX class bytes are reused from the ET-4800
    // (closest plain-TCP sibling) pending a hardware capture of the ET-15000's
    // own PARA; live-validated against a real ET-15000 (PID 116E, FW FB 1.01).
    "d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55",
    {
      displayName: "ET-15000 (ESC/I-2 over plain TCP)",
      sourceDetection: "stat-length",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
      adfDuplex: false, // ADF simplex
      gmm: "UG18",
      gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
      cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
      optionalSegments: { qit: false, cct: false },
    },
  ],
  [
    // FF-680W: ADF-only FastFoto scanner. The panel JobNumberIn flow observed
    // from Epson's Mac software uses plain TCP ESC/I-2, an 8-cycle init poll,
    // and a 200-DPI ADF PARA dialect with CRP/SKEW/DPLX defaults. The INFO body
    // has no FB AREA segment, so keep source fixed to ADF rather than applying
    // the flatbed-oriented plain-TCP default.
    "5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd",
    {
      displayName: "FF-680W (ESC/I-2 over plain TCP)",
      sourceDetection: "fixed-adf",
      initPollIterations: 8,
      // Not used by the fixed-ADF profile, but ParaSpec keeps FB extents
      // required for standard flatbed-capable dialects.
      fbExtents: { x0: 0, y0: 0, w: 1700, h: 7200 },
      adfExtents: { x0: 0, y0: 0, w: 1700, h: 7200 },
      adfDuplex: true,
      gmm: "UG18",
      gammaClass: { jpg: "ff680w-adf", pdf: "ff680w-adf" },
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      optionalSegments: { qit: false, cct: false },
      paraProfile: "ff680w-adf",
    },
  ],
  [
    // ET-8500: A4 EcoTank Photo. Flatbed-only (CAPA reports ADF: N / duplex: N).
    // Presents over ESC/I-2 on both TLS (issue #120, Peter-Maguire) and plain TCP
    // (issue #123, anaxci) across reporters — identical CAPA fingerprint either
    // way, so this one transport-agnostic entry serves both. Source detection and
    // init poll mirror the ET-2950 (flatbed-only, fixed-flatbed, 3-cycle), but its
    // PARA-segment shape matches the ET-15000/ET-4800 family: CAPA advertises GMM
    // "UG10UG18" and CMX "UNITUM08" with QIT present (PREFON OFF) and CCT absent.
    // Its #FB AREA value "d850i0001170" is byte-identical to the ET-4800/ET-2750,
    // so the A4 flatbed extents are reused from the ET-4800, and the CMX class
    // bytes from the ET-4800's matching UNITUM08 variant (et4800-um08).
    //
    // The gamma curve is NOT advertised in CAPA, so it can't be pinned from the
    // diagnostic the way extents/CMX/GMM can. We default it to the near-identity
    // et4950-stock used by the TLS sibling (ET-4950/ET-2950) rather than the
    // ET-4800's contrast-boosting curve: for an unknown photo scanner a flat curve
    // is the lower-risk guess (if wrong it degrades mildly, vs crushing shadows).
    // Originally speculative from the issue #120 diagnostic (PID 1193, FW FB 2.00);
    // since confirmed working by the reporter (flatbed JPG + PDF, colours accurate,
    // nothing washed out). A Frida capture would still pin the gamma/CMX exactly.
    "05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467",
    {
      displayName: "ET-8500 (ESC/I-2)",
      sourceDetection: "fixed-flatbed",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: null,
      adfDuplex: false, // no ADF
      gmm: "UG18",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
      optionalSegments: { qit: true, cct: false },
    },
  ],
]);
