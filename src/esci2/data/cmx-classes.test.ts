import { describe, it, expect } from "vitest";
import { CMX_CLASSES, type CmxClassName } from "./cmx-classes.js";

describe("cmx-classes", () => {
  it("exposes et2750-um08 as a 24-byte segment", () => {
    expect(CMX_CLASSES["et2750-um08"].length).toBe(24);
  });

  it("et2750-um08 starts with #CMXUM08h009 ASCII", () => {
    expect(CMX_CLASSES["et2750-um08"].subarray(0, 12).toString("ascii")).toBe("#CMXUM08h009");
  });

  it("xp7100-jpg is 24 bytes and differs from et2750", () => {
    expect(CMX_CLASSES["xp7100-jpg"].length).toBe(24);
    expect(CMX_CLASSES["xp7100-jpg"].equals(CMX_CLASSES["et2750-um08"])).toBe(false);
  });

  it("xp7100-jpg and xp7100-pdf differ", () => {
    expect(CMX_CLASSES["xp7100-jpg"].equals(CMX_CLASSES["xp7100-pdf"])).toBe(false);
  });

  it("exposes et4800-um08 as a 24-byte segment", () => {
    expect(CMX_CLASSES["et4800-um08"].length).toBe(24);
  });

  it("et4800-um08 shares the #CMXUM08h009 header but differs in the payload tail", () => {
    const et4800 = CMX_CLASSES["et4800-um08"];
    const et2750 = CMX_CLASSES["et2750-um08"];
    // First 12 bytes are the #CMXUM08h009 header — shared across UM08 printers.
    expect(et4800.subarray(0, 12).toString("ascii")).toBe("#CMXUM08h009");
    expect(et4800.subarray(0, 12).equals(et2750.subarray(0, 12))).toBe(true);
    // Last 12 bytes are the payload — distinct per printer.
    expect(et4800.subarray(12, 24).equals(et2750.subarray(12, 24))).toBe(false);
    expect(et4800.subarray(12, 24).equals(CMX_CLASSES["xp7100-jpg"].subarray(12, 24))).toBe(false);
  });

  it("class names enumerate", () => {
    const _names: CmxClassName[] = ["et2750-um08", "xp7100-jpg", "xp7100-pdf", "et4800-um08"];
    expect(_names).toHaveLength(4);
  });
});
