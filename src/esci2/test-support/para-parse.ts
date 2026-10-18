// src/esci2/test-support/para-parse.ts
//
// Re-parses a composed PARA body into its segments, for tests that check a
// PARA is well-formed without pinning its bytes. A segment is `#`, a
// three-character code, then values until the next segment: `d` + 3 digits,
// `i` + 7 digits, `h` + 3 hex digits + that many data bytes (padded to a
// multiple of four), or a four-character literal ("UG18", "CRP ", "DPLX").
// Data bytes are skipped by length, so a gamma LUT holding 0x23 can't be
// mistaken for a segment start.

export type ParaValue = number | string | Buffer;

export interface ParaSegment {
  code: string;
  values: ParaValue[];
  /** The segment's bytes as sent, `#` through its last padding byte. */
  bytes: Buffer;
}

/** The segments of `body`; throws on any byte that doesn't fit the grammar. */
export function parseParaSegments(body: Buffer): ParaSegment[] {
  const out: ParaSegment[] = [];
  let off = 0;
  const text = (start: number, length: number): string => {
    if (start + length > body.length) {
      throw new Error(`parseParaSegments: truncated value at byte ${start}`);
    }
    return body.toString("latin1", start, start + length);
  };
  while (off < body.length) {
    if (body[off] !== 0x23) throw new Error(`parseParaSegments: expected # at byte ${off}`);
    const start = off;
    const segment: Omit<ParaSegment, "bytes"> = { code: text(off + 1, 3), values: [] };
    off += 4;
    while (off < body.length && body[off] !== 0x23) {
      const kind = text(off, 1);
      if (kind === "d" && /^\d{3}$/.test(text(off + 1, 3))) {
        segment.values.push(Number(text(off + 1, 3)));
        off += 4;
      } else if (kind === "i" && /^\d{7}$/.test(text(off + 1, 7))) {
        segment.values.push(Number(text(off + 1, 7)));
        off += 8;
      } else if (kind === "h" && /^[0-9a-f]{3}$/i.test(text(off + 1, 3))) {
        const length = parseInt(text(off + 1, 3), 16);
        const padded = Math.ceil(length / 4) * 4;
        text(off + 4, padded); // bounds check
        segment.values.push(body.subarray(off + 4, off + 4 + length));
        off += 4 + padded;
      } else if (/^[A-Z0-9 ]{4}$/.test(text(off, 4))) {
        segment.values.push(text(off, 4));
        off += 4;
      } else {
        throw new Error(`parseParaSegments: unparseable value at byte ${off}`);
      }
    }
    out.push({ ...segment, bytes: body.subarray(start, off) });
  }
  return out;
}
