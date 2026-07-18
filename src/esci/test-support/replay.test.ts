import { describe, it, expect } from "vitest";
import { __test__synthesiseImageStream as synth, concatHostBytes } from "./replay.js";

describe("synthesiseImageStream", () => {
  it("handles a 253,063-byte chunk (XP-620)", () => {
    const chunks = [...synth(253063 * 2 + 37216, 253063)];
    expect(chunks).toHaveLength(3);
    // each IS-0xa200 packet = 12 header + payload
    expect(chunks[0].length).toBe(12 + 253063);
    expect(chunks[2].length).toBe(12 + 37216);
  });
});

it("concatHostBytes joins only h>p events in order", () => {
  const fx = [
    { dir: "h>p", ts: 0, hex: "1b40" },
    { dir: "p>h", ts: 0, hex: "06" },
    { dir: "h>p", ts: 1, hex: "1c46" },
  ] as const;
  expect(concatHostBytes(fx as never).toString("hex")).toBe("1b401c46");
});
