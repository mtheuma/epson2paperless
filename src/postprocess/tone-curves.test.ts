import { describe, it, expect } from "vitest";
import { TONE_CURVES } from "./tone-curves.js";

// Structural invariants every pinned tone curve must hold, regardless of the
// capture it was transcribed from. Issue #158: the et4950-family curve's top
// end was interpolated from swatches nowhere near white, so post-clip 255
// paper landed at 253/255/255 (never pure white on R) and 254 dropped to ~241
// — a visible step. These invariants pin the fix and stop a future re-derive
// from reintroducing it.

const TOP_REGION_START = 240;
/** Largest allowed jump between adjacent entries in the near-white region. */
const MAX_TOP_STEP = 3;

const CHANNELS = [
  ["R", 0],
  ["G", 1],
  ["B", 2],
] as const;

describe.each(Object.entries(TONE_CURVES))("tone curve %s", (_name, curve) => {
  it.each(CHANNELS)("channel %s has 256 entries", (_ch, c) => {
    expect(curve[c].length).toBe(256);
  });

  it.each(CHANNELS)("channel %s is monotonic non-decreasing", (ch, c) => {
    for (let i = 1; i < 256; i++) {
      expect(curve[c][i], `${ch}[${i}] < ${ch}[${i - 1}]`).toBeGreaterThanOrEqual(curve[c][i - 1]);
    }
  });

  it.each(CHANNELS)("channel %s maps input 255 to pure white (255)", (_ch, c) => {
    expect(curve[c][255]).toBe(255);
  });

  it.each(CHANNELS)(
    `channel %s has no step larger than ${MAX_TOP_STEP} above input ${TOP_REGION_START}`,
    (ch, c) => {
      for (let i = TOP_REGION_START + 1; i < 256; i++) {
        const step = curve[c][i] - curve[c][i - 1];
        expect(
          step,
          `${ch}[${i - 1}]=${curve[c][i - 1]} -> ${ch}[${i}]=${curve[c][i]}`,
        ).toBeLessThanOrEqual(MAX_TOP_STEP);
      }
    },
  );
});
