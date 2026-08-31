import { describe, it, expect } from "vitest";
import { TONE_CURVES } from "./tone-curves.js";

// Structural invariants every pinned tone curve must hold, regardless of the
// capture it was transcribed from. Issue #158: the et4950-family curve's top
// end was interpolated from swatches nowhere near white, so post-clip 255
// paper landed at 253/255/255 (never pure white on R) and 254 dropped to ~241
// — a visible step. These invariants pin the fix and stop a future re-derive
// from reintroducing it.

/** Largest allowed jump between adjacent entries in the near-white region. */
const TOP_REGION_START = 240;
const MAX_TOP_STEP = 3;

const CHANNELS = ["R", "G", "B"] as const;

describe.each(Object.entries(TONE_CURVES))("tone curve %s", (_name, curve) => {
  it.each([0, 1, 2])("channel %i has 256 entries", (c) => {
    expect(curve[c].length).toBe(256);
  });

  it.each([0, 1, 2])(`channel %i (${CHANNELS.join("/")}) is monotonic non-decreasing`, (c) => {
    for (let i = 1; i < 256; i++) {
      expect(curve[c][i], `${CHANNELS[c]}[${i}] < ${CHANNELS[c]}[${i - 1}]`).toBeGreaterThanOrEqual(
        curve[c][i - 1],
      );
    }
  });

  it.each([0, 1, 2])("channel %i maps input 255 to pure white (255)", (c) => {
    expect(curve[c][255]).toBe(255);
  });

  it.each([0, 1, 2])(
    `channel %i has no step larger than ${MAX_TOP_STEP} above input ${TOP_REGION_START}`,
    (c) => {
      for (let i = TOP_REGION_START + 1; i < 256; i++) {
        const step = curve[c][i] - curve[c][i - 1];
        expect(
          step,
          `${CHANNELS[c]}[${i - 1}]=${curve[c][i - 1]} -> ${CHANNELS[c]}[${i}]=${curve[c][i]}`,
        ).toBeLessThanOrEqual(MAX_TOP_STEP);
      }
    },
  );
});
