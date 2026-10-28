// src/esci2/test-support/provenance.ts
//
// The provenance checks over the model overrides and the README compatibility
// table. Provenance has no runtime effect; this is the only code that reads it.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { GAMMA_CLASSES, type GammaClassName } from "../data/gamma-classes.js";
import { CMX_CLASSES, type CmxClassName } from "../data/cmx-classes.js";
import type { Evidence, EvidenceKind, ModelOverride } from "../dialects/model-overrides.js";
import { LEGACY_DIALECT_ENTRIES } from "../../esci/dialects/registry.js";

type ColourSettings = Pick<ModelOverride, "gmm" | "gammaClass" | "cmxClass" | "monoGammaClass">;

/**
 * A short hash of the colour bytes an override sends: its gamma mode, the
 * JPG and PDF tone curves and colour matrices, and its greyscale tone curve. It
 * hashes bytes, not class names, so renaming a class keeps its evidence;
 * changing a byte does not. A colour evidence entry records the hash of the
 * override's settings when it was recorded. The host-side `toneCurve` is not
 * sent to the printer, so it isn't part of it.
 */
export function colourSettingsHash(settings: ColourSettings): string {
  const hash = createHash("sha256");
  const add = (label: string, bytes: Buffer | null): void => {
    hash.update(`${label}=${bytes === null ? "none" : bytes.toString("hex")};`);
  };
  const gamma = (name: GammaClassName | undefined): Buffer | null =>
    name === undefined ? null : GAMMA_CLASSES[name];
  const cmx = (name: CmxClassName | null): Buffer | null =>
    name === null ? null : CMX_CLASSES[name];
  hash.update(`gmm=${settings.gmm};`);
  add("gamma.jpg", gamma(settings.gammaClass.jpg));
  add("gamma.pdf", gamma(settings.gammaClass.pdf));
  add("cmx.jpg", cmx(settings.cmxClass.jpg));
  add("cmx.pdf", cmx(settings.cmxClass.pdf));
  add("gamma.mono", gamma(settings.monoGammaClass));
  return hash.digest("hex").slice(0, 16);
}

/**
 * Kinds that can vouch for colour: a capture or report of the colours
 * themselves, or provisional evidence for an inherited setting.
 */
const COLOUR_KINDS: ReadonlySet<EvidenceKind> = new Set([
  "epson-capture",
  "reporter-scan",
  "reporter-report",
  "provisional",
]);

/** The README Notes caveat a model on the provisional list carries, and no other model. */
export const PROVISIONAL_CAVEAT = "colours not yet confirmed on hardware";

// Legacy dialect names are model names without the hyphen ("wf3620").
const LEGACY_MODELS = LEGACY_DIALECT_ENTRIES.map((e) => e.name);

/** The README compatibility rows marked ✅, one model name per entry ("A / B" splits). */
export function verifiedReadmeModels(readme: string): string[] {
  return [...verifiedReadmeNotes(readme).keys()];
}

/** Each ✅ README model's Notes cell, in table order. */
function verifiedReadmeNotes(readme: string): Map<string, string> {
  const notes = new Map<string, string>();
  for (const line of readme.split(/\r?\n/)) {
    const row = /^\|\s*\*\*(.+?)\*\*\s*\|\s*✅[^|]*\|([^|]*)\|/.exec(line);
    if (row) for (const m of row[1].split("/")) notes.set(m.trim(), row[2].trim());
  }
  return notes;
}

const isLegacy = (model: string): boolean =>
  (LEGACY_MODELS as readonly string[]).includes(model.replace("-", "").toLowerCase());

const isInherited = (e: Evidence): boolean => e.kind.startsWith("inherited:");

/** Evidence from the model itself: neither an inheritance nor provisional evidence for one. */
const isOwn = (e: Evidence): boolean => !isInherited(e) && e.kind !== "provisional";

/** The overrides serving a model: recorded from it, or sharing it as a sibling. */
const servedBy = (model: string, overrides: readonly ModelOverride[]): ModelOverride[] =>
  overrides.filter(
    (o) => o.provenance.models.includes(model) || Object.hasOwn(o.provenance.siblings ?? {}, model),
  );

/**
 * What an override's current colour bytes rest on: evidence that confirms
 * them, provisional evidence only, or nothing that vouched for them.
 */
function colourStanding(o: ModelOverride): "confirmed" | "provisional" | "none" {
  const hash = colourSettingsHash(o);
  const vouching = o.provenance.colour.filter(
    (e) => COLOUR_KINDS.has(e.kind) && e.vouchesFor === hash,
  );
  if (vouching.length === 0) return "none";
  return vouching.every((e) => e.kind === "provisional") ? "provisional" : "confirmed";
}

/**
 * The ✅ README models whose current colour bytes rest only on provisional
 * evidence, in table order. Each carries PROVISIONAL_CAVEAT in its Notes.
 */
export function provisionalColourModels(
  readme: string,
  overrides: readonly ModelOverride[],
): string[] {
  return verifiedReadmeModels(readme).filter((model) => {
    const owners = servedBy(model, overrides);
    return owners.length === 1 && colourStanding(owners[0]) === "provisional";
  });
}

/**
 * Every way the overrides' provenance falls short, as one line each; empty
 * when it all holds:
 *
 * - every ✅ ESC/I-2 model in the README is served by exactly one override:
 *   recorded from it, or a sibling sharing it with a report of its own (any
 *   kind but an inheritance or provisional evidence). `unplaced` lists ✅
 *   models known to reach some override whose override isn't recorded, each
 *   with such a report;
 * - a ✅ model's override has colour evidence, other than an own capture or
 *   an inherited setting, that vouched for its current colour bytes;
 * - its window and poll-count evidence isn't inherited only;
 * - exactly the ✅ models on the provisional list (provisionalColourModels)
 *   carry PROVISIONAL_CAVEAT in their README Notes;
 * - provisional evidence is colour evidence only, sits next to an inherited
 *   setting vouching for the same bytes, and links a fixture;
 * - every fixture link exists, and every inheritance names a model some
 *   override records (never anything else).
 */
export function provenanceProblems(
  readme: string,
  overrides: readonly ModelOverride[],
  unplaced: Readonly<Record<string, readonly Evidence[]>>,
): string[] {
  const problems: string[] = [];
  const recorded = new Set(overrides.flatMap((o) => o.provenance.models));
  const verified = new Set<ModelOverride>();

  for (const model of verifiedReadmeModels(readme)) {
    if (isLegacy(model)) continue;
    const owners = servedBy(model, overrides);
    if (owners.length === 0) {
      if (!hasOwnReport(unplaced[model])) {
        problems.push(`${model}: ✅ in the README, but no model override serves it`);
      }
      continue;
    }
    if (owners.length > 1) {
      problems.push(`${model}: served by ${owners.map((o) => o.displayName).join(" and ")}`);
      continue;
    }
    const [owner] = owners;
    verified.add(owner);
    const reports = owner.provenance.siblings?.[model];
    if (reports !== undefined && !hasOwnReport(reports)) {
      problems.push(
        `${model}: shares the ${owner.displayName} override but has no report of its own`,
      );
    }
  }

  // The caveat marks exactly the ESC/I-2 models on the provisional list.
  const provisional = new Set(provisionalColourModels(readme, overrides));
  for (const [model, notes] of verifiedReadmeNotes(readme)) {
    if (isLegacy(model)) continue;
    const caveat = notes.toLowerCase().includes(PROVISIONAL_CAVEAT);
    if (provisional.has(model) && !caveat) {
      problems.push(
        `${model}: its colour rests only on provisional evidence, but its README Notes lack "${PROVISIONAL_CAVEAT}"`,
      );
    } else if (!provisional.has(model) && caveat) {
      problems.push(
        `${model}: its README Notes say "${PROVISIONAL_CAVEAT}", but its colour isn't provisional`,
      );
    }
  }

  const provisionalOutsideColour = (where: string, evidence: readonly Evidence[]): void => {
    if (evidence.some((e) => e.kind === "provisional")) {
      problems.push(`${where} carries provisional evidence, which is for colour only`);
    }
  };

  // Every link, whether or not its model is ✅.
  const linkProblems = (where: string, evidence: readonly Evidence[]): void => {
    for (const e of evidence) {
      if ("fixture" in e.link && !existsSync(e.link.fixture)) {
        problems.push(`${where} links a fixture that doesn't exist (${e.link.fixture})`);
      }
      if (isInherited(e)) {
        const from = e.kind.slice("inherited:".length);
        if (!recorded.has(from)) {
          problems.push(`${where} is inherited from ${from}, which no override records`);
        }
      }
    }
  };

  for (const o of overrides) {
    const { colour, window, pollCount, siblings } = o.provenance;
    linkProblems(`${o.displayName}: colour`, colour);
    for (const [group, evidence] of Object.entries({ window, pollCount, ...siblings })) {
      linkProblems(`${o.displayName}: ${group}`, evidence);
      provisionalOutsideColour(`${o.displayName}: ${group}`, evidence);
    }
    // Provisional evidence stands for an inherited setting of the same
    // bytes, and links the capture those bytes came from.
    for (const e of colour.filter((c) => c.kind === "provisional")) {
      if (!colour.some((c) => isInherited(c) && c.vouchesFor === e.vouchesFor)) {
        problems.push(
          `${o.displayName}: its provisional colour evidence sits next to no inherited setting`,
        );
      }
      if (!("fixture" in e.link)) {
        problems.push(
          `${o.displayName}: its provisional colour evidence links no capture (a fixture)`,
        );
      }
    }
    if (!verified.has(o)) continue;
    if (colourStanding(o) === "none") {
      problems.push(
        `${o.displayName}: no colour evidence vouches for its current colour settings (${colourSettingsHash(o)})`,
      );
    }
    for (const [group, evidence] of Object.entries({ window, pollCount })) {
      if (!evidence.some(isOwn)) {
        problems.push(`${o.displayName}: its ${group} evidence is inherited only`);
      }
    }
  }
  for (const [model, reports] of Object.entries(unplaced)) {
    linkProblems(`${model}: its report`, reports);
    provisionalOutsideColour(`${model}: its report`, reports);
  }
  return problems;
}

/** Whether a model has evidence of its own: anything but an inheritance or provisional evidence. */
const hasOwnReport = (evidence: readonly Evidence[] | undefined): boolean =>
  (evidence ?? []).some(isOwn);
