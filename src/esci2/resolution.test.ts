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

  it("only RSMLIST present (RSSLIST absent) -> RSMLIST values are the base set", () => {
    const rsmOnly = parseCapaTokens(Buffer.from("#RSMLISTd050d075d100d150d200", "ascii"));
    expect(advertisedDpiSet(rsmOnly, "flatbed")).toEqual([50, 75, 100, 150, 200]);
  });

  it("only RSSLIST present (RSMLIST absent) -> RSSLIST values are the base set", () => {
    const rssOnly = parseCapaTokens(Buffer.from("#RSSLISTd050d075d100d150d200", "ascii"));
    expect(advertisedDpiSet(rssOnly, "flatbed")).toEqual([50, 75, 100, 150, 200]);
  });

  it("only-one-global-list branch copies rather than aliases — does not mutate CapaTokens' own array", () => {
    // Unsorted input so the function's internal sort (Array#sort mutates
    // in place) would visibly reorder an alias of capa.rsmList if the
    // implementation didn't copy first.
    const rsmOnly = parseCapaTokens(Buffer.from("#RSMLISTd200d050d100", "ascii"));
    expect(advertisedDpiSet(rsmOnly, "flatbed")).toEqual([50, 100, 200]);
    expect(rsmOnly.rsmList).toEqual([200, 50, 100]);
  });

  it("a single present global list is still capped by the source list's max", () => {
    const rsmOnly = parseCapaTokens(
      Buffer.from("#RSMLISTd050d075d100d150d200d300d600d800#ADFRSMSLISTd300d600", "ascii"),
    );
    // Cap = max(ADFRSMSLIST) = 600, so the 800 above it is dropped even
    // though it appears in RSMLIST.
    expect(advertisedDpiSet(rsmOnly, "adf-simplex")).toEqual([50, 75, 100, 150, 200, 300, 600]);
  });

  describe("selectWireDpi contract", () => {
    it("throws on an empty advertised set — caller must supply [pinnedDefault]", () => {
      expect(() => selectWireDpi(300, [])).toThrow(/non-empty/);
    });
  });
});
