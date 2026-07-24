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

/**
 * Sets the JFIF pixel density (dots-per-inch) of a JPEG, returning a new
 * buffer. JFIF APP0 — not EXIF — is where DPI-honouring consumers (img2pdf /
 * Paperless-ngx, printing pipelines) read physical size from, and stamping it
 * after the encode is the only way to preserve a source's DPI on a
 * single-channel output: sharp's `.withMetadata({ density })` attaches an
 * sRGB ICC profile, which silently forces the encode back to three channels.
 *
 * If a JFIF APP0 segment exists its density fields are patched in place (on a
 * copy); sharp's default mozjpeg output carries no APP0 at all, so when none
 * is found a minimal 18-byte JFIF APP0 is inserted immediately after SOI.
 * Call this BEFORE setJpegOrientation — the EXIF prepend shifts every later
 * segment. Throws on a non-JPEG input.
 */
export function setJfifDensity(jpeg: Buffer, dpi: number): Buffer {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("setJfifDensity: input does not start with JPEG SOI (FF D8)");
  }
  const density = Math.max(1, Math.min(65535, Math.round(dpi)));
  let off = 2; // skip SOI
  while (off + 4 <= jpeg.length) {
    if (jpeg[off] !== 0xff) break;
    const marker = jpeg[off + 1];
    const segLen = jpeg.readUInt16BE(off + 2);
    const body = off + 4;
    // JFIF APP0 body: "JFIF\0"(5) + version(2) + units(1) + Xdensity(2)
    // + Ydensity(2) + thumbnail dims(2) — 14 bytes minimum.
    if (
      marker === 0xe0 &&
      segLen >= 16 &&
      body + 12 <= jpeg.length &&
      jpeg.toString("ascii", body, body + 5) === "JFIF\0"
    ) {
      const out = Buffer.from(jpeg);
      out[body + 7] = 1; // units: dots per inch
      out.writeUInt16BE(density, body + 8); // Xdensity
      out.writeUInt16BE(density, body + 10); // Ydensity
      return out;
    }
    if (marker === 0xda) break; // start of scan — no more metadata
    if (segLen < 2) break; // malformed segment length — can't safely advance
    off += 2 + segLen;
  }
  // No JFIF APP0 — insert a minimal one right after SOI.
  // prettier-ignore
  const app0 = Buffer.from([
    0xff, 0xe0,                   // APP0 marker
    0x00, 0x10,                   // segment length = 16 (excludes marker, includes self)
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01,                   // JFIF version 1.01
    0x01,                         // units: dots per inch
    (density >> 8) & 0xff, density & 0xff, // Xdensity
    (density >> 8) & 0xff, density & 0xff, // Ydensity
    0x00, 0x00,                   // no thumbnail
  ]);
  const out = Buffer.allocUnsafe(jpeg.length + app0.length);
  jpeg.copy(out, 0, 0, 2);
  app0.copy(out, 2);
  jpeg.copy(out, 2 + app0.length, 2);
  return out;
}

/**
 * Reads the EXIF Orientation tag from a JPEG, or undefined if there's no
 * APP1/EXIF segment or no Orientation tag. Minimal TIFF parser — handles the
 * single-IFD layout that setJpegOrientation and camera firmware produce.
 */
export function readJpegOrientation(jpeg: Buffer): ExifOrientation | undefined {
  let off = 2; // skip SOI
  while (off + 4 <= jpeg.length) {
    if (jpeg[off] !== 0xff) break;
    const marker = jpeg[off + 1];
    const segLen = jpeg.readUInt16BE(off + 2);
    if (marker === 0xe1) {
      // APP1 — only an "Exif\0\0" APP1 carries the Orientation tag. Other APP1
      // segments (e.g. an XMP APP1 written before the Exif one) are skipped so
      // they don't hide a later Exif segment. Every read below is bounds-checked
      // against jpeg.length so a truncated or corrupt EXIF returns undefined
      // (per this function's contract) rather than throwing a RangeError.
      const base = off + 4;
      const tiff = base + 6;
      if (tiff + 8 <= jpeg.length && jpeg.toString("ascii", base, base + 4) === "Exif") {
        const le = jpeg.toString("ascii", tiff, tiff + 2) === "II";
        const u16 = (p: number) => (le ? jpeg.readUInt16LE(p) : jpeg.readUInt16BE(p));
        const u32 = (p: number) => (le ? jpeg.readUInt32LE(p) : jpeg.readUInt32BE(p));
        const ifd0 = tiff + u32(tiff + 4);
        if (ifd0 + 2 <= jpeg.length) {
          const count = u16(ifd0);
          for (let i = 0; i < count; i++) {
            const entry = ifd0 + 2 + i * 12;
            if (entry + 12 > jpeg.length) break; // entry runs past the buffer
            if (u16(entry) === 0x0112) {
              const v = u16(entry + 8);
              if (v === 1 || v === 3 || v === 6 || v === 8) return v;
            }
          }
        }
        return undefined; // Exif APP1 parsed; no usable Orientation tag.
      }
      // Non-Exif APP1 — fall through to skip it and keep scanning.
    }
    if (marker === 0xda) break; // start of scan — no more metadata
    if (segLen < 2) break; // malformed segment length (min is 2) — can't safely advance
    off += 2 + segLen;
  }
  return undefined;
}
