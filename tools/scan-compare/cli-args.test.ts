import { describe, it, expect } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("parseCliArgs", () => {
  it("collects files with no flags", () => {
    expect(parseCliArgs(["a.pdf", "b.jpg"])).toEqual({
      files: ["a.pdf", "b.jpg"],
      withDocument: false,
      toneCurve: undefined,
    });
  });

  it("recognises --document", () => {
    expect(parseCliArgs(["--document", "a.pdf"])).toEqual({
      files: ["a.pdf"],
      withDocument: true,
      toneCurve: undefined,
    });
  });

  it("--tone-curve takes a known curve name and implies --document", () => {
    expect(parseCliArgs(["--tone-curve", "et4950-family", "a.pdf"])).toEqual({
      files: ["a.pdf"],
      withDocument: true,
      toneCurve: "et4950-family",
    });
  });

  it("rejects an unknown tone-curve name, listing the valid ones", () => {
    expect(() => parseCliArgs(["--tone-curve", "nope", "a.pdf"])).toThrow(/et4950-family/);
  });

  it("rejects --tone-curve with no value", () => {
    expect(() => parseCliArgs(["a.pdf", "--tone-curve"])).toThrow(/--tone-curve/);
  });

  it("rejects an unrecognised flag instead of silently ignoring it", () => {
    expect(() => parseCliArgs(["--tonecurve", "a.pdf"])).toThrow(/--tonecurve/);
  });
});
