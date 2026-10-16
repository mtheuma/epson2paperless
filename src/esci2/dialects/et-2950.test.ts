import { describe, it, expect } from "vitest";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";
import { recordedDialect } from "../test-support/dialects.js";

const ET2950_FP = "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb";
const entry = recordedDialect(ET2950_FP);

describe("ET-2950 registry entry", () => {
  it("is flatbed-only", () => {
    expect(entry.adfExtents).toBeNull();
  });
  it("reuses ET-4950's gamma class (no et2950-specific bytes)", () => {
    expect(entry.gammaClass).toEqual({ jpg: "et4950-stock", pdf: "et4950-stock" });
  });
  it("composed flatbed PARA equals ET-4950 family flatbed PARA in bytes, given the same #CCT", () => {
    const et4950 = recordedDialect(
      "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
    );
    // Its diagnostic block predates the CCT line, so whether it sends #CCT
    // follows its own CAPA reply at run time. With the ET-4950's, it matches.
    const sameCct = { ...entry, optionalSegments: et4950.optionalSegments };
    const et2950Body = composePara(makeParaSpec(sameCct, "flatbed", "jpg"));
    const et4950Body = composePara(makeParaSpec(et4950, "flatbed", "jpg"));
    expect(et2950Body.equals(et4950Body)).toBe(true);
  });
});
