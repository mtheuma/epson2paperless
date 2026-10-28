// src/esci2/dialects/model-overrides.ts
//
// The model overrides: per-model records holding only what a printer's own
// INFO and CAPA replies can't tell us. Where each value came from is in its
// provenance; the comments here are for genuine quirks.
import type { GammaClassName, CmxClassName, Extents, ParaProfile } from "../para-composer.js";
import type { ToneCurveName } from "../../postprocess/tone-curves.js";
import type { SourceGeometry } from "../scan-window.js";

export interface ModelOverride {
  /**
   * Model identity, matched first: the product IDs this override's models
   * report in their INFO `#PRD` reply (`PID xxxx`, upper-case hex).
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
   * ones). An override keeps its own window only where the generic one
   * differs from it on some source at some advertised DPI
   * (scan-window.test.ts holds the comparison).
   */
  fbExtents: OverrideWindow;
  adfExtents: OverrideWindow;
  /**
   * The DPI fbExtents and adfExtents are given at: the reference DPI of the
   * PARA profile they were captured under (baseDpiFor). Omitted means 300,
   * the standard profile's; the crop-mode (adf-crp) scanners set 200. A
   * session whose derived PARA profile has a different reference DPI rescales the
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
   * Pinned perceptual tone curve for the `document` post-processing mode
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
  /** Where this override's values came from. Never read by a session. */
  provenance: Provenance;
}

/**
 * Where a model override's values came from (GLOSSARY.md "Provenance"). No
 * runtime effect: provenance.test.ts holds it to the README compatibility
 * table, so a ✅ model can't keep colour bytes nothing vouched for.
 */
export interface Provenance {
  /** The models, by README name, this override was recorded for. */
  models: readonly string[];
  /**
   * Models that share this override with the ones it was recorded for,
   * having been found to share its CAPA fingerprint, each with a report of
   * its own.
   */
  siblings?: Readonly<Record<string, readonly Evidence[]>>;
  /** The colour pair and mono gamma (gmm, gammaClass, cmxClass, monoGammaClass). */
  colour: readonly ColourEvidence[];
  /** The scan windows (fbExtents, adfExtents, windowDpi). */
  window: readonly Evidence[];
  /** initPollIterations. */
  pollCount: readonly Evidence[];
}

/**
 * What a piece of evidence is:
 * - `epson-capture`: a capture of an Epson driver session;
 * - `own-capture`: a capture of this service's own traffic. It proves the
 *   printer accepted the bytes, never that the colours are right;
 * - `reporter-scan`: a measured compatibility-page scan on that model's
 *   hardware (a reporter's, or the maintainer's on borrowed hardware);
 * - `reporter-report`: a reporter's qualitative "works" or "colours look right";
 * - `inherited:<model>`: copied from the override recorded for that model;
 * - `provisional`: colour only. An inherited setting expected to match on
 *   this model but not yet confirmed on its hardware. It sits next to the
 *   `inherited:<model>` entry and links the capture the inherited bytes came
 *   from. It satisfies the ✅ colour check, but a ✅ model whose colour rests
 *   on it alone is listed as provisional and carries a README caveat, until
 *   a reporter scan or a capture supersedes it.
 */
export type EvidenceKind =
  | "epson-capture"
  | "own-capture"
  | "reporter-scan"
  | "reporter-report"
  | "provisional"
  | `inherited:${string}`;

/** Where the evidence is: a GitHub issue or PR, or a fixture in the tree (repo-relative path). */
export type EvidenceLink = { issue: number } | { pr: number } | { fixture: string };

export interface Evidence {
  kind: EvidenceKind;
  link: EvidenceLink;
}

/**
 * Colour evidence also records the colour settings it vouched for: the hash
 * of the override's colour bytes when it was recorded (colourSettingsHash in
 * test-support/provenance.ts). Changing those bytes leaves the old evidence
 * vouching for the old ones.
 */
export interface ColourEvidence extends Evidence {
  vouchesFor: string;
}

/**
 * The dialect fields a session always takes from the printer's own INFO and
 * CAPA replies (capabilityFields), for a model override and the generic
 * dialect alike. No override can carry them (ADR 0001).
 */
export interface CapabilityFields {
  /**
   * Whether the ADF can scan both sides. Read by assertSourceSupported at
   * PARA-build time: composing an `adf-duplex` PARA for a simplex-only ADF
   * sends the printer a segment its firmware never advertised. The panel
   * never offers 2-Sided on such models, but the host trigger (scan-now) can
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
 * printer with both reads it from the content of the status reply before
 * PARA, the one its errors are judged on ("ADF paper empty" means the
 * flatbed, anything else the ADF); a single-source printer is fixed to it,
 * which the reply never changes. Null
 * when INFO advertises no scan area at all: the session keeps the scanner
 * shell's default source.
 */
export type SourceDetection = "pre-para-status" | "fixed-flatbed" | "fixed-adf" | null;

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

/** What a session runs: its model override (or the generic dialect) plus the capability fields. */
export interface Dialect
  extends Omit<ModelOverride, "fbExtents" | "adfExtents" | "provenance">, CapabilityFields {
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
 * is not enough. A standard-profile override mistakenly given a
 * monoGammaClass therefore still resolves to host-side conversion instead of
 * silently producing colour output under an explicit grayscale setting.
 */
export function supportsWireGrayscale(entry: Dialect | undefined): boolean {
  return entry?.paraProfile === "adf-crp" && entry.monoGammaClass !== undefined;
}

const FRIDA = "tools/frida-capture/captures";
const PCAP = "tools/pcap-extract/captures";

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
    // 300: the replay fixtures. The rest: ET-4956 hardware, 2026-09-02 (#81):
    // flatbed at 75/150/600/1200, ADF at 75/150/200/600. 1200 is flatbed-only
    // (the ADF list caps at 600, and a 1200 ADF request caps to 600).
    verifiedWireDpis: [75, 150, 200, 300, 600, 1200],
    provenance: {
      models: ["ET-4950", "ET-4956"],
      siblings: { "ET-3950": [{ kind: "reporter-report", link: { pr: 22 } }] },
      colour: [
        {
          kind: "epson-capture",
          link: { fixture: `${FRIDA}/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl` },
          vouchesFor: "30e4b76739d1ec7d",
        },
      ],
      window: [
        {
          kind: "epson-capture",
          link: { fixture: `${FRIDA}/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl` },
        },
        {
          kind: "epson-capture",
          link: { fixture: `${FRIDA}/2026-04-24T08-56-07-adf-1p-simplex.jsonl` },
        },
      ],
      pollCount: [
        {
          kind: "epson-capture",
          link: { fixture: `${FRIDA}/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl` },
        },
      ],
    },
  },
  // The XP-4100 shares this CAPA fingerprint (flatbed-only, like the
  // ET-2750); its PID is not yet known, so it resolves by fingerprint.
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
    verifiedWireDpis: [300], // the replay fixture
    provenance: {
      models: ["ET-2750"],
      siblings: { "XP-4100": [{ kind: "reporter-scan", link: { issue: 139 } }] },
      colour: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/et-2750/flatbed-single-page-pdf.jsonl` },
          vouchesFor: "58b3f5eab4e7ab0c",
        },
      ],
      window: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/et-2750/flatbed-single-page-pdf.jsonl` },
        },
      ],
      pollCount: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/et-2750/flatbed-single-page-pdf.jsonl` },
        },
      ],
    },
  },
  // The JPG and PDF settings differ: the captures send each action its own
  // tone curve and colour matrix.
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
    verifiedWireDpis: [300], // the replay fixtures
    provenance: {
      models: ["XP-7100"],
      colour: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/xp-7100/jpg-flatbed.jsonl` },
          vouchesFor: "fde4765190a0f050",
        },
        {
          kind: "epson-capture",
          link: { fixture: "src/esci2/dialects/xp-7100-fixtures/pdf-single.bin" },
          vouchesFor: "fde4765190a0f050",
        },
      ],
      window: [
        { kind: "epson-capture", link: { fixture: `${PCAP}/xp-7100/jpg-flatbed.jsonl` } },
        { kind: "epson-capture", link: { fixture: `${PCAP}/xp-7100/jpg-adf-simplex.jsonl` } },
      ],
      // The captures poll 11-13 times; 3 is the ET-4950 count, run on the
      // reporter's hardware.
      pollCount: [{ kind: "reporter-report", link: { issue: 65 } }],
    },
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
    verifiedWireDpis: [], // no fixture, no reporter retest (#92)
    provenance: {
      models: ["ET-2950"],
      colour: [{ kind: "inherited:ET-4950", link: { pr: 94 }, vouchesFor: "30e4b76739d1ec7d" }],
      window: [{ kind: "inherited:ET-4950", link: { pr: 94 } }],
      pollCount: [{ kind: "inherited:ET-4950", link: { pr: 94 } }],
    },
  },
  {
    pids: ["1185"],
    names: [],
    capaFingerprints: ["7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2"],
    displayName: "ET-4800 (ESC/I-2 over plain TCP)",
    initPollIterations: 3,
    fbExtents: "generic",
    adfExtents: "generic",
    gmm: "UG18",
    gammaClass: { jpg: "et4800-stock", pdf: "et4800-stock" },
    cmxClass: { jpg: "et4800-um08", pdf: "et4800-um08" },
    verifiedWireDpis: [300], // the replay fixtures
    provenance: {
      models: ["ET-4800"],
      colour: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/et-4800/flatbed-jpg.jsonl` },
          vouchesFor: "c879eb3a1bbb0021",
        },
      ],
      window: [
        { kind: "epson-capture", link: { fixture: `${PCAP}/et-4800/flatbed-jpg.jsonl` } },
        { kind: "epson-capture", link: { fixture: `${PCAP}/et-4800/adf-jpg.jsonl` } },
      ],
      // The captures poll until ready (11-12 times); 3, the ET-4950 count, was
      // run on the reporter's hardware.
      pollCount: [{ kind: "reporter-report", link: { issue: 80 } }],
    },
  },
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
    verifiedWireDpis: [300], // the contributor's hardware run (#106)
    provenance: {
      models: ["ET-15000"],
      colour: [
        { kind: "inherited:ET-4800", link: { pr: 106 }, vouchesFor: "c879eb3a1bbb0021" },
        { kind: "reporter-report", link: { pr: 106 }, vouchesFor: "c879eb3a1bbb0021" },
      ],
      window: [
        { kind: "inherited:ET-4800", link: { pr: 106 } },
        { kind: "reporter-report", link: { pr: 106 } },
      ],
      pollCount: [
        { kind: "inherited:ET-4800", link: { pr: 106 } },
        { kind: "reporter-report", link: { pr: 106 } },
      ],
    },
  },
  // A long-page window, as captured: 8.5" x 36" at 200 DPI.
  {
    pids: [],
    names: ["FF-680W"],
    capaFingerprints: ["5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd"],
    displayName: "FF-680W (ESC/I-2 over plain TCP)",
    initPollIterations: 8,
    fbExtents: null, // ADF-only hardware — no flatbed
    adfExtents: { x0: 0, y0: 0, w: 1700, h: 7200 },
    windowDpi: 200,
    // A single-pass ADF: the back arrives the same way up as the front. First
    // read off the duplex fixture rendered raw (both sides upside down, the
    // sheet having gone in top edge first), then confirmed on hardware.
    duplexOrientationEvidence: {
      backRotated: false,
      source: "hardware report (#249): duplex backs arrive upright with no compensation",
    },
    gmm: "UG18",
    gammaClass: { jpg: "ff680w-adf", pdf: "ff680w-adf" },
    cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
    verifiedWireDpis: [200, 300], // the replay fixtures
    provenance: {
      models: ["FF-680W"],
      colour: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/ff-680w/adf-simplex-200.jsonl` },
          vouchesFor: "61b8d0509942f6e8",
        },
      ],
      window: [
        { kind: "epson-capture", link: { fixture: `${PCAP}/ff-680w/adf-simplex-200.jsonl` } },
      ],
      pollCount: [
        { kind: "epson-capture", link: { fixture: `${PCAP}/ff-680w/adf-simplex-200.jsonl` } },
      ],
    },
  },
  // The #ADFCRP flag bytes (SKEW/DFL1/DPLX) are scan options chosen in Epson's
  // GUI, which this service does not model: the composer pins the FF-680W's
  // (SKEW+[DPLX]+DFL1). The colour capture sends exactly that; the greyscale
  // captures used other GUI orderings, so they replay functionally with only
  // the greyscale gamma and CMX pinned. The window is 8.5" x 15.5" at 200 DPI.
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
    // 400 and 600: the replay fixtures. 200: the one DPI hardware-verified
    // (README: duplex colour PDF @ 200 DPI).
    verifiedWireDpis: [200, 400, 600],
    provenance: {
      models: ["DS-575W"],
      colour: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/ds-575w/adf-simplex-600-color-jpg.oracle.jsonl` },
          vouchesFor: "f33610fd1279afc6",
        },
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/ds-575w/adf-simplex-400-mono-jpg.jsonl` },
          vouchesFor: "f33610fd1279afc6",
        },
        { kind: "reporter-report", link: { issue: 128 }, vouchesFor: "f33610fd1279afc6" },
      ],
      window: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/ds-575w/adf-duplex-600-mono-jpg.jsonl` },
        },
      ],
      pollCount: [
        {
          kind: "epson-capture",
          link: { fixture: `${PCAP}/ds-575w/adf-duplex-600-mono-jpg.jsonl` },
        },
      ],
    },
  },
  // The ET-2810 never triggers a scan itself: its button combo is a USB-host
  // scan and it lists no network destination, so it is host-trigger only.
  //
  // The XP-3200 (announced PID 11AF) shares this CAPA fingerprint but presents
  // over TLS. Its panel lists the destination, yet starting a scan fails at
  // once with "Invalid" and sends the host nothing (no push-scan connection,
  // no unicast probe): the printer rejects it before contacting us, so it is
  // host-trigger only too.
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
    verifiedWireDpis: [300], // the reporter's hardware (#132)
    provenance: {
      models: ["ET-2810"],
      siblings: { "XP-3200": [{ kind: "reporter-scan", link: { pr: 149 } }] },
      colour: [
        { kind: "inherited:ET-4800", link: { pr: 133 }, vouchesFor: "c879eb3a1bbb0021" },
        { kind: "reporter-scan", link: { issue: 132 }, vouchesFor: "c879eb3a1bbb0021" },
      ],
      window: [
        { kind: "inherited:ET-4800", link: { pr: 133 } },
        { kind: "reporter-report", link: { issue: 132 } },
      ],
      pollCount: [
        { kind: "inherited:ET-4800", link: { pr: 133 } },
        { kind: "reporter-report", link: { issue: 132 } },
      ],
    },
  },
  // Reported over TLS (#120) and over plain TCP (#123) with the same CAPA
  // fingerprint, so one override serves both transports. It sends the neutral
  // pair: the ET-4950's captured tone curve with the identity matrix.
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
    cmxClass: { jpg: "identity-um08", pdf: "identity-um08" },
    verifiedWireDpis: [300], // the reporter's hardware (#120)
    provenance: {
      models: ["ET-8500"],
      colour: [
        // The earlier mixed pair: the tone curve from the ET-4950, the matrix
        // from the ET-4800. The reports vouch for it only.
        { kind: "inherited:ET-4950", link: { pr: 121 }, vouchesFor: "e15913fe2ab564e6" },
        { kind: "inherited:ET-4800", link: { pr: 121 }, vouchesFor: "e15913fe2ab564e6" },
        { kind: "reporter-report", link: { issue: 120 }, vouchesFor: "e15913fe2ab564e6" },
        { kind: "reporter-report", link: { issue: 123 }, vouchesFor: "e15913fe2ab564e6" },
        // The neutral pair: the ET-4950's captured tone curve, expected to
        // match, with the identity matrix as the ET-2750 capture carries it.
        // Provisional until a scan checks it.
        {
          kind: "inherited:ET-4950",
          link: { fixture: `${FRIDA}/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl` },
          vouchesFor: "58b3f5eab4e7ab0c",
        },
        {
          kind: "inherited:ET-2750",
          link: { fixture: `${PCAP}/et-2750/flatbed-single-page-pdf.jsonl` },
          vouchesFor: "58b3f5eab4e7ab0c",
        },
        {
          kind: "provisional",
          link: { fixture: `${FRIDA}/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl` },
          vouchesFor: "58b3f5eab4e7ab0c",
        },
      ],
      window: [
        { kind: "inherited:ET-4800", link: { pr: 121 } },
        { kind: "reporter-report", link: { issue: 120 } },
      ],
      pollCount: [
        { kind: "inherited:ET-2950", link: { pr: 121 } },
        { kind: "reporter-report", link: { issue: 120 } },
      ],
    },
  },
  // Shaped like the ET-8500 (same AREA, GMM, CMX and QIT lists), but its CAPA
  // fingerprint differs, so it is an override of its own. It sends a neutral
  // pair: the XP-7100's xp7100-pdf tone curve with the identity matrix. Its
  // fixtures are own captures of the earlier pair, so its replay holds the
  // PARA to them everywhere but #GMT and #CMX.
  {
    pids: ["112B"],
    names: [],
    capaFingerprints: ["72319314b621fea0aab6cc16f4fd891534cec08f33ce80116a849f6f6e1e58d4"],
    displayName: "ET-7700 (ESC/I-2)",
    initPollIterations: 3,
    fbExtents: "generic",
    adfExtents: null,
    gmm: "UG18",
    gammaClass: { jpg: "xp7100-pdf", pdf: "xp7100-pdf" },
    cmxClass: { jpg: "identity-um08", pdf: "identity-um08" },
    verifiedWireDpis: [300], // the replay fixtures (#145)
    provenance: {
      models: ["ET-7700"],
      colour: [
        // The earlier mixed pair, the ET-8500's at the time: the replay
        // fixtures record it, and the reporter's scan measured it.
        { kind: "inherited:ET-8500", link: { pr: 153 }, vouchesFor: "e15913fe2ab564e6" },
        {
          kind: "own-capture",
          link: { fixture: `${PCAP}/et-7700/flatbed-jpg.jsonl` },
          vouchesFor: "e15913fe2ab564e6",
        },
        { kind: "reporter-scan", link: { issue: 145 }, vouchesFor: "e15913fe2ab564e6" },
        // The neutral pair: the XP-7100's captured xp7100-pdf tone curve,
        // expected to match, with the identity matrix as the ET-2750 capture
        // carries it. Provisional until a scan checks it.
        {
          kind: "inherited:XP-7100",
          link: { fixture: "src/esci2/dialects/xp-7100-fixtures/pdf-single.bin" },
          vouchesFor: "8515bd5a3e9c5c62",
        },
        {
          kind: "inherited:ET-2750",
          link: { fixture: `${PCAP}/et-2750/flatbed-single-page-pdf.jsonl` },
          vouchesFor: "8515bd5a3e9c5c62",
        },
        {
          kind: "provisional",
          link: { fixture: "src/esci2/dialects/xp-7100-fixtures/pdf-single.bin" },
          vouchesFor: "8515bd5a3e9c5c62",
        },
      ],
      window: [{ kind: "own-capture", link: { fixture: `${PCAP}/et-7700/flatbed-jpg.jsonl` } }],
      pollCount: [{ kind: "own-capture", link: { fixture: `${PCAP}/et-7700/flatbed-jpg.jsonl` } }],
    },
  },
  // The tone curve is a judgement call. By segment shape (QIT present, CCT
  // absent) the nearest overrides are the ET-8500 and ET-7700, on flat
  // near-identity curves; by hardware class (an office AIO) it is the ET-4800
  // and ET-15000, on et4800-stock. It follows hardware class: a flat curve was
  // chosen for the photo models. If wrong, et4800-stock crushes shadows, which
  // a compatibility-page scan would show as a lifted black floor.
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
    // Flip to [300] in the PR that flips the README row to ✅ (#174).
    verifiedWireDpis: [],
    provenance: {
      models: ["WF-3835"],
      // The reporter ran a field-for-field identical override of their own:
      // a flatbed PDF, uploaded to Paperless-ngx without errors. ADF untested.
      colour: [
        { kind: "inherited:ET-4800", link: { pr: 175 }, vouchesFor: "c879eb3a1bbb0021" },
        { kind: "reporter-report", link: { issue: 174 }, vouchesFor: "c879eb3a1bbb0021" },
      ],
      window: [
        { kind: "inherited:ET-4800", link: { pr: 175 } },
        { kind: "reporter-report", link: { issue: 174 } },
      ],
      pollCount: [
        { kind: "inherited:ET-4800", link: { pr: 175 } },
        { kind: "reporter-report", link: { issue: 174 } },
      ],
    },
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
 * Builds the fingerprint index, refusing a fingerprint listed by two
 * overrides rather than letting the later one silently win.
 */
function indexByFingerprint(overrides: readonly ModelOverride[]): Map<string, ModelOverride> {
  const index = new Map<string, ModelOverride>();
  for (const override of overrides) {
    for (const fp of override.capaFingerprints) {
      const other = index.get(fp);
      if (other !== undefined) {
        throw new Error(
          `CAPA fingerprint ${fp} is listed by both ${other.displayName} and ${override.displayName}`,
        );
      }
      index.set(fp, override);
    }
  }
  return index;
}
