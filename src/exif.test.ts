import { describe, it, expect } from "vitest";
import { setJpegOrientation } from "./exif.js";

describe("setJpegOrientation", () => {
  // A minimal valid JPEG prefix for tests: SOI + 3 arbitrary bytes.
  const minimalJpeg = Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56]);

  it("prepends a 36-byte EXIF APP1 segment after the SOI for orientation=3", () => {
    const result = setJpegOrientation(minimalJpeg, 3);
    expect(result.length).toBe(minimalJpeg.length + 36);
    // First 2 bytes: SOI unchanged
    expect(result.subarray(0, 2).toString("hex")).toBe("ffd8");
    // Bytes 2-37: exact APP1 template with orientation=3 at offset 31
    // prettier-ignore
    const expectedApp1 = Buffer.from([
      0xff, 0xe1,
      0x00, 0x22,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x4d, 0x4d, 0x00, 0x2a,
      0x00, 0x00, 0x00, 0x08,
      0x00, 0x01,
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
      0x00, 0x03, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(result.subarray(2, 38).equals(expectedApp1)).toBe(true);
    // Remaining bytes: original body after SOI, shifted right by 36.
    expect(result.subarray(38).equals(minimalJpeg.subarray(2))).toBe(true);
  });

  it.each([1, 3, 6, 8] as const)(
    "writes orientation=%i into byte 31 of the output",
    (orientation) => {
      const result = setJpegOrientation(minimalJpeg, orientation);
      expect(result[31]).toBe(orientation);
      // High byte of the big-endian SHORT value field is always 0 for values 1..8
      expect(result[30]).toBe(0);
    },
  );

  it("differs from an orientation=3 output only at byte 31 across orientations 1/6/8", () => {
    const base = setJpegOrientation(minimalJpeg, 3);
    for (const other of [1, 6, 8] as const) {
      const candidate = setJpegOrientation(minimalJpeg, other);
      expect(candidate.length).toBe(base.length);
      for (let i = 0; i < base.length; i++) {
        if (i === 31) continue;
        expect(candidate[i]).toBe(base[i]);
      }
    }
  });

  it("preserves every post-SOI byte of the input (byte-loss invariant)", () => {
    const longerBody = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1024, 0xab)]);
    const result = setJpegOrientation(longerBody, 3);
    expect(result.subarray(38).equals(longerBody.subarray(2))).toBe(true);
  });

  it("throws when the input does not start with the JPEG SOI marker", () => {
    const cases: Buffer[] = [
      Buffer.alloc(0),
      Buffer.from([0xff]),
      Buffer.from([0xff, 0x00]),
      Buffer.from([0xff, 0xd9]), // EOI, not SOI
      Buffer.from([0x00, 0xd8]),
    ];
    for (const input of cases) {
      expect(() => setJpegOrientation(input, 3)).toThrow(/SOI/i);
    }
  });

  it("writes the APP1 segment length as 0x0022 (34 bytes, per EXIF spec)", () => {
    const result = setJpegOrientation(minimalJpeg, 3);
    // Bytes 2-3 of the output are the APP1 segment length (big-endian, excludes marker).
    expect(result.readUInt16BE(4)).toBe(0x0022);
  });
});
