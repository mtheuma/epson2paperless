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

/**
 * Whether SCAN_COLOR_MODE=grayscale is honoured on the wire for this entry.
 * The single definition of the capability — the graph's fallback log and the
 * scanner shells' finalize resolution both consume it, keeping them aligned
 * with composePara's gate: only the adf-crp composer reads colorMode
 * (composeStandardPara hard-codes #COLC024), so monoGammaClass presence alone
 * is not enough. A standard-profile entry mistakenly given a monoGammaClass
 * therefore still resolves to host-side conversion instead of silently
 * producing colour output under an explicit grayscale setting.
 */
export function supportsWireGrayscale(entry: RegistryEntry | undefined): boolean {
  return entry?.paraProfile === "adf-crp" && entry.monoGammaClass !== undefined;
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
    // destination, so no beacon and no push-scan ever arrive. For the ET-2810
    // this entry is only reachable via a host-initiated scan trigger.
    //
    // XP-3200 (Expression Home, flatbed-only): produces a byte-identical
    // canonicalised CAPA reply and so shares this fingerprint — but presents
    // over TLS, not plain TCP (the auto-probe's TLS arm wins), making this the
    // second transport-agnostic entry after the ET-8500. Live-validated on a
    // borrowed unit (2026-07): host-triggered flatbed PDF of the compatibility
    // test page, dialect resolved and scan completed unmodified. Measured off
    // that scan: greys are neutral (max channel spread 10, no cast), the
    // nominal-64 grey returns ~74 so et4800-stock's black floor never bites,
    // and geometry is clean (6.2px crosshair residual). Midtones read light
    // (192 → ~242), but the reference print came from AirPrint on plain paper,
    // so print-side lightness can't be separated from the curve; the inherited
    // gamma clears the same no-cast / no-shadow-crush bar the ET-2810 shipped
    // on.
    //
    // Panel flow (XP-3200, beacon PID 11AF): non-functional despite the
    // registration itself working. The printer beacons 02 06, accepts the
    // keepalive (v2.0 and forced v3.0 both), and lists the destination on the
    // panel — but starting a scan fails instantly with "Invalid" while sending
    // the host NOTHING: no push-scan TCP connection, no unicast UDP probe
    // (verified with connection-level debug logging on both 2968 listeners,
    // and inbound TCP to the host confirmed reachable from a third device).
    // The rejection is decided printer-side, so the NetScanMonitor listing
    // appears vestigial on this firmware generation; the real panel flow
    // presumably needs a newer (ScanSmart-era) registration handshake that
    // only a capture against a real Epson client could reveal. Until then the
    // XP-3200 is host-trigger only, same operational story as the ET-2810.
    "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e",
    {
      displayName: "ET-2810 / XP-3200 (ESC/I-2)",
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
  [
    // ET-7700: A4 EcoTank Photo. Flatbed-only (CAPA reports ADF: N / duplex: N),
    // ESC/I-2 over plain TCP. Speculative from the issue #145 diagnostic
    // (PID 112B, FW FB 1.31): its reported CAPA shape matches the ET-8500 —
    // GMM "UG10UG18", CMX "UNITUM08", QIT present (PREFON OFF), CCT absent, and
    // the #FB AREA value "d850i0001170" byte-identical to the ET-4800/ET-8500 —
    // so every field is inherited from that sibling: A4 extents from the
    // ET-4800 family, et4800-um08 CMX, and the near-identity et4950-stock gamma
    // (same photo-scanner rationale as the ET-8500: gamma isn't advertised in
    // CAPA, and a flat curve degrades mildly if wrong instead of crushing
    // shadows). The fingerprint still differs from the ET-8500's somewhere in
    // the full canonicalised segment list, so this is a separate entry rather
    // than a shared one.
    //
    // Hardware-validated by the reporter 2026-08-04 (panel-triggered flatbed
    // JPG + PDF on :main), with Wireshark captures of both sessions: the
    // captured PARA is byte-identical to composePara's output (pinned by the
    // replay fixtures under tools/pcap-extract/captures/et-7700/). Inherited
    // gamma measured off the reporter's compatibility-test-page scan: the
    // nominal-64 grey returns 72/69/69 (no shadow crush), grey-patch channel
    // spreads 3-11 (no cast), paper white 247/243/251 — clears the same bar
    // the ET-2810 and XP-3200 shipped on. The exact Epson-driver curve remains
    // unpinned (captures are of our own service), which matters only if a
    // scan-quality report ever implicates the curve.
    "72319314b621fea0aab6cc16f4fd891534cec08f33ce80116a849f6f6e1e58d4",
    {
      displayName: "ET-7700 (ESC/I-2)",
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
  [
    // WF-3835: A4 WorkForce office AIO (WF-3820/3830 series). Flatbed + ADF
    // simplex (CAPA reports duplex: N — the series' 35-sheet ADF scans one
    // side), ESC/I-2 over plain TCP. Speculative from the issue #174 diagnostic
    // (PID 117A, FW FB 2.03): CAPA advertises GMM "UG10UG18" and CMX "UNITUM08"
    // with QIT present (PREFON OFF) and CCT absent — an ET-15000-shaped dialect
    // that additionally carries the optional QIT segment (equivalently, an
    // ET-8500 with an ADF). Both AREA values are byte-identical to the
    // ET-4950/ET-4800 family ("d850i0001170" FB, "d850i0001400" ADF), so the
    // extents are reused from the ET-4800, as is its matching UNITUM08 CMX
    // class (et4800-um08).
    //
    // Gamma is not advertised in CAPA, so it can't be pinned from the
    // diagnostic, and here the two candidate curves disagree about which
    // sibling to follow. By segment shape (QIT present, CCT absent) the
    // nearest entries are the ET-8500 and ET-7700, which run the flat
    // et4950-stock; by hardware class the WF-3835 is a working-document AIO
    // like the ET-4800 and ET-15000, which run et4800-stock — as do the
    // flatbed-only ET-2810 / XP-3200 that inherited it (#132). We follow
    // hardware class, on the reading that Epson tunes the curve to the
    // scanner's purpose rather than to which optional segments its firmware
    // advertises: the ET-8500 and ET-7700 are photo scanners, where the flat
    // curve was chosen deliberately, and the WF-3835 is not one.
    //
    // This is the one field in the entry that is a judgement call rather than
    // a transcription, so it is what a reporter retest should exercise first:
    // et4800-stock crushes shadows if it turns out to be the wrong pick, which
    // a compatibility-test-page scan would show as a lifted black floor.
    // Awaiting reporter validation on real hardware (#174).
    "860a899be9dc4fc27b68f8aed21a49ccfe87733a3974813f0c2ade6810e89dc7",
    {
      displayName: "WF-3835 (ESC/I-2 over plain TCP)",
      sourceDetection: "stat-length",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
      adfDuplex: false, // ADF simplex (CAPA duplex: N)
      duplexBackRotated: false, // ADF simplex — no back sides
      gmm: "UG18",
      gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
      cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
      optionalSegments: { qit: true, cct: false },
    },
  ],
]);
