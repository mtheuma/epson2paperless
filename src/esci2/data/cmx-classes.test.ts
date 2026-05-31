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

  it("class names enumerate", () => {
    const _names: CmxClassName[] = ["et2750-um08", "xp7100-jpg", "xp7100-pdf"];
    expect(_names).toHaveLength(3);
  });
});
