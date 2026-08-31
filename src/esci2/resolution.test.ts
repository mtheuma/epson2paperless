import { describe, expect, it } from "vitest";
import { parseCapaTokens } from "./capabilities.js";
import { advertisedDpiSet, selectWireDpi } from "./resolution.js";

describe("resolution", () => {
  const et4950 = parseCapaTokens(
    Buffer.from(
      "#ADFRSMSLISTd075d150d200d300d600" +
        "#FB RSMSLISTd075d150d200d300d600i0001200" +
        "#RSMLISTd050d075d100d150d200d300d600i0001200" +
        "#RSSLISTd050d075d100d150d200d300d600i0001200i0002400",
      "ascii",
    ),
  );
  const ff680w = parseCapaTokens(
    Buffer.from(
      "#ADFRSMSLISTd300d600" +
        "#RSMLISTd050d075d100d150d200d240d300d360d400d600" +
        "#RSSLISTd050d075d100d150d200d240d300d360d400d600",
      "ascii",
    ),
  );

  it("caps the global set at the source list's max (ET-4950 ADF <= 600, flatbed <= 1200)", () => {
    expect(advertisedDpiSet(et4950, "adf-simplex")).toEqual([50, 75, 100, 150, 200, 300, 600]);
    expect(advertisedDpiSet(et4950, "flatbed")).toEqual([50, 75, 100, 150, 200, 300, 600, 1200]);
  });

  it("treats the source list as a cap, NOT an allowed-set (FF-680W/200 counterexample)", () => {
    // #ADFRSMSLISTd300d600 alone would forbid the capture-proven 200-DPI scan.
    expect(advertisedDpiSet(ff680w, "adf-simplex")).toContain(200);
    expect(selectWireDpi(200, advertisedDpiSet(ff680w, "adf-simplex"))).toEqual({ wireDpi: 200 });
  });

  it("DS-575W/400 counterexample: 400 stays a direct wire DPI", () => {
    expect(selectWireDpi(400, advertisedDpiSet(ff680w, "adf-duplex"))).toEqual({ wireDpi: 400 });
  });

  it("exact match wins; non-advertised target scans at smallest-above and downsamples", () => {
    const s = advertisedDpiSet(et4950, "flatbed");
    expect(selectWireDpi(300, s)).toEqual({ wireDpi: 300 });
    expect(selectWireDpi(240, s)).toEqual({ wireDpi: 300, downsampleToDpi: 240 });
  });

  it("target above max delivers max with cappedFrom, no downsample", () => {
    expect(selectWireDpi(1200, advertisedDpiSet(et4950, "adf-simplex"))).toEqual({
      wireDpi: 600,
      cappedFrom: 1200,
    });
  });

  it("globals absent -> source list alone; nothing advertised -> empty set", () => {
    const srcOnly = parseCapaTokens(Buffer.from("#ADFRSMSLISTd300d600", "ascii"));
    expect(advertisedDpiSet(srcOnly, "adf-simplex")).toEqual([300, 600]);
    const none = parseCapaTokens(Buffer.from("#GMMLISTUG10", "ascii"));
    expect(advertisedDpiSet(none, "flatbed")).toEqual([]);
  });
});
