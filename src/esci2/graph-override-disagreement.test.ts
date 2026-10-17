import { describe, it, expect, vi } from "vitest";
import { esci2Graph, type Esci2Ctx } from "./graph.js";
import type { ModelOverride } from "./dialects/model-overrides.js";
import { readInit1Bodies } from "./test-support/capability-bodies.js";
import { DEFAULT_JPEG_QUALITY } from "../config.js";

// The ET-4950 fixture's CAPA, resolved against a copy of the overrides whose entry for
// it is doctored to disagree with INFO on its sources (no flatbed window).
// The mock is scoped to this file, so no other test sees the doctored entry.
const ET4950 = readInit1Bodies(
  "tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl",
);

vi.mock("./dialects/model-overrides.js", async (importOriginal) => {
  // vi.mock is hoisted above the imports, so the factory loads what it needs.
  const real = await importOriginal<typeof import("./dialects/model-overrides.js")>();
  const { readInit1Bodies } = await import("./test-support/capability-bodies.js");
  const { computeCapaFingerprint } = await import("./capa-fingerprint.js");
  const fp = computeCapaFingerprint(
    readInit1Bodies("tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl").capa,
  );
  const original = real.OVERRIDES_BY_FINGERPRINT.get(fp)!;
  const doctored: ModelOverride = {
    ...original,
    fbExtents: null,
  };
  // The session lookup reads MODEL_OVERRIDES alone, so that is all to doctor.
  return {
    ...real,
    MODEL_OVERRIDES: real.MODEL_OVERRIDES.map((e) => (e === original ? doctored : e)),
  };
});

describe("esci2Graph INIT1_CAPA_DATA — no runtime comparison with the override", () => {
  it("an override that disagrees with INFO on its sources logs nothing at info", () => {
    const state = esci2Graph.states.INIT1_CAPA_DATA;
    if (state.kind !== "decision") throw new Error("INIT1_CAPA_DATA not a decision");
    const ctx = {
      duplex: false,
      source: "adf",
      transport: "tls",
      action: "jpg",
      resolution: undefined,
      colorMode: "color",
      initPollIteration: 0,
      genericDialect: false,
      imgChunkSize: 0,
      pageEndKind: "none",
      pageSide: "front",
      zeroImgRetries: 0,
      imageChunks: [],
      tprDeclaredLength: ET4950.capa.length,
      infoBody: ET4950.info,
      capaBody: Buffer.alloc(0),
      capaTokens: undefined,
      entry: undefined,
      jpegQuality: DEFAULT_JPEG_QUALITY,
      wireDpi: undefined,
      downsampleToDpi: undefined,
    } satisfies Esci2Ctx;
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = state.decide(ctx, { type: 0xa000, payload: ET4950.capa });
      expect("error" in result).toBe(false);
      const { entry } = ctx as Esci2Ctx;
      expect(entry?.fbExtents).toBeNull();
      // Detection follows INFO, which advertises both sources.
      expect(entry?.sourceDetection).toBe("pre-para-status");
      expect(infoSpy.mock.calls).toEqual([]);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
