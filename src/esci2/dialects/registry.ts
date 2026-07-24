// src/esci2/dialects/registry.ts
import type { GammaClassName, CmxClassName, Extents, ParaProfile } from "../para-composer.js";
import type { ToneCurveName } from "../../postprocess/tone-curves.js";

export interface RegistryEntry {
  displayName: string;
  sourceDetection: "stat-length" | "fixed-flatbed" | "fixed-adf";
  initPollIterations: number;
  /** Flatbed scan extents; null for ADF-only hardware (mirrors adfExtents' null for flatbed-only models). */
  fbExtents: Extents | null;
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
  /**
   * Whether duplex back sides arrive physically rotated 180° and need the
   * host-side compensation (EXIF Orientation=3 / PDF /Rotate 180). True for
   * reversing-ADF hardware, which re-feeds the sheet; false for single-pass
   * dual-sensor scanners, whose back sensor captures the side upright —
   * confirmed on DS-575W hardware, where the compensation inverted back
   * pages (issue #128 follow-up). Unreachable (but still stated, like
   * adfDuplex) for simplex-ADF and flatbed-only models.
   */
  duplexBackRotated: boolean;
  /**
   * Set when duplexBackRotated is a shipped assumption with no capture or
   * hardware confirmation behind it. buildParaSend warn-logs on duplex scans
   * for such entries, inviting the hardware report the value is waiting for —
   * without it the suspicion lives only in this file and can never be
   * falsified from the field.
   */
  duplexBackRotationUnverified?: true;
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass: { jpg: CmxClassName | null; pdf: CmxClassName | null };
  optionalSegments: { qit: boolean; cct: boolean };
  paraProfile?: ParaProfile;
  /**
   * Single-channel gamma LUT for greyscale scans (adf-crp profile only).
   * Presence marks the dialect as greyscale-capable: when SCAN_COLOR_MODE is
   * "grayscale" the composer emits #COLM008 + this LUT. Dialects that omit it
   * ignore the setting and always scan in colour.
   */
  monoGammaClass?: GammaClassName;
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
      duplexBackRotated: true, // reversing ADF — backs arrive upside down
      gmm: "UG10",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: null, pdf: null },
      optionalSegments: { qit: true, cct: true },
      toneCurve: "et4950-family",
    },
  ],
  [
    // The XP-4100 (FW 02.42.MB27M6) produces a byte-identical canonicalised
    // CAPA reply and so shares this fingerprint — flatbed-only hardware like
    // the ET-2750, live-validated by the reporter in issue #139 (flatbed PDF,
    // panel and host trigger). Gamma is not advertised in CAPA, so the XP-4100
    // inherits the ET-2750's captured near-identity curve; measured off the
    // #139 compatibility-page scan, C0C0C0 returns ~195 against a nominal 192
    // with no cast, so the inherited curve is faithful on that hardware too.
    "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7",
    {
      displayName: "ET-2750 / XP-4100 (ESC/I-2 over plain TCP)",
      sourceDetection: "fixed-flatbed",
      initPollIterations: 2,
      fbExtents: { x0: 0, y0: 0, w: 2477, h: 3500 },
      adfExtents: null,
      adfDuplex: false, // no ADF
      duplexBackRotated: false, // no ADF
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
      duplexBackRotated: true, // reversing ADF — backs arrive upside down
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
      duplexBackRotated: false, // no ADF
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
      duplexBackRotated: false, // ADF simplex — no back sides
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
      duplexBackRotated: false, // ADF simplex — no back sides
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
      fbExtents: null, // ADF-only hardware — no flatbed
      adfExtents: { x0: 0, y0: 0, w: 1700, h: 7200 },
      adfDuplex: true,
      duplexBackRotated: true, // single-pass hardware, but the compensation has shipped unchallenged — flip on a hardware report
      duplexBackRotationUnverified: true,
      gmm: "UG18",
      gammaClass: { jpg: "ff680w-adf", pdf: "ff680w-adf" },
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      optionalSegments: { qit: false, cct: false },
      paraProfile: "adf-crp",
    },
  ],
  [
    // DS-575W: ADF-only, button-only sheet-fed scanner — a FastFoto/DS-family
    // sibling of the FF-680W (PID 0169 vs 016B). ESC/I-2 over plain TCP, 12-cycle
    // init poll, fixed-ADF (the init-poll STAT is len=12, which stat-length would
    // misread as flatbed). Its #ADFCRP PARA is byte-identical in layout to the
    // FF-680W's, so it reuses the adf-crp profile; the only differences are ADF
    // extents and the colour axis. Colour scans reuse the FF-680W's RGB gamma
    // (ff680w-adf) and the ET-2750's CMX (et2750-um08) — both byte-identical in
    // EliSauder's captures (issue #128). Greyscale scans use the novel 268-byte
    // ds575w-mono LUT + #COLM008. adfExtents are stored at the 200-DPI reference
    // (8.5" × 15.5"); wire captures at 400 and 600 DPI confirm linear scaling.
    //
    // The #ADFCRP flag bytes (SKEW/DFL1/DPLX) are GUI-driven scan options this
    // service does not model; the composer pins the FF-680W canonical
    // (SKEW+[DPLX]+DFL1). The colour capture matches it exactly (strict PARA
    // oracle in scanner.test.ts); the mono captures used different GUI orderings,
    // so they are driven to completion functionally with the mono gamma/CMX
    // pinned directly. End-to-end correctness is confirmed by the contributor
    // running a branch build against real hardware.
    "90f98ad1ef34fc40fcd9b49f880b0599569c80b343ab9b05c92d15cfac30b074",
    {
      displayName: "DS-575W (ESC/I-2 over plain TCP)",
      sourceDetection: "fixed-adf",
      initPollIterations: 12,
      fbExtents: null, // ADF-only hardware — no flatbed
      adfExtents: { x0: 0, y0: 0, w: 1700, h: 3100 },
      adfDuplex: true,
      duplexBackRotated: false, // single-pass dual sensor — backs arrive upright (hardware-confirmed, #128)
      gmm: "UG18",
      gammaClass: { jpg: "ff680w-adf", pdf: "ff680w-adf" },
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      optionalSegments: { qit: false, cct: false },
      paraProfile: "adf-crp",
      monoGammaClass: "ds575w-mono",
    },
  ],
  [
    // ET-2810: entry-level A4 EcoTank. Flatbed-only (CAPA reports ADF: N /
    // duplex: N), ESC/I-2 over plain TCP. CAPA advertises GMM "UG10UG18" and
    // CMX "UNITUM08" with QIT/CCT absent, and its #FB AREA value "d850i0001170"
    // is byte-identical to the ET-4800 — i.e. an ET-4800/ET-15000-shaped dialect
    // that happens to have no ADF. Extents and CMX class are therefore reused
    // from the ET-4800; gamma is inherited from it too (et4800-stock) rather
    // than guessed flat, because that is the combination the reporter actually
    // exercised on hardware (issue #132, PID 118A, FW FB 1.00): they patched
    // this entry in at runtime and got a valid flatbed PDF out.
    //
    // Gamma is not advertised in CAPA, so the inherited curve was a guess until
    // the reporter scanned the compatibility test page (#132). Measured off that
    // scan: the nominal-64 grey patch returns luma 67 — et4800-stock's ~38 black
    // floor never bites, so no shadow crushing — and paper white returns a clean
    // 255 with no colour cast. Good enough to ship as-is; a Frida capture would
    // still pin the exact curve rather than confirm it behaves.
    //
    // NOTE: the ET-2810 never triggers a scan on its own — its two-button combo
    // is a USB-host scan and it registers no network Scan-to-Computer
    // destination, so no beacon and no push-scan ever arrive. This entry is only
    // reachable via a host-initiated scan trigger; it is inert without one.
    "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e",
    {
      displayName: "ET-2810 (ESC/I-2 over plain TCP)",
      sourceDetection: "fixed-flatbed",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: null,
      adfDuplex: false,
      duplexBackRotated: false, // no ADF
      gmm: "UG18",
      gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
      cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
      optionalSegments: { qit: false, cct: false },
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
      duplexBackRotated: false, // no ADF
      gmm: "UG18",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
      optionalSegments: { qit: true, cct: false },
    },
  ],
]);
