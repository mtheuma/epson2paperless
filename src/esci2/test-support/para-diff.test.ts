import { describe, it, expect } from "vitest";
import { changedParaSegments } from "./para-diff.js";

const body = (text: string) => Buffer.from(text, "latin1");

describe("changedParaSegments", () => {
  it("is empty for identical bodies", () => {
    const para = body("#GMMUG18#RSMi0000300#QITOFF ");
    expect(changedParaSegments(para, Buffer.from(para))).toEqual([]);
  });

  it("names the one segment whose values differ", () => {
    expect(changedParaSegments(body("#GMMUG18#RSMi0000300"), body("#GMMUG18#RSMi0000600"))).toEqual(
      ["RSM"],
    );
  });

  it("names a segment whose data bytes differ, even at the same length", () => {
    const before = Buffer.concat([
      body("#CMXUM08h003"),
      Buffer.from([1, 2, 3, 0]),
      body("#GMMUG18"),
    ]);
    const after = Buffer.concat([
      body("#CMXUM08h003"),
      Buffer.from([1, 9, 3, 0]),
      body("#GMMUG18"),
    ]);
    expect(changedParaSegments(before, after)).toEqual(["CMX"]);
  });

  it("names a repeated segment once, in body order", () => {
    expect(
      changedParaSegments(
        body("#GMTRED h001A   #GMTGRN h001A   #CMXUM08"),
        body("#GMTRED h001B   #GMTGRN h001B   #CMXUM08"),
      ),
    ).toEqual(["GMT"]);
  });

  it("names a segment present on one side only", () => {
    expect(changedParaSegments(body("#GMMUG18"), body("#GMMUG18#QITOFF "))).toEqual(["QIT"]);
    expect(changedParaSegments(body("#GMMUG18#QITOFF "), body("#GMMUG18"))).toEqual(["QIT"]);
  });

  it("names a segment whose bytes differ but whose values read the same", () => {
    // The same number in another encoding, and the same data with other padding.
    expect(changedParaSegments(body("#RSMi0000300"), body("#RSMd300"))).toEqual(["RSM"]);
    expect(changedParaSegments(body("#CMXh001A   "), body("#CMXh001A\0\0\0"))).toEqual(["CMX"]);
  });

  it("names the segments that moved", () => {
    expect(
      changedParaSegments(body("#GMMUG18#QITOFF #RSMd300"), body("#QITOFF #GMMUG18#RSMd300")),
    ).toEqual(["GMM", "QIT"]);
  });
});
