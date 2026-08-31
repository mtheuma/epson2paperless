// src/esci2/para-composer.ts
import { GAMMA_CLASSES, type GammaClassName } from "./data/gamma-classes.js";
import { CMX_CLASSES, type CmxClassName } from "./data/cmx-classes.js";

export interface Extents {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

// The "adf-crp" profile drives the #ADFCRP-led PARA shared by the FF-680W and
// its DS-575W sibling — byte-identical layout apart from resolution, ACQ
// extents, colour mode, and the gamma/CMX class data (all registry-supplied).
export type ParaProfile = "standard" | "adf-crp";

export interface ParaSpec {
  source: "flatbed" | "adf-simplex" | "adf-duplex";
  action: "jpg" | "pdf";
  /** Flatbed scan extents; null for ADF-only dialects, which never compose a flatbed PARA. */
  fbExtents: Extents | null;
  adfExtents: Extents | null;
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass: { jpg: CmxClassName | null; pdf: CmxClassName | null };
  optionalSegments: { qit: boolean; cct: boolean };
  profile?: ParaProfile;
  /**
   * Scan resolution in DPI. Consumed by BOTH profiles: drives #RSM/#RSS and
   * scales the chosen ACQ extents (all four fields) off each profile's
   * registry-extent reference DPI — STANDARD_BASE_DPI (300) for the standard
   * profile, ADF_CRP_BASE_DPI (200) for adf-crp. Falls back to that profile's
   * base DPI when unset, reproducing the captured bytes exactly.
   */
  resolution?: number;
  /**
   * Colour mode. Consumed ONLY by the adf-crp profile: "grayscale" emits
   * #COLM008 + the monoGammaClass LUT; "color" (the default) emits #COLC024 +
   * the RGB gammaClass triplet. The FF-680W is colour-only and leaves this
   * unset, reproducing its captured #COLC024 bytes exactly.
   */
  colorMode?: "color" | "grayscale";
  /**
   * Single-channel gamma LUT for grayscale scans on the adf-crp profile. Its
   * presence is what makes a dialect greyscale-capable: grayscale is emitted
   * only when colorMode is "grayscale" AND this is set. A dialect that leaves it
   * unset stays colour (#COLC024) even under a global SCAN_COLOR_MODE=grayscale,
   * the same way colour-only dialects ignore an unsupported setting. Ignored
   * entirely in colour mode.
   */
  monoGammaClass?: GammaClassName;
  /**
   * JPEG encode quality, wire field #JPGdNNN (three-digit, 1..100). Consumed
   * by BOTH profiles. Falls back to 90 when unset, reproducing the captured
   * bytes exactly.
   */
  jpegQuality?: number;
}

/** Reference DPI the standard profile's registry extents are captured at. */
export const STANDARD_BASE_DPI = 300;

const pad3 = (n: number): string => n.toString().padStart(3, "0");

// Replaces the old STANDARD_FIXED_PREFIX constant. Defaults (300, 90)
// reproduce its bytes exactly.
function renderStandardPrefix(resolution: number, jpegQuality: number): Buffer {
  return Buffer.from(
    `#RSMi${pad7(resolution)}#RSSi${pad7(resolution)}#COLC024#FMTJPG #JPGd${pad3(jpegQuality)}`,
    "ascii",
  );
}

const ADF_CRP_PREFIX_HEAD = "#ADFCRP SKEW";
// The registry's adfExtents are captured at this DPI; both the RSM/RSS
// resolution fields and the ACQ extents scale linearly off it. For the FF-680W
// only 200 and 300 are wire-verified — see
// .reference/wireshark-captures/ff-680w/SOURCE-NOTES.md. DS-575W adfExtents are
// stored at the same 200-DPI reference (wire captures at 400 and 600 confirm the
// linear scaling).
const ADF_CRP_BASE_DPI = 200;

const ADF_CRP_TRAILER_BEFORE_ACQ = Buffer.from(
  "#CRPi0000000" + "#DFAi0000000i0001550" + "#LAMOFF " + "#PAGd000",
  "ascii",
);

const TRAILING_BSZ = Buffer.from("#BSZi1048576", "ascii");

const pad7 = (n: number): string => n.toString().padStart(7, "0");

function renderAcq(e: Extents): Buffer {
  return Buffer.from(`#ACQi${pad7(e.x0)}i${pad7(e.y0)}i${pad7(e.w)}i${pad7(e.h)}`, "ascii");
}

function renderSourceSegment(source: ParaSpec["source"]): Buffer {
  switch (source) {
    case "flatbed":
      return Buffer.from("#FB ", "ascii");
    case "adf-simplex":
      return Buffer.from("#ADF", "ascii");
    case "adf-duplex":
      return Buffer.from("#ADFDPLX", "ascii");
  }
}

function validate(spec: ParaSpec): void {
  if ((spec.source === "adf-simplex" || spec.source === "adf-duplex") && spec.adfExtents === null) {
    throw new Error(`composePara: source=${spec.source} requires non-null adfExtents`);
  }
  // The flatbed twin of the guard above. Lives here — before the profile
  // dispatch — so it covers every profile: an ADF-only dialect (fbExtents:
  // null) asked for a flatbed scan must fail fast regardless of which
  // composer would have run.
  if (spec.source === "flatbed" && spec.fbExtents === null) {
    throw new Error("composePara: source=flatbed requires non-null fbExtents");
  }
  const checkExtents = (name: string, e: Extents | null): void => {
    if (e === null) return;
    for (const k of ["x0", "y0", "w", "h"] as const) {
      // #ACQ renders each value as a fixed-width 7-digit field (i%07d), so the
      // valid range is 0..9999999. Values >= 1e7 would silently widen the field
      // and desync every byte offset after #ACQ — reject them here, where the
      // error path already exists, rather than letting renderAcq emit a
      // malformed segment.
      if (!Number.isInteger(e[k]) || e[k] < 0 || e[k] > 9_999_999) {
        throw new Error(
          `composePara: ${name}.${k}=${e[k]} must be a non-negative integer in 0..9999999`,
        );
      }
    }
  };
  checkExtents("fbExtents", spec.fbExtents);
  checkExtents("adfExtents", spec.adfExtents);
  const gJpg = GAMMA_CLASSES[spec.gammaClass.jpg];
  const gPdf = GAMMA_CLASSES[spec.gammaClass.pdf];
  if (!gJpg) throw new Error(`composePara: unknown gammaClass.jpg=${spec.gammaClass.jpg}`);
  if (!gPdf) throw new Error(`composePara: unknown gammaClass.pdf=${spec.gammaClass.pdf}`);
  if (spec.monoGammaClass !== undefined && !GAMMA_CLASSES[spec.monoGammaClass]) {
    throw new Error(`composePara: unknown monoGammaClass=${spec.monoGammaClass}`);
  }
  if (spec.cmxClass.jpg !== null && !CMX_CLASSES[spec.cmxClass.jpg]) {
    throw new Error(`composePara: unknown cmxClass.jpg=${spec.cmxClass.jpg}`);
  }
  if (spec.cmxClass.pdf !== null && !CMX_CLASSES[spec.cmxClass.pdf]) {
    throw new Error(`composePara: unknown cmxClass.pdf=${spec.cmxClass.pdf}`);
  }
  if (spec.gmm.length !== 4) {
    throw new Error(`composePara: gmm must be exactly 4 ASCII chars, got ${spec.gmm.length}`);
  }
  if (
    spec.jpegQuality !== undefined &&
    (!Number.isInteger(spec.jpegQuality) || spec.jpegQuality < 1 || spec.jpegQuality > 100)
  ) {
    throw new Error(`composePara: jpegQuality=${spec.jpegQuality} must be an integer in 1..100`);
  }
}

export function composePara(spec: ParaSpec): Buffer {
  validate(spec);

  if (spec.profile === "adf-crp") {
    return composeAdfCrpPara(spec);
  }

  return composeStandardPara(spec);
}

function composeStandardPara(spec: ParaSpec): Buffer {
  const resolution = spec.resolution ?? STANDARD_BASE_DPI;
  const jpegQuality = spec.jpegQuality ?? 90;

  const parts: Buffer[] = [];
  // 1. Source segment.
  parts.push(renderSourceSegment(spec.source));
  // 2. Fixed constants (resolution + quality now variable; defaults reproduce
  // the old fixed bytes exactly).
  parts.push(renderStandardPrefix(resolution, jpegQuality));
  // 3. GMM.
  parts.push(Buffer.from(`#GMM${spec.gmm}`, "ascii"));
  // 4. Gamma LUT triplet (verbatim bytes for the action's class).
  parts.push(GAMMA_CLASSES[spec.gammaClass[spec.action]]);
  // 5. CMX, if class non-null.
  const cmxName = spec.cmxClass[spec.action];
  if (cmxName !== null) {
    parts.push(CMX_CLASSES[cmxName]);
  }
  // 6. QIT, if requested.
  if (spec.optionalSegments.qit) {
    parts.push(Buffer.from("#QITOFF ", "ascii"));
  }
  // 7. CCT, if requested.
  if (spec.optionalSegments.cct) {
    parts.push(Buffer.from("#CCTCOL ", "ascii"));
  }
  // 8. PAG, if ADF source.
  if (spec.source !== "flatbed") {
    parts.push(Buffer.from("#PAGd000", "ascii"));
  }
  // 9. ACQ extents (fb or adf, per source). Registry extents are pinned at
  // STANDARD_BASE_DPI; scale all four fields (offsets included — e.g. the
  // ET-4950 ADF's x0=69 would drift the crop at any other DPI) to the chosen
  // resolution. Scale is 1 at the default, keeping the replay shields
  // byte-identical.
  const scale = resolution / STANDARD_BASE_DPI;
  const scaleExtents = (e: Extents): Extents => ({
    x0: Math.round(e.x0 * scale),
    y0: Math.round(e.y0 * scale),
    w: Math.round(e.w * scale),
    h: Math.round(e.h * scale),
  });
  const acqExtents = spec.source === "flatbed" ? spec.fbExtents! : spec.adfExtents!;
  parts.push(renderAcq(scaleExtents(acqExtents)));
  // 10. BSZ trailing constant.
  parts.push(TRAILING_BSZ);

  return Buffer.concat(parts);
}

function composeAdfCrpPara(spec: ParaSpec): Buffer {
  // The adf-crp profile has no flatbed body at all — its source axis only
  // selects the DPLX token. Reject flatbed outright rather than silently
  // composing an ADF PARA for a flatbed request (validate() already blocks
  // the null-fbExtents case; this catches a hypothetical adf-crp dialect
  // that carries flatbed extents).
  if (spec.source === "flatbed") {
    throw new Error("composePara: profile=adf-crp has no flatbed source");
  }
  if (spec.adfExtents === null) {
    throw new Error("composePara: profile=adf-crp requires non-null adfExtents");
  }
  const cmxName = spec.cmxClass[spec.action];
  if (cmxName === null) {
    throw new Error("composePara: profile=adf-crp requires a CMX class");
  }
  const resolution = spec.resolution ?? ADF_CRP_BASE_DPI;
  const jpegQuality = spec.jpegQuality ?? 90;
  const dplx = spec.source === "adf-duplex" ? "DPLX" : "";

  // Colour mode selects the #COL code and gamma LUT. Greyscale needs the
  // single-channel monoGammaClass; colour uses the RGB gammaClass triplet. A
  // grayscale request only takes effect when the dialect supplies a
  // monoGammaClass — colour-only dialects (FF-680W) ignore it and stay #COLC024,
  // mirroring how resolution is ignored by dialects that don't consume it.
  const grayscale = spec.colorMode === "grayscale" && spec.monoGammaClass !== undefined;
  const colSegment = grayscale ? "#COLM008" : "#COLC024";
  const gammaName = grayscale ? spec.monoGammaClass! : spec.gammaClass[spec.action];

  const prefix = Buffer.from(
    ADF_CRP_PREFIX_HEAD +
      dplx +
      "DFL1" +
      `#RSMi${pad7(resolution)}` +
      `#RSSi${pad7(resolution)}` +
      colSegment +
      "#FMTJPG " +
      `#JPGd${pad3(jpegQuality)}`,
    "ascii",
  );

  // ACQ extents scale linearly with DPI from the 200-DPI registry reference.
  const scale = resolution / ADF_CRP_BASE_DPI;
  const acq: Extents = {
    x0: spec.adfExtents.x0,
    y0: spec.adfExtents.y0,
    w: Math.round(spec.adfExtents.w * scale),
    h: Math.round(spec.adfExtents.h * scale),
  };

  return Buffer.concat([
    prefix,
    Buffer.from(`#GMM${spec.gmm}`, "ascii"),
    GAMMA_CLASSES[gammaName],
    CMX_CLASSES[cmxName],
    ADF_CRP_TRAILER_BEFORE_ACQ,
    renderAcq(acq),
    TRAILING_BSZ,
  ]);
}

export type { GammaClassName, CmxClassName };
