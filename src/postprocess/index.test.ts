import { describe, it, expect } from "vitest";
import { applyPostProcess } from "./index.js";

describe("applyPostProcess", () => {
  it("none returns the exact same buffer bytes", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]);
    const out = await applyPostProcess("none", jpeg, { jpegQuality: 90 });
    expect(out.equals(jpeg)).toBe(true);
  });
});
