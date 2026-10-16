// src/esci2/dialects/generic.ts
import { parseArea, type CapaTokens, type InfoTokens } from "../capabilities.js";
import type { ColourPair } from "../data/colour-pair.js";
import {
  capabilityFields,
  deriveCapabilities,
  listItems,
  type DerivedCapabilities,
} from "../derivation.js";
import { baseDpiFor, type Extents, type ParaProfile, type ParaSpec } from "../para-composer.js";
import { genericWindow, type WindowSource } from "../scan-window.js";
import type { Dialect } from "./registry.js";

/**
 * The generic dialect: what an ESC/I-2 printer with no model override is
 * sent. Every field comes from the printer's own INFO and CAPA replies
 * (deriveCapabilities), except three rules of our own:
 *
 * - colour: the neutral pair, which leaves colour to the host;
 * - scan window: the generic window (A4, or the full ADF area in crop mode);
 * - poll count: 3, or 12 for an ADF-only printer.
 *
 * Experimental by definition: no report confirms it on any printer yet.
 */

/**
 * Thrown when the printer's replies leave out something the generic dialect
 * can't do without. The session fails fast with this reason and the
 * diagnostic block rather than sending a guess.
 */
export class GenericDialectUnusableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GenericDialectUnusableError";
  }
}

/** The ET-4950 family's captured tone curve: gray balance only, tagged neutral. */
const NEUTRAL_TONE_CURVE = "et4950-stock";
/** The identity UM08 matrix, captured on the ET-2750 (isIdentityCmx confirms it from the bytes). */
const IDENTITY_MATRIX = "et2750-um08";

/** Poll counts. 3 is what most captured printers with a flatbed are polled for. */
const POLLS_WITH_FLATBED = 3;
// 12 is for timing parity with the captured driver on an ADF-only scanner
// (the DS-575W): the poll count can't be derived, and nothing shows an
// ADF-only printer needs this many.
const POLLS_ADF_ONLY = 12;

/**
 * The neutral pair: the neutral tone curve with the identity UM08 matrix,
 * in gamma mode UG18 (UG10 when that's all the printer lists). A printer
 * that lists no UM08 matrix is sent SoC-style instead: UG10 and no matrix,
 * failing if it doesn't list UG10 either. Crop mode (adf-crp) always sends
 * a matrix, so there it fails.
 */
export function genericColourPair(capa: CapaTokens, profile: ParaProfile): ColourPair {
  const modes = listItems(capa.gmmList);
  if (!modes.includes("UG18") && !modes.includes("UG10")) {
    throw new GenericDialectUnusableError(
      `its CAPA reply lists no gamma mode the generic dialect can send (UG18 or UG10)`,
    );
  }
  if (listItems(capa.cmxList).includes("UM08")) {
    return {
      gmm: modes.includes("UG18") ? "UG18" : "UG10",
      gamma: NEUTRAL_TONE_CURVE,
      cmx: IDENTITY_MATRIX,
    };
  }
  if (profile === "adf-crp") {
    throw new GenericDialectUnusableError(
      "its CAPA reply lists no UM08 colour matrix, which crop-mode (adf-crp) scanning needs",
    );
  }
  if (!modes.includes("UG10")) {
    throw new GenericDialectUnusableError(
      "its CAPA reply lists no UM08 colour matrix and no UG10 gamma mode to send without one",
    );
  }
  return { gmm: "UG10", gamma: NEUTRAL_TONE_CURVE, cmx: null };
}

/** How a session names the printer it is running the generic dialect for. */
export function printerIdentity(info: InfoTokens): string {
  if (info.prdPid !== null) return `PID ${info.prdPid}`;
  return info.prdName ?? "unidentified printer";
}

/**
 * Builds the generic dialect. Its windows are the generic window at the
 * profile's reference DPI; the PARA itself takes the generic window at the
 * wire DPI instead (genericParaFields), since scaling a reference window can
 * overrun the scan area. Its capability fields are the ones every session
 * takes (capabilityFields).
 *
 * Throws GenericDialectUnusableError when the CAPA reply can't be parsed,
 * when it lists no JPG format, when INFO advertises no usable scan area, or
 * when the colour pair can't be formed.
 */
export function buildGenericEntry(
  info: InfoTokens,
  capa: CapaTokens,
  derived: DerivedCapabilities = deriveCapabilities(info, capa),
): Dialect {
  if (capa.segments.length === 0) {
    throw new GenericDialectUnusableError("its CAPA reply couldn't be parsed");
  }
  if (!listItems(capa.fmtList).includes("JPG")) {
    throw new GenericDialectUnusableError("its CAPA reply lists no JPG format");
  }
  const profile = derived.paraProfile;
  const windowFor = (source: WindowSource): Extents | null => {
    if (!derived.sources[source]) return null;
    const window = genericWindow(info, source, profile, baseDpiFor(profile));
    if (window === null) {
      const area = source === "flatbed" ? info.fbArea : info.adfArea;
      throw new GenericDialectUnusableError(`its ${source} scan area (${area}) isn't usable`);
    }
    return window;
  };
  const fbExtents = windowFor("flatbed");
  const adfExtents = windowFor("adf");
  if (fbExtents === null && adfExtents === null) {
    throw new GenericDialectUnusableError("its INFO reply advertises no scan area");
  }
  const pair = genericColourPair(capa, profile);
  return {
    pids: [],
    names: [],
    capaFingerprints: [],
    displayName: `generic ESC/I-2 dialect (${printerIdentity(info)})`,
    sourceDetection:
      fbExtents !== null && adfExtents !== null
        ? "stat-content"
        : fbExtents !== null
          ? "fixed-flatbed"
          : "fixed-adf",
    initPollIterations: fbExtents !== null ? POLLS_WITH_FLATBED : POLLS_ADF_ONLY,
    fbExtents,
    adfExtents,
    duplexBackRotated: derived.duplexBackRotated,
    gmm: pair.gmm,
    gammaClass: { jpg: pair.gamma, pdf: pair.gamma },
    cmxClass: { jpg: pair.cmx, pdf: pair.cmx },
    verifiedWireDpis: [],
    ...capabilityFields(derived),
  };
}

/**
 * The PARA fields the generic dialect computes per scan rather than keeping
 * on its entry:
 *
 * - acqExtents: the generic window for `source` at the wire DPI, the
 *   reference window scaled, then clipped to the scan area at that DPI, so
 *   no DPI lands past the edge;
 * - adfCrpDfaLength (crop mode): the ADF area's height, which is the value
 *   the FF-680W and DS-575W captures carry there.
 *
 * Throws if the area leaves nothing to scan at that DPI.
 */
export function genericParaFields(
  info: InfoTokens,
  entry: Dialect,
  source: ParaSpec["source"],
  dpi: number,
): Pick<ParaSpec, "acqExtents" | "adfCrpDfaLength"> {
  const windowSource: WindowSource = source === "flatbed" ? "flatbed" : "adf";
  const acqExtents = genericWindow(info, windowSource, entry.paraProfile, dpi);
  if (acqExtents === null) {
    throw new Error(`${entry.displayName}: no ${windowSource} scan window at ${dpi} DPI`);
  }
  if (entry.paraProfile !== "adf-crp") return { acqExtents };
  return { acqExtents, adfCrpDfaLength: parseArea(info.adfArea)!.height };
}
