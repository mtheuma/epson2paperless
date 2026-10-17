import {
  MODEL_OVERRIDES,
  type Dialect,
  type DialectWindow,
  type OverrideWindow,
  type ModelOverride,
} from "./model-overrides.js";
import {
  STANDARD_BASE_DPI,
  baseDpiFor,
  scaleEdges,
  type Extents,
  type ParaSpec,
} from "../para-composer.js";
import { buildDiagnostic, UnsupportedDialectError } from "../diagnostic.js";
import type { CapaTokens, InfoTokens } from "../capabilities.js";
import { buildGenericDialect, GenericDialectUnusableError, printerIdentity } from "./generic.js";
import { capabilityFields, deriveCapabilities, type DerivedCapabilities } from "../derivation.js";
import {
  fitsScanArea,
  genericWindowIn,
  inheritedWindow,
  ownWindows,
  type WindowSource,
} from "../scan-window.js";
import { createLogger } from "../../logger.js";

const log = createLogger("scanner-esci2");

/** Which key resolved a session's model override, or "generic" when none did. */
export type IdentityMatch = "pid" | "name" | "fingerprint" | "generic";

export interface ResolvedDialect {
  dialect: Dialect;
  matchedBy: IdentityMatch;
}

/** What INIT1 knows when it resolves the dialect. */
export interface Init1Replies {
  /** INFO and CAPA, parsed once by the caller. */
  info: InfoTokens;
  capa: CapaTokens;
  fingerprint: string;
  /** Raw bodies, rendered into the diagnostic block on a miss or mismatch. */
  infoBody: Buffer;
  capaBody: Buffer;
  transport: "tls" | "plain";
}

/**
 * Looks up the model override by model identity: the INFO product ID, then
 * the INFO product name, then the CAPA fingerprint, and completes it with the
 * capability fields derived from this printer's own replies. When none matches, the
 * printer gets the generic dialect, built from its own replies, with a
 * warning and the diagnostic block for the report. Throws
 * UnsupportedDialectError with the diagnostic block only when the generic
 * dialect can't be built either.
 *
 * A PID or name hit whose CAPA fingerprint isn't one of the override's logs
 * a warning with the diagnostic block and proceeds with that override: the model
 * is known, and its CAPA reply may have changed with a firmware update.
 *
 * Called from INIT1_CAPA in the graph state machine. INFO is read before
 * CAPA, so the identity is available on every trigger path, including the
 * host-triggered ones that carry no panel PID.
 */
export function resolveDialect(replies: Init1Replies): ResolvedDialect {
  const { info, capa, fingerprint } = replies;
  const derived = deriveCapabilities(info, capa);
  // prdPid is canonical upper-case hex, and overrides store names upper-case
  // (both pinned by model-overrides.test.ts), so only the reported name needs folding.
  const { prdPid } = info;
  const prdName = info.prdName?.toUpperCase() ?? null;
  const byPid = prdPid === null ? undefined : MODEL_OVERRIDES.find((e) => e.pids.includes(prdPid));
  const byName =
    prdName === null ? undefined : MODEL_OVERRIDES.find((e) => e.names.includes(prdName));
  const byFingerprint = MODEL_OVERRIDES.find((e) => e.capaFingerprints.includes(fingerprint));

  const byIdentity = byPid ?? byName;
  if (byIdentity !== undefined) {
    const matchedBy = byPid !== undefined ? "pid" : "name";
    const fingerprintMatches = byIdentity.capaFingerprints.includes(fingerprint);
    if (!fingerprintMatches) {
      const reported = matchedBy === "pid" ? `PID ${prdPid}` : `product name ${info.prdName}`;
      log.warn(
        `Printer identified as ${byIdentity.displayName} by its ${reported}, but its CAPA ` +
          `fingerprint is not one recorded for that model` +
          (byFingerprint ? ` (it is the ${byFingerprint.displayName} one)` : "") +
          `. Continuing with that model's settings; if the scan fails or looks wrong, ` +
          `please file an issue with the diagnostic block below:\n\n${buildDiagnostic(replies)}`,
      );
    }
    const dialect = resolveOverride(byIdentity, replies, derived, fingerprintMatches);
    return { dialect, matchedBy };
  }

  if (byFingerprint !== undefined) {
    const dialect = resolveOverride(byFingerprint, replies, derived, true);
    return { dialect, matchedBy: "fingerprint" };
  }
  return { dialect: resolveGenericDialect(replies, derived), matchedBy: "generic" };
}

/**
 * Completes an override into the session's dialect.
 *
 * On a CAPA fingerprint mismatch the printer isn't the one the override was
 * recorded from, so each window of its own is kept only while it still fits
 * the scan area this printer reports; otherwise the source gets the generic
 * window, with a warning.
 *
 * A source left with no window (the override inherits the generic one, or
 * fell back to it, and the printer advertises no usable scan area for it)
 * is said so with the diagnostic block now, since a scan from it fails at
 * PARA build (assertSourceSupported).
 */
function resolveOverride(
  override: ModelOverride,
  replies: Init1Replies,
  derived: DerivedCapabilities,
  fingerprintMatches: boolean,
): Dialect {
  const completed = withCapabilities(override, replies.info, derived);
  const entry = fingerprintMatches ? completed : keepFittingWindows(completed, replies.info);
  const missing = (["flatbed", "adf"] as const).filter(
    (source) =>
      (source === "flatbed" ? override.fbExtents : override.adfExtents) !== null &&
      (source === "flatbed" ? entry.fbExtents : entry.adfExtents) === null,
  );
  if (missing.length > 0) {
    log.warn(
      `${override.displayName}: its INFO reply advertises no usable ${missing.join(" or ")} ` +
        `scan area, so scans from it will fail. Please file an issue with the diagnostic ` +
        `block below:\n\n${buildDiagnostic(replies)}`,
    );
  }
  return entry;
}

/**
 * The dialect with each of its own windows that leaves the printer's scan
 * area replaced by the generic window for that area, with a warning. An
 * inherited window is the generic one already, and fits by construction.
 * Where INFO advertises no usable area there is no generic window either:
 * the source is left with none, which resolveOverride warns about.
 */
function keepFittingWindows(entry: Dialect, info: InfoTokens): Dialect {
  const profile = entry.paraProfile;
  const out = { ...entry };
  for (const [source, window] of ownWindows(entry)) {
    if (fitsScanArea(info, source, window, profile)) continue;
    const generic = inheritedWindow(info, source, profile);
    if (generic !== null) {
      const { x0, y0, w, h } = window;
      log.warn(
        `${entry.displayName}: its ${source} scan window (${w}x${h} at ${x0},${y0}, ` +
          `${baseDpiFor(profile)} DPI) doesn't fit the scan area this printer reports, so ` +
          `the generic scan window is used instead.`,
      );
    }
    if (source === "flatbed") out.fbExtents = generic;
    else out.adfExtents = generic;
  }
  return out;
}

/**
 * A model override completed with the capability fields derived from the
 * printer's own replies, the same ones the generic dialect is built with.
 *
 * The override's own windows are pinned at its windowDpi, and the composer
 * reads them at the derived profile's reference DPI. When the two differ (a
 * printer whose replies give it the other profile), they are rescaled so
 * they keep their physical size. A window the override inherits ("generic")
 * is the generic window for this printer's scan area, at that reference DPI
 * here and at the wire DPI in the PARA (makeParaSpec); null when the
 * printer advertises no area for the source. Provenance stays behind: no
 * session reads it.
 */
export function withCapabilities(
  override: ModelOverride,
  info: InfoTokens,
  derived: DerivedCapabilities,
): Dialect {
  const { provenance: _provenance, ...rest } = override;
  const fields = capabilityFields(derived);
  const dpi = baseDpiFor(fields.paraProfile);
  const scale = dpi / (override.windowDpi ?? STANDARD_BASE_DPI);
  const window = (source: WindowSource, w: OverrideWindow): DialectWindow | null => {
    if (w !== "generic") return w === null || scale === 1 ? w : scaleEdges(w, scale);
    return inheritedWindow(info, source, fields.paraProfile);
  };
  return {
    ...rest,
    fbExtents: window("flatbed", override.fbExtents),
    adfExtents: window("adf", override.adfExtents),
    ...(scale === 1 ? {} : { windowDpi: dpi }),
    ...fields,
  };
}

function resolveGenericDialect(replies: Init1Replies, derived: DerivedCapabilities): Dialect {
  const diagnostic = buildDiagnostic(replies);
  let entry: Dialect;
  try {
    entry = buildGenericDialect(replies.info, replies.capa, derived);
  } catch (err) {
    if (!(err instanceof GenericDialectUnusableError)) throw err;
    throw new UnsupportedDialectError(replies.fingerprint, diagnostic, err.message);
  }
  log.warn(
    `${printerIdentity(replies.info)} not recognised — generic ESC/I-2 dialect, experimental, ` +
      "please report how the scan turns out, with the diagnostic block below.",
  );
  log.info(`Diagnostic block for the report:\n\n${diagnostic}`);
  return entry;
}

/**
 * Pins ctx.source for a single-source printer (fixed source detection).
 *
 * Necessary because scanner shells pre-set a transport-level default before
 * the dialect resolves. A printer whose INFO advertises one source overrides
 * that default once its replies are read.
 */
export function applyEntrySourceOverride(
  ctx: { source: "adf" | "flatbed" },
  entry: Pick<Dialect, "sourceDetection">,
): void {
  if (entry.sourceDetection === "fixed-flatbed") {
    ctx.source = "flatbed";
  } else if (entry.sourceDetection === "fixed-adf") {
    ctx.source = "adf";
  }
}

/**
 * Rejects a PARA source the hardware can't do: one the dialect has no scan
 * window for, and adf-duplex on a simplex-only ADF.
 *
 * Called from buildParaSend after the source axis resolves — NOT at entry
 * resolution. A printer with both sources doesn't know its source until the
 * init poll's first status reply, and `duplex=true` on a flatbed scan is
 * inert and must stay that way (SCAN_SIDES defaults to "duplex", so
 * flatbed-only models see it on every default host-triggered scan).
 *
 * Origin-independent: an adf-duplex PARA against a simplex-only ADF is wrong
 * whether the panel or the host asked for it.
 */
export function assertSourceSupported(entry: Dialect, source: ParaSpec["source"]): void {
  if ((source === "flatbed" ? entry.fbExtents : entry.adfExtents) === null) {
    const name = source === "flatbed" ? "flatbed" : "ADF";
    throw new Error(
      `${entry.displayName} has no ${name} scan window: the model has no ${name}, or its ` +
        `INFO reply advertises no usable ${name} scan area. Please report it with the ` +
        `diagnostic block logged when the session started.`,
    );
  }
  if (source === "adf-duplex" && !entry.adfDuplex) {
    throw new Error(
      `${entry.displayName} has no duplex ADF — refusing to compose an adf-duplex PARA ` +
        `the hardware never advertised. Set SCAN_SIDES=simplex for host-triggered scans, ` +
        `or scan 1-sided from the panel.`,
    );
  }
}

/**
 * Pure projection of a model override + source/action axes onto a ParaSpec.
 * Called at PARA-build time after the source axis has been resolved (with
 * duplex folded in by the call site).
 *
 * A generic window is sent computed at the wire DPI (acqExtents): the
 * reference window scaled, then clipped to the scan area, so no DPI lands
 * past its edge. Throws if the area leaves nothing to scan at that DPI.
 */
export function makeParaSpec(
  entry: Dialect,
  source: ParaSpec["source"],
  action: ParaSpec["action"],
  resolution?: number,
  colorMode?: ParaSpec["colorMode"],
  jpegQuality?: number,
): ParaSpec {
  const windowSource: WindowSource = source === "flatbed" ? "flatbed" : "adf";
  const geometry = (source === "flatbed" ? entry.fbExtents : entry.adfExtents)?.generic;
  let acqExtents: Extents | undefined;
  if (geometry !== undefined) {
    const dpi = resolution ?? baseDpiFor(entry.paraProfile);
    const window = genericWindowIn(geometry, windowSource, entry.paraProfile, dpi);
    if (window === null) {
      throw new Error(`${entry.displayName}: no ${windowSource} scan window at ${dpi} DPI`);
    }
    acqExtents = window;
  }
  return {
    source,
    action,
    fbExtents: entry.fbExtents,
    adfExtents: entry.adfExtents,
    gmm: entry.gmm,
    gammaClass: entry.gammaClass,
    cmxClass: entry.cmxClass,
    optionalSegments: entry.optionalSegments,
    profile: entry.paraProfile,
    resolution,
    colorMode,
    monoGammaClass: entry.monoGammaClass,
    jpegQuality,
    ...(acqExtents && { acqExtents }),
  };
}
