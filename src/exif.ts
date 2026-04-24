/**
 * EXIF Orientation tag values. Covers the four cardinal orientations plus
 * "no rotation". Values 2/4/5/7 describe mirrored orientations and are
 * intentionally unsupported by this module — the scanner never produces a
 * mirrored image, so there's no caller for them.
 *
 *   1 = normal (no rotation)
 *   3 = rotated 180°
 *   6 = rotated 90° clockwise
 *   8 = rotated 90° counter-clockwise
 */
export type ExifOrientation = 1 | 3 | 6 | 8;

/**
 * Prepends a minimal EXIF APP1 segment carrying just an Orientation tag to
 * the given JPEG buffer. The APP1 is inserted immediately after the SOI
 * marker, before any existing APP0/JFIF or other segments — this order is
 * legal per the JPEG spec and is how most camera firmware writes EXIF.
 *
 * Pixel data is left untouched. This is a pure metadata hint that
 * EXIF-aware viewers and converters (including img2pdf, used by
 * Paperless-ngx) apply as a rotation at render time.
 *
 * Assumes the input has no pre-existing EXIF APP1 segment. The scanner-
 * produced JPEGs we consume are JFIF-only (no APP1), so this holds in
 * practice. If a caller passes a JPEG that already has APP1, the result
 * will contain two APP1 segments; readers typically use the first one,
 * which would be the one this function prepended.
 *
 * Throws if the input does not start with an SOI marker (0xFF 0xD8).
 */
export function setJpegOrientation(jpeg: Buffer, orientation: ExifOrientation): Buffer {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("setJpegOrientation: input does not start with JPEG SOI (FF D8)");
  }
  // 36-byte EXIF APP1 segment. Layout:
  //   marker(2) + length(2) + "Exif\0\0"(6) + TIFF header(8)
  //     + IFD0 entry-count(2) + one 12-byte Orientation entry + next-IFD offset(4)
  // All multibyte TIFF fields are big-endian (byte-order 'MM'). The orientation
  // value is a SHORT (2 bytes) stored in the 4-byte inline value field of the
  // IFD entry, high byte first — so for orientation=3 the bytes are "00 03 00 00".
  // prettier-ignore
  const app1 = Buffer.from([
    0xff, 0xe1,                                       // APP1 marker
    0x00, 0x22,                                       // segment length = 34 (excludes marker, includes self)
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,               // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a,                           // TIFF byte-order MM, magic 42
    0x00, 0x00, 0x00, 0x08,                           // IFD0 offset (8 = immediately after this)
    0x00, 0x01,                                       // IFD0 entry count = 1
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,   // tag=Orientation (0x0112), type=SHORT, count=1
    0x00, orientation, 0x00, 0x00,                    // value (big-endian SHORT in 4-byte value field)
    0x00, 0x00, 0x00, 0x00,                           // next-IFD offset = 0 (terminator)
  ]);
  // Single-allocation insert: `Buffer.concat` would allocate the intermediate
  // 3-element array and a final combined buffer. For multi-MB JPEGs the
  // explicit copy path avoids the extra array and is one allocation total.
  const out = Buffer.allocUnsafe(jpeg.length + app1.length);
  jpeg.copy(out, 0, 0, 2);
  app1.copy(out, 2);
  jpeg.copy(out, 2 + app1.length, 2);
  return out;
}
