import { describe, it, expect } from "vitest";
import { authorize, parseScanParams } from "./scan-trigger.js";

const DEFAULTS = { scanFormat: "pdf", scanSides: "duplex" } as const;

describe("authorize", () => {
  it("accepts a matching Bearer token", () => {
    expect(authorize("Bearer abc123", "abc123")).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(authorize(undefined, "abc123")).toBe(false);
  });

  it("rejects a wrong token of the same length", () => {
    expect(authorize("Bearer abc124", "abc123")).toBe(false);
  });

  it("rejects a wrong token of a different length", () => {
    expect(authorize("Bearer abc", "abc123")).toBe(false);
  });

  it("rejects a bare token without the Bearer scheme", () => {
    expect(authorize("abc123", "abc123")).toBe(false);
  });

  it("rejects other schemes", () => {
    expect(authorize("Basic abc123", "abc123")).toBe(false);
  });

  it("treats the scheme keyword case-insensitively, the token case-sensitively", () => {
    expect(authorize("bearer abc123", "abc123")).toBe(true);
    expect(authorize("Bearer ABC123", "abc123")).toBe(false);
  });

  it("rejects an empty configured token outright", () => {
    expect(authorize("Bearer ", "")).toBe(false);
  });
});

describe("parseScanParams", () => {
  it("applies the config defaults when no params are given", () => {
    expect(parseScanParams(new URLSearchParams(""), DEFAULTS)).toEqual({
      format: "pdf",
      sides: "duplex",
    });
  });

  it("honours format and sides overrides", () => {
    expect(parseScanParams(new URLSearchParams("format=jpg&sides=simplex"), DEFAULTS)).toEqual({
      format: "jpg",
      sides: "simplex",
    });
  });

  it("overrides one while defaulting the other", () => {
    expect(parseScanParams(new URLSearchParams("sides=simplex"), DEFAULTS)).toEqual({
      format: "pdf",
      sides: "simplex",
    });
  });

  it("rejects an unknown format", () => {
    expect(parseScanParams(new URLSearchParams("format=tiff"), DEFAULTS)).toEqual({
      error: expect.stringContaining("format"),
    });
  });

  it("rejects an unknown sides value", () => {
    expect(parseScanParams(new URLSearchParams("sides=both"), DEFAULTS)).toEqual({
      error: expect.stringContaining("sides"),
    });
  });

  it("ignores unknown query keys", () => {
    expect(parseScanParams(new URLSearchParams("foo=bar&format=jpg"), DEFAULTS)).toEqual({
      format: "jpg",
      sides: "duplex",
    });
  });

  it("does not accept an empty value as an override", () => {
    expect(parseScanParams(new URLSearchParams("format="), DEFAULTS)).toEqual({
      error: expect.stringContaining("format"),
    });
  });
});
