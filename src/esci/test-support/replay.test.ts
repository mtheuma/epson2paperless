import { describe, it, expect } from "vitest";
import { __test__synthesiseImageStream as synth } from "./replay.js";

describe("synthesiseImageStream", () => {
  it("handles a 253,063-byte chunk (XP-620)", () => {
    const chunks = [...synth(253063 * 2 + 37216, 253063)];
    expect(chunks).toHaveLength(3);
    // each IS-0xa200 packet = 12 header + payload
    expect(chunks[0].length).toBe(12 + 253063);
    expect(chunks[2].length).toBe(12 + 37216);
  });
});
