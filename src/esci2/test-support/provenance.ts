// src/esci2/test-support/provenance.ts
//
// The provenance checks over the model overrides and the README compatibility
// table. Provenance has no runtime effect; this is the only code that reads it.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { GAMMA_CLASSES, type GammaClassName } from "../data/gamma-classes.js";
import { CMX_CLASSES, type CmxClassName } from "../data/cmx-classes.js";
import type { Evidence, EvidenceKind, ModelOverride } from "../dialects/model-overrides.js";
import { WF3620_ENTRY } from "../../esci/dialects/wf3620.js";
import { XP620_ENTRY } from "../../esci/dialects/xp620.js";
import { ET2550_ENTRY } from "../../esci/dialects/et2550.js";

type ColourSettings = Pick<ModelOverride, "gmm" | "gammaClass" | "cmxClass" | "monoGammaClass">;

/**
 * A short hash of the colour bytes an override sends: its gamma mode, the
 * JPG and PDF tone curves and colour matrices, and its mono tone curve. It
 * hashes bytes, not class names, so renaming a class keeps its evidence;
 * changing a byte does not. A colour evidence entry records the hash of the
 * settings it vouched for.
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

/** Kinds that can vouch for colour: a capture or report of the colours themselves. */
const COLOUR_KINDS: ReadonlySet<EvidenceKind> = new Set([
  "epson-capture",
  "reporter-scan",
  "reporter-report",
]);

const LEGACY_MODELS = [WF3620_ENTRY, XP620_ENTRY, ET2550_ENTRY].map((e) => e.name);

/** The README compatibility rows marked ✅, one model name per entry ("A / B" splits). */
export function verifiedReadmeModels(readme: string): string[] {
  const models: string[] = [];
  for (const line of readme.split(/\r?\n/)) {
    const row = /^\|\s*\*\*(.+?)\*\*\s*\|\s*✅/.exec(line);
    if (row) models.push(...row[1].split("/").map((m) => m.trim()));
  }
  return models;
}

const isLegacy = (model: string): boolean =>
  (LEGACY_MODELS as readonly string[]).includes(model.replace("-", "").toLowerCase());

const isInherited = (e: Evidence): boolean => e.kind.startsWith("inherited:");

/**
 * Every way the overrides' provenance falls short, as one line each; empty
 * when it all holds:
 *
 * - every ✅ ESC/I-2 model in the README is served by exactly one override:
 *   recorded from it, or a sibling sharing it with a report of its own.
 *   `unplaced` lists ✅ models known to reach some override whose override
 *   isn't recorded, each with its report;
 * - a ✅ model's override has colour evidence, other than an own capture or
 *   an inherited setting, that vouched for its current colour bytes;
 * - its window and poll-count evidence isn't inherited only;
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
    const owners = overrides.filter(
      (o) =>
        o.provenance.models.includes(model) || Object.hasOwn(o.provenance.siblings ?? {}, model),
    );
    if (owners.length === 0) {
      if ((unplaced[model]?.length ?? 0) === 0) {
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
    if (reports !== undefined && reports.length === 0) {
      problems.push(
        `${model}: shares the ${owner.displayName} override but has no report of its own`,
      );
    }
  }

  for (const o of overrides) {
    const { colour, window, pollCount, siblings } = o.provenance;
    const groups = { colour, window, pollCount, ...siblings };
    for (const [group, evidence] of Object.entries(groups)) {
      for (const e of evidence) {
        if ("fixture" in e.link && !existsSync(e.link.fixture)) {
          problems.push(
            `${o.displayName}: ${group} links a fixture that doesn't exist (${e.link.fixture})`,
          );
        }
        if (isInherited(e)) {
          const from = e.kind.slice("inherited:".length);
          if (!recorded.has(from)) {
            problems.push(
              `${o.displayName}: ${group} is inherited from ${from}, which no override records`,
            );
          }
        }
      }
    }
    if (!verified.has(o)) continue;
    const hash = colourSettingsHash(o);
    if (!colour.some((e) => COLOUR_KINDS.has(e.kind) && e.vouchesFor === hash)) {
      problems.push(
        `${o.displayName}: no colour evidence vouches for its current colour settings (${hash})`,
      );
    }
    for (const [group, evidence] of Object.entries({ window, pollCount })) {
      if (!evidence.some((e) => !isInherited(e))) {
        problems.push(`${o.displayName}: its ${group} evidence is inherited only`);
      }
    }
  }
  return problems;
}
