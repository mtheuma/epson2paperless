// src/esci2/test-support/para-diff.ts
//
// Which segments differ between two PARA bodies, for tests that pin a
// deliberate change to its segments: "this PARA differs from that one only
// in #CMX" holds every other segment byte-identical, and in place, without
// restating them.

import { parseParaSegments, type ParaSegment } from "./para-parse.js";

// Each segment keyed by its code and occurrence (the third #GMT is "GMT#2"),
// so a segment added or dropped on one side doesn't shift the rest.
function keyed(segments: ParaSegment[]): Map<string, ParaSegment> {
  const seen = new Map<string, number>();
  const out = new Map<string, ParaSegment>();
  for (const segment of segments) {
    const n = seen.get(segment.code) ?? 0;
    seen.set(segment.code, n + 1);
    out.set(`${segment.code}#${n}`, segment);
  }
  return out;
}

/**
 * The codes of the segments that differ between `before` and `after`: bytes
 * changed, present on one side only, or moved relative to the segments both
 * carry. Each code is named once, in the order it first appears in `before`
 * and then `after`. Empty when the bodies are byte-identical. Throws on a
 * body that doesn't parse.
 */
export function changedParaSegments(before: Buffer, after: Buffer): string[] {
  const a = keyed(parseParaSegments(before));
  const b = keyed(parseParaSegments(after));
  const commonA = [...a.keys()].filter((key) => b.has(key));
  const commonB = [...b.keys()].filter((key) => a.has(key));
  const changed = new Set<string>();
  for (const [key, segment] of [...a, ...b]) {
    const bytesA = a.get(key)?.bytes;
    const bytesB = b.get(key)?.bytes;
    const moved = commonA.indexOf(key) !== commonB.indexOf(key);
    if (bytesA === undefined || bytesB === undefined || !bytesA.equals(bytesB) || moved) {
      changed.add(segment.code);
    }
  }
  return [...changed];
}
