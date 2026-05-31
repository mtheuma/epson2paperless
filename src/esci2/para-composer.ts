// src/esci2/para-composer.ts
import { GAMMA_CLASSES, type GammaClassName } from "./data/gamma-classes.js";
import { CMX_CLASSES, type CmxClassName } from "./data/cmx-classes.js";

export interface Extents {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface ParaSpec {
  source: "flatbed" | "adf-simplex" | "adf-duplex";
  action: "jpg" | "pdf";
  fbExtents: Extents;
  adfExtents: Extents | null;
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass: { jpg: CmxClassName | null; pdf: CmxClassName | null };
  optionalSegments: { qit: boolean; cct: boolean };
}

const FIXED_PREFIX = Buffer.from(
  "#RSMi0000300" + // bytes 0..12
    "#RSSi0000300" + // 12..24
    "#COLC024" + //    24..32
    "#FMTJPG " + //    32..40
    "#JPGd090", //     40..48
  "ascii",
);

function renderAcq(e: Extents): Buffer {
  const fmt = (n: number) => n.toString().padStart(7, "0");
  return Buffer.from(`#ACQi${fmt(e.x0)}i${fmt(e.y0)}i${fmt(e.w)}i${fmt(e.h)}`, "ascii");
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
  const checkExtents = (name: string, e: Extents | null): void => {
    if (e === null) return;
    for (const k of ["x0", "y0", "w", "h"] as const) {
      if (!Number.isInteger(e[k]) || e[k] < 0) {
        throw new Error(`composePara: ${name}.${k}=${e[k]} must be a non-negative integer`);
      }
    }
  };
  checkExtents("fbExtents", spec.fbExtents);
  checkExtents("adfExtents", spec.adfExtents);
  const gJpg = GAMMA_CLASSES[spec.gammaClass.jpg];
  const gPdf = GAMMA_CLASSES[spec.gammaClass.pdf];
  if (!gJpg) throw new Error(`composePara: unknown gammaClass.jpg=${spec.gammaClass.jpg}`);
  if (!gPdf) throw new Error(`composePara: unknown gammaClass.pdf=${spec.gammaClass.pdf}`);
  if (spec.cmxClass.jpg !== null && !CMX_CLASSES[spec.cmxClass.jpg]) {
    throw new Error(`composePara: unknown cmxClass.jpg=${spec.cmxClass.jpg}`);
  }
  if (spec.cmxClass.pdf !== null && !CMX_CLASSES[spec.cmxClass.pdf]) {
    throw new Error(`composePara: unknown cmxClass.pdf=${spec.cmxClass.pdf}`);
  }
  if (spec.gmm.length !== 4) {
    throw new Error(`composePara: gmm must be exactly 4 ASCII chars, got ${spec.gmm.length}`);
  }
}

export function composePara(spec: ParaSpec): Buffer {
  validate(spec);

  const parts: Buffer[] = [];
  // 1. Source segment.
  parts.push(renderSourceSegment(spec.source));
  // 2. Fixed constants.
  parts.push(FIXED_PREFIX);
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
  // 9. ACQ extents (fb or adf, per source).
  const acqExtents = spec.source === "flatbed" ? spec.fbExtents : spec.adfExtents!;
  parts.push(renderAcq(acqExtents));
  // 10. BSZ trailing constant.
  parts.push(Buffer.from("#BSZi1048576", "ascii"));

  return Buffer.concat(parts);
}

export type { GammaClassName, CmxClassName };
