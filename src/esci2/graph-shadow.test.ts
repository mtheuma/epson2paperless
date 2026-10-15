import { describe, it, expect, vi } from "vitest";
import { esci2Graph, type Esci2Ctx } from "./graph.js";
import type { RegistryEntry } from "./dialects/registry.js";
import { readInit1Bodies } from "./test-support/capability-bodies.js";
import { DEFAULT_JPEG_QUALITY } from "../config.js";

// The ET-4950 fixture's CAPA, resolved against a registry copy whose entry for
// it is doctored to disagree on two fields. The mock is scoped to this file,
// so no other test sees the doctored entry.
const ET4950 = readInit1Bodies(
  "tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl",
);

vi.mock("./dialects/registry.js", async (importOriginal) => {
  // vi.mock is hoisted above the imports, so the factory loads what it needs.
  const real = await importOriginal<typeof import("./dialects/registry.js")>();
  const { readInit1Bodies } = await import("./test-support/capability-bodies.js");
  const { computeCapaFingerprint } = await import("./capa-fingerprint.js");
  const fp = computeCapaFingerprint(
    readInit1Bodies("tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl").capa,
  );
  const doctored = new Map<string, RegistryEntry>(real.REGISTRY);
  doctored.set(fp, {
    ...real.REGISTRY.get(fp)!,
    adfDuplex: false,
    optionalSegments: { qit: false, cct: true },
  });
  return { ...real, REGISTRY: doctored };
});

describe("esci2Graph INIT1_CAPA_DATA — shadow derivation disagreement", () => {
  it("logs one info line per disagreeing field once the dialect resolves", () => {
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
      const shadow = infoSpy.mock.calls.filter((args) =>
        args.some((a) =>
          String(a).includes("Capability derivation disagrees with the dialect entry"),
        ),
      );
      expect(shadow).toHaveLength(2);
      expect(shadow[0][2]).toEqual(
        expect.objectContaining({ field: "qit", derived: true, entry: false }),
      );
      expect(shadow[1][2]).toEqual(
        expect.objectContaining({ field: "adfDuplex", derived: true, entry: false }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});
