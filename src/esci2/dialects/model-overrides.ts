// src/esci2/dialects/model-overrides.ts
import type { GammaClassName, CmxClassName, Extents, ParaProfile } from "../para-composer.js";
import type { ToneCurveName } from "../../postprocess/tone-curves.js";
import type { SourceGeometry } from "../scan-window.js";

export interface ModelOverride {
  /**
   * Model identity, matched first: the product IDs this entry's models report
   * in their INFO `#PRD` reply (`PID xxxx`, upper-case hex).
   */
  pids: readonly string[];
  /** Product names, matched second, for models whose INFO `#PRD` carries a name instead of a PID. */
  names: readonly string[];
  /**
   * CAPA fingerprints, the fallback key when no PID or name matches: the only
   * key for a model whose PID is not yet known. On a PID or name hit, a
   * fingerprint missing from this list warns and the session proceeds.
   */
  capaFingerprints: readonly string[];
  displayName: string;
  initPollIterations: number;
  /**
   * The flatbed and ADF scan windows: each the captured paper size,
   * "generic" to inherit the generic window, or null for a source the
   * hardware lacks (no flatbed on ADF-only models, no ADF on flatbed-only
   * ones). An entry keeps its own window only where the generic one differs
   * from it on some source at some advertised DPI (scan-window.test.ts holds
   * the comparison).
   */
  fbExtents: OverrideWindow;
  adfExtents: OverrideWindow;
  /**
   * The DPI fbExtents and adfExtents are given at: the reference DPI of the
   * PARA profile they were captured under (baseDpiFor). Omitted means 300,
   * the standard profile's; the crop-mode (adf-crp) scanners set 200. A
   * session whose derived profile has a different reference DPI rescales the
   * windows (withCapabilities), so their physical size is kept.
   */
  windowDpi?: number;
  /**
   * What confirmed which way up this model's duplex back pages arrive: a
   * duplex capture whose orientation has been checked, or a hardware report
   * (`source`), and the orientation it confirmed (`backRotated`). The
   * session still derives the orientation from INFO; this only silences the
   * warning, and only while the two agree. Omitted where neither exists: a
   * duplex scan then warns once per process, inviting the report that would
   * settle it. Only a model with a duplex ADF carries it.
   */
  duplexOrientationEvidence?: { backRotated: boolean; source: string };
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass: { jpg: CmxClassName | null; pdf: CmxClassName | null };
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
  /**
   * Wire DPIs confirmed to work on this model — either a committed replay
   * fixture drives that exact DPI to completion, or a hardware report
   * documents it (README compatibility row / linked issue). Read by
   * buildParaSend: an explicit SCAN_RESOLUTION that resolves (via
   * selectWireDpi) to a DPI NOT in this list gets a one-line warn inviting a
   * report (issue #81) — it still scans, this is a heads-up, not a guard.
   * Empty means no wire DPI beyond the dialect's pinned default has been
   * confirmed, so every explicit SCAN_RESOLUTION warns.
   */
  verifiedWireDpis: number[];
}

/**
 * The dialect fields a session always takes from the printer's own INFO and
 * CAPA replies (capabilityFields), for a model override and the generic
 * dialect alike. No entry can override them (ADR 0001).
 */
export interface CapabilityFields {
  /**
   * Whether the ADF can scan both sides. Read by assertSourceSupported at
   * PARA-build time: composing an `adf-duplex` PARA for a simplex-only ADF
   * sends the printer a segment its firmware never advertised. The panel
   * never offers 2-sided on such models, but the host trigger (scan-now) can
   * request it directly, because SCAN_SIDES defaults to "duplex".
   */
  adfDuplex: boolean;
  /** Whether PARA carries the optional #QIT and #CCT segments. */
  optionalSegments: { qit: boolean; cct: boolean };
  /** PARA layout: "adf-crp" for the crop-mode ADF-only scanners, else "standard". */
  paraProfile: ParaProfile;
  /** How the session learns its source. */
  sourceDetection: SourceDetection;
  /**
   * Whether duplex back pages arrive turned 180° and get the host-side
   * compensation (EXIF Orientation=3 / PDF /Rotate 180): true for a two-pass
   * ADF (INFO `#ADFDPLX2SCN`), which turns the sheet over and feeds it
   * again; false for a single-pass one (`1SCN`), which reads both sides in
   * one pass, and for no duplex at all.
   */
  duplexBackRotated: boolean;
}

/**
 * How a session learns its source, from the sources INFO advertises. A
 * printer with both reads it from the content of the init poll's first
 * status reply ("ADF paper empty" means the flatbed, no error the ADF); a
 * single-source printer is fixed to it, and never consults the reply. Null
 * when INFO advertises no scan area at all: the session keeps the scanner
 * shell's default source.
 */
export type SourceDetection = "init-poll-status" | "fixed-flatbed" | "fixed-adf" | null;

/**
 * A source's scan window on a model override. "generic" inherits the generic
 * window, computed from the printer's own scan area at every wire DPI
 * (genericWindow).
 */
export type OverrideWindow = Extents | "generic" | null;

/**
 * A session's scan window for one source, at the PARA profile's reference
 * DPI. `generic` is set when it is the generic window: the scan-area
 * geometry it is computed from, which makeParaSpec uses to compute it again
 * at the wire DPI rather than scaling it (scaling can overrun the area).
 * Replacing the window replaces both.
 */
export interface DialectWindow extends Extents {
  generic?: SourceGeometry;
}

/** What a session runs: its model override (or the generic one) plus the capability fields. */
export interface Dialect extends Omit<ModelOverride, "fbExtents" | "adfExtents">, CapabilityFields {
  /** null when the source has no window: the hardware lacks it, or its scan area isn't usable. */
  fbExtents: DialectWindow | null;
  adfExtents: DialectWindow | null;
}

/**
 * Whether SCAN_COLOR_MODE=grayscale is honoured on the wire for this dialect.
 * The single definition of the capability — the graph's fallback log and the
 * scanner shells' finalize resolution both consume it, keeping them aligned
 * with composePara's gate: only the adf-crp composer reads colorMode
 * (composeStandardPara hard-codes #COLC024), so monoGammaClass presence alone
 * is not enough. A standard-profile entry mistakenly given a monoGammaClass
 * therefore still resolves to host-side conversion instead of silently
 * producing colour output under an explicit grayscale setting.
 */
export function supportsWireGrayscale(entry: Dialect | undefined): boolean {
  return entry?.paraProfile === "adf-crp" && entry.monoGammaClass !== undefined;
}

export const MODEL_OVERRIDES: readonly ModelOverride[] = [
  // The ET-3950 shares this CAPA fingerprint; its PID is not yet known, so it
  // resolves by fingerprint.
  {
    pids: ["11D1"],
    names: [],
    capaFingerprints: ["2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2"],
    displayName: "ET-4950 / ET-3950 / ET-4956 (ESC/I-2 over TLS)",
    initPollIterations: 3,
    fbExtents: "generic",
    adfExtents: "generic",
    duplexOrientationEvidence: {
      backRotated: true,
      source: "ET-4956 hardware (the maintainer's): duplex backs arrive turned 180°",
    },
    gmm: "UG10",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass: { jpg: null, pdf: null },
    toneCurve: "et4950-family",
    // 300: Frida-captured replay fixtures drive it end-to-end. The rest:
    // ET-4956 hardware verification, 2026-09-02 (issue #81 runbook) —
    // flatbed at 75/150/600/1200 and ADF at 75/150/200/600 all accepted on
    // the wire with linearly-scaled dimensions and centred registration
    // marks; 1200 is flatbed-only (the ADF source list caps at 600, and a
    // 1200 request on the ADF was confirmed to cap to 600).
    verifiedWireDpis: [75, 150, 200, 300, 600, 1200],
  },
  // The XP-4100 (FW 02.42.MB27M6) produces a byte-identical canonicalised
  // CAPA reply and so shares this fingerprint — flatbed-only hardware like
  // the ET-2750, live-validated by the reporter in issue #139 (flatbed PDF,
  // panel and host trigger). Gamma is not advertised in CAPA, so the XP-4100
  // inherits the ET-2750's captured near-identity curve; measured off the
  // #139 compatibility-page scan, C0C0C0 returns ~195 against a nominal 192
  // with no cast, so the inherited curve is faithful on that hardware too.
  // Its PID is not yet known, so it resolves by fingerprint.
  {
    pids: ["112A"],
    names: [],
    capaFingerprints: ["de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7"],
    displayName: "ET-2750 / XP-4100 (ESC/I-2 over plain TCP)",
    initPollIterations: 2,
    fbExtents: { x0: 0, y0: 0, w: 2477, h: 3500 },
    adfExtents: null,
    gmm: "UG18",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
    // Committed pcap-extracted replay fixture drives 300 DPI end-to-end.
    verifiedWireDpis: [300],
  },
  {
    pids: ["1147"],
    names: [],
    capaFingerprints: ["56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e"],
    displayName: "XP-7100 (ESC/I-2 over plain TCP)",
    initPollIterations: 3,
    fbExtents: { x0: 0, y0: 0, w: 2550, h: 3300 },
    adfExtents: { x0: 0, y0: 0, w: 2550, h: 3300 },
    duplexOrientationEvidence: {
      backRotated: true,
      source: "hardware report (#65): duplex scans with backs turned 180° came out right",
    },
    gmm: "UG18",
    gammaClass: { jpg: "xp7100-jpg", pdf: "xp7100-pdf" },
    cmxClass: { jpg: "xp7100-jpg", pdf: "xp7100-pdf" },
    // Committed pcap-extracted replay fixture drives 300 DPI end-to-end.
    verifiedWireDpis: [300],
  },
  {
    pids: ["11D0"],
    names: [],
    capaFingerprints: ["b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb"],
    displayName: "ET-2950 (ESC/I-2 over TLS)",
    initPollIterations: 3,
    fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    adfExtents: null,
    gmm: "UG10",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass: { jpg: null, pdf: null },
    // No replay fixture and no reporter retest (README: 🟡 Experimental,
    // inferred dialect, issue #92) — seed empty per the verification-posture
    // rule until a hardware report confirms a wire DPI.
    verifiedWireDpis: [],
  },
  {
    pids: ["1185"],
    names: [],
    capaFingerprints: ["7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2"],
    displayName: "ET-4800 (ESC/I-2 over plain TCP)",
    initPollIterations: 3, // same as ET-4950 family; fixtures trimmed to 3 cycles
    fbExtents: "generic",
    adfExtents: "generic",
    gmm: "UG18",
    gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
    cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
    // Committed pcap-extracted replay fixture drives 300 DPI end-to-end.
    verifiedWireDpis: [300],
  },
  // ET-15000: A3-print / A4-scan EcoTank. Flatbed + ADF simplex (no duplex),
  // ESC/I-2 over plain TCP. CAPA advertises GMM "UG10UG18" and CMX "UNITUM08"
  // with QIT/CCT absent — the same segment shape as the ET-4800, which
  // advertises the same GMM and CMX lists. The gamma/CMX class bytes are
  // reused from the ET-4800 (closest plain-TCP sibling) pending a hardware
  // capture of the ET-15000's own PARA; live-validated against a real ET-15000 (PID 116E, FW FB 1.01).
  {
    pids: ["116E"],
    names: [],
    capaFingerprints: ["d1d7293e92fa726e006429beacca1255e474de0d66b3559f87176d4e4b3d0e55"],
    displayName: "ET-15000 (ESC/I-2 over plain TCP)",
    initPollIterations: 3,
    fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
    gmm: "UG18",
    gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
    cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
    // Live-validated on real hardware (PID 116E, FW FB 1.01) at 300 DPI.
    verifiedWireDpis: [300],
  },
  // FF-680W: ADF-only FastFoto scanner. The panel JobNumberIn flow observed
  // from Epson's Mac software uses plain TCP ESC/I-2, an 8-cycle init poll,
  // and a 200-DPI ADF PARA dialect with CRP/SKEW/DPLX defaults. The INFO body
  // has no FB AREA segment, so the session is fixed to the ADF rather than
  // keeping the flatbed-oriented plain-TCP default.
  {
    pids: [],
    names: ["FF-680W"],
    capaFingerprints: ["5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd"],
    displayName: "FF-680W (ESC/I-2 over plain TCP)",
    initPollIterations: 8,
    fbExtents: null, // ADF-only hardware — no flatbed
    adfExtents: { x0: 0, y0: 0, w: 1700, h: 7200 },
    windowDpi: 200,
    // Rendered raw, both sides of the duplex fixture read upside down (the
    // sheet went in top edge first): the back is not turned relative to the
    // front, as a single-pass ADF reads it.
    duplexOrientationEvidence: {
      backRotated: false,
      source:
        "duplex capture ff-680w/adf-duplex-200, rendered raw: back the same way up as the front",
    },
    gmm: "UG18",
    gammaClass: { jpg: "ff680w-adf", pdf: "ff680w-adf" },
    cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
    // Committed pcap-extracted replay fixtures drive 200 and 300 DPI end-to-end.
    verifiedWireDpis: [200, 300],
  },
  // DS-575W: ADF-only, button-only sheet-fed scanner — a FastFoto/DS-family
  // sibling of the FF-680W (PID 0169 vs 016B). ESC/I-2 over plain TCP, 12-cycle
  // init poll, fixed to the ADF (its INFO has no flatbed; its first init-poll
  // statuses report ADF paper empty, which a status read would take for the
  // flatbed). Its #ADFCRP PARA is byte-identical in layout to the
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
  {
    pids: [],
    names: ["DS-575W"],
    capaFingerprints: ["90f98ad1ef34fc40fcd9b49f880b0599569c80b343ab9b05c92d15cfac30b074"],
    displayName: "DS-575W (ESC/I-2 over plain TCP)",
    initPollIterations: 12,
    fbExtents: null, // ADF-only hardware — no flatbed
    adfExtents: { x0: 0, y0: 0, w: 1700, h: 3100 },
    windowDpi: 200,
    duplexOrientationEvidence: {
      backRotated: false,
      source: "hardware report (#128): backs arrive upright; the 180° compensation inverted them",
    },
    gmm: "UG18",
    gammaClass: { jpg: "ff680w-adf", pdf: "ff680w-adf" },
    cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
    monoGammaClass: "ds575w-mono",
    // 400 and 600: committed pcap-extracted replay fixtures drive these
    // end-to-end. 200: not fixture-covered, but README-recorded as the one
    // DPI actually hardware-verified on this model (compatibility table row:
    // "only duplex colour PDF @ 200 DPI hardware-verified"); 400/600 are
    // capture/replay-tested only. All three qualify under the
    // verification-posture rule.
    verifiedWireDpis: [200, 400, 600],
  },
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
  {
    pids: ["118A", "11AF"],
    names: [],
    capaFingerprints: ["708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e"],
    displayName: "ET-2810 / XP-3200 (ESC/I-2)",
    initPollIterations: 3,
    fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    adfExtents: null,
    gmm: "UG18",
    gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
    cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
    // Live-validated on real hardware at 300 DPI (issue #132).
    verifiedWireDpis: [300],
  },
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
  {
    pids: ["1193"],
    names: [],
    capaFingerprints: ["05b5c7eaad217e9538883f3fffe9796464689a5d9006c5b3e3c3fd2c24e21467"],
    displayName: "ET-8500 (ESC/I-2)",
    initPollIterations: 3,
    fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    adfExtents: null,
    gmm: "UG18",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
    // Confirmed working by the reporter at 300 DPI (issue #120).
    verifiedWireDpis: [300],
  },
  // ET-7700: A4 EcoTank Photo. Flatbed-only (CAPA reports ADF: N / duplex: N),
  // ESC/I-2 over plain TCP. Speculative from the issue #145 diagnostic
  // (PID 112B, FW FB 1.31): its reported CAPA shape matches the ET-8500 —
  // GMM "UG10UG18", CMX "UNITUM08", QIT present (PREFON OFF), CCT absent, and
  // the #FB AREA value "d850i0001170" byte-identical to the ET-4800/ET-8500 —
  // so every field is inherited from that sibling: the A4 window of the
  // ET-4800 family (now the generic window, which equals it at every
  // advertised DPI), et4800-um08 CMX, and the near-identity et4950-stock gamma
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
  {
    pids: ["112B"],
    names: [],
    capaFingerprints: ["72319314b621fea0aab6cc16f4fd891534cec08f33ce80116a849f6f6e1e58d4"],
    displayName: "ET-7700 (ESC/I-2)",
    initPollIterations: 3,
    fbExtents: "generic",
    adfExtents: null,
    gmm: "UG18",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
    // Committed pcap-extracted replay fixtures drive 300 DPI end-to-end (issue #145).
    verifiedWireDpis: [300],
  },
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
  {
    pids: ["117A"],
    names: [],
    capaFingerprints: ["860a899be9dc4fc27b68f8aed21a49ccfe87733a3974813f0c2ade6810e89dc7"],
    displayName: "WF-3835 (ESC/I-2 over plain TCP)",
    initPollIterations: 3,
    fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
    gmm: "UG18",
    gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
    cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
    // Awaiting reporter validation (#174) — the flatbed evidence isn't
    // recorded in the tree yet. Flip to [300] in the PR that flips the
    // README row to ✅.
    verifiedWireDpis: [],
  },
];

/**
 * MODEL_OVERRIDES indexed by CAPA fingerprint, for callers that already hold
 * one (mostly tests). The session lookup, `resolveDialect`, reads
 * MODEL_OVERRIDES alone, so that array is the one source a test doctors.
 */
export const OVERRIDES_BY_FINGERPRINT: ReadonlyMap<string, ModelOverride> =
  indexByFingerprint(MODEL_OVERRIDES);

/**
 * Builds the fingerprint index, refusing a fingerprint listed by two entries
 * rather than letting the later one silently win.
 */
function indexByFingerprint(entries: readonly ModelOverride[]): Map<string, ModelOverride> {
  const index = new Map<string, ModelOverride>();
  for (const entry of entries) {
    for (const fp of entry.capaFingerprints) {
      const other = index.get(fp);
      if (other !== undefined) {
        throw new Error(
          `CAPA fingerprint ${fp} is listed by both ${other.displayName} and ${entry.displayName}`,
        );
      }
      index.set(fp, entry);
    }
  }
  return index;
}
