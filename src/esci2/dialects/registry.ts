// src/esci2/dialects/registry.ts
import type { GammaClassName, CmxClassName, Extents } from "../para-composer.js";

export interface RegistryEntry {
  displayName: string;
  sourceDetection: "stat-length" | "fixed-flatbed";
  initPollIterations: number;
  fbExtents: Extents;
  adfExtents: Extents | null;
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass: { jpg: CmxClassName | null; pdf: CmxClassName | null };
  optionalSegments: { qit: boolean; cct: boolean };
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
      gmm: "UG10",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: null, pdf: null },
      optionalSegments: { qit: true, cct: true },
    },
  ],
  [
    "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7",
    {
      displayName: "ET-2750 (ESC/I-2 over plain TCP)",
      sourceDetection: "fixed-flatbed",
      initPollIterations: 2,
      fbExtents: { x0: 0, y0: 0, w: 2477, h: 3500 },
      adfExtents: null,
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
      gmm: "UG10",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: null, pdf: null },
      optionalSegments: { qit: true, cct: true },
    },
  ],
]);
