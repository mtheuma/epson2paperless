import { createLogger } from "./logger.js";

const log = createLogger("esci");

// ─── Legacy ESC/I commands (2 raw bytes each) ─────────────────────────────

/**
 * Legacy ESC/I "Inquire Extended Status" (FS Y). Two raw bytes.
 * Caller sends as passthru with cmd_size=2, reply_size=1.
 * Reply is 1 byte: 0x06 = ACK.
 */
export function buildFsY(): Buffer {
  return Buffer.from([0x1c, 0x59]);
}

/**
 * Legacy ESC/I "Switch to Extended Mode" (FS X). Two raw bytes.
 * Sent once after the init poll confirms the printer is ready, transitioning
 * the session from legacy ESC/I to ESC/I-2 framing.
 * Caller sends as passthru with cmd_size=2, reply_size=1.
 * Reply is 1 byte: 0x06 = ACK.
 */
export function buildFsX(): Buffer {
  return Buffer.from([0x1c, 0x58]);
}

/**
 * Legacy ESC/I FS Z (0x1C 0x5A). Used in the driver's cycle-2 init
 * polling to request a second, smaller capability-discovery pass.
 * Caller sends as passthru with cmd_size=2, reply_size=1; reply is 0x06.
 */
export function buildFsZ(): Buffer {
  return Buffer.from([0x1c, 0x5a]);
}

// ─── ESC/I-2 commands ─────────────────────────────────────────────────────

/**
 * Builds a 12-byte ESC/I-2 command header: "<NAME>x0000000".
 * For commands with no payload: STAT, FIN, TRDT, IMG.
 * Names shorter than 4 chars are right-padded with spaces.
 * Caller sends as passthru with cmd_size=12 and a command-specific reply_size.
 */
export function buildEsci2Command(name: string): Buffer {
  const paddedName = name.padEnd(4, " ");
  return Buffer.from(`${paddedName}x0000000`, "ascii");
}

/**
 * PARA phase-1 header (12 bytes: "PARAx<7-hex-length>").
 * Tells the printer to expect `payloadLength` bytes of parameters in the
 * next passthru. Caller sends as passthru with cmd_size=12, reply_size=0
 * (the printer acks with an empty 0xa000 reply but carries no useful data).
 */
export function buildParaHeader(payloadLength: number): Buffer {
  // Driver uses uppercase hex digits (e.g. "PARAx00003A8", not "3a8") —
  // matches the Frida capture byte-for-byte.
  const lenStr = payloadLength.toString(16).toUpperCase().padStart(7, "0");
  return Buffer.from(`PARAx${lenStr}`, "ascii");
}

/**
 * PARA phase-2 raw parameter bytes. Source + Sides both vary; content
 * depends on which physical path the printer is using.
 *   - source="adf"     duplex=false → 936 bytes, `#ADF`      tokens (announce 0x3A8)
 *   - source="adf"     duplex=true  → 940 bytes, `#ADFDPLX`  tokens (announce 0x3AC)
 *   - source="flatbed"              → 928 bytes, `#FB `      tokens (announce 0x3A0)
 *
 * `duplex` is ignored when `source === "flatbed"` (glass cannot duplex).
 * Caller sends as passthru with cmd_size=<returned.length>, reply_size=64.
 * See docs/notes/2026-04-20-multi-page-duplex-analysis.md (ADF variants)
 * and docs/notes/2026-04-21-flatbed-protocol-analysis.md (flatbed diff).
 */
export function buildParaPayload(opts: { source: "adf" | "flatbed"; duplex: boolean }): Buffer {
  if (opts.source === "flatbed") {
    if (opts.duplex) {
      // Physically impossible — glass is single-sided. Defensive log so we
      // surface it if the call site ever produces this combo, but don't
      // fail: treat the same as flatbed + simplex.
      log.warn("buildParaPayload: source=flatbed with duplex=true is impossible; ignoring duplex");
    }
    return buildParaFlatbed();
  }
  return buildParaAdf(opts.duplex);
}

function buildParaAdf(duplex: boolean): Buffer {
  const head = "23414446"; // "#ADF"
  const dplx = duplex ? "44504c58" : ""; // "DPLX" insertion for duplex
  const tail =
    "2352534d693030303033303023525353693030303033303023434f4c" +
    "4330323423464d544a504720234a50476430393023474d4d5547313023474d54" +
    "47524e2068313030000102030405060708090a0b0c0d0e0f1011121314151617" +
    "18191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353637" +
    "38393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f5051525354555657" +
    "58595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f7071727374757677" +
    "78797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f9091929394959697" +
    "98999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7" +
    "b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7" +
    "d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7" +
    "f8f9fafbfcfdfeff23474d545245442068313030000102030405060708090a0b" +
    "0c0d0e0f1011121315161718191a1b1c1d1e1f202122232425262728292a2b2c" +
    "2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c" +
    "4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c" +
    "6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c" +
    "8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabac" +
    "adaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c6c7c8c9cacb" +
    "cccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaeb" +
    "ecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff23474d54424c552068313030" +
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "20212223242425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e" +
    "3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e" +
    "5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e" +
    "7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e" +
    "9fa0a1a2a3a4a5a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
    "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
    "e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff" +
    "235149544f46462023434354434f4c2023504147643030302341435169303030" +
    "303036396930303030303030693030303234383169303030333530362342535a" +
    "6931303438353736";
  return Buffer.from(head + dplx + tail, "hex");
}

// Blob transcribed from tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl
// record 191. Differs from buildParaAdf(false) by three content changes:
//   - #ADF → #FB (trailing space; same 4-byte length)
//   - #PAGd000 omitted  (−8 bytes; whole size delta)
//   - #ACQi0000069 → #ACQi0000000 (y-start offset; same length)
// Flatbed PDF's PARA body is byte-identical to flatbed JPG's — PDF is
// host-composed, the wire is format-agnostic. One blob covers both.
function buildParaFlatbed(): Buffer {
  const bodyHex =
    "234642202352534d693030303033303023525353693030303033303023434f4c" +
    "4330323423464d544a504720234a50476430393023474d4d5547313023474d54" +
    "47524e2068313030000102030405060708090a0b0c0d0e0f1011121314151617" +
    "18191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353637" +
    "38393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f5051525354555657" +
    "58595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f7071727374757677" +
    "78797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f9091929394959697" +
    "98999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7" +
    "b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7" +
    "d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7" +
    "f8f9fafbfcfdfeff23474d545245442068313030000102030405060708090a0b" +
    "0c0d0e0f1011121315161718191a1b1c1d1e1f202122232425262728292a2b2c" +
    "2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c" +
    "4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c" +
    "6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c" +
    "8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabac" +
    "adaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c6c7c8c9cacb" +
    "cccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaeb" +
    "ecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff23474d54424c552068313030" +
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "20212223242425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e" +
    "3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e" +
    "5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e" +
    "7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e" +
    "9fa0a1a2a3a4a5a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
    "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
    "e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff" +
    "235149544f46462023434354434f4c2023414351693030303030303069303030" +
    "30303030693030303234383169303030333530362342535a6931303438353736";
  return Buffer.from(bodyHex, "hex");
}

// ─── Reply parsers ────────────────────────────────────────────────────────

export interface Esci2ReplyHeader {
  /** 4-char command name, right-trimmed (e.g. "IMG", "PARA", "STAT"). */
  cmd: string;
  /** The 7-hex length field parsed as an integer. */
  length: number;
}

/**
 * Parses the 12-byte ESC/I-2 reply header prefix, e.g. "IMG x000025F".
 * Returns null if the body is shorter than 12 bytes or the prefix doesn't
 * match "<4-char-name>x<7-hex-digits>".
 *
 * The `length` field is the critical signal in IMG replies — it tells the
 * scanner how many bytes to pure-read next for actual image data.
 */
export function parseEsci2ReplyHeader(body: Buffer): Esci2ReplyHeader | null {
  if (body.length < 12) return null;
  // Byte 4 must be 'x' (0x78).
  if (body[4] !== 0x78) return null;
  const cmd = body.subarray(0, 4).toString("ascii").trimEnd();
  const hex = body.subarray(5, 12).toString("ascii");
  if (!/^[0-9a-fA-F]{7}$/.test(hex)) return null;
  const length = parseInt(hex, 16);
  return { cmd, length };
}

/**
 * Parses "#KEYvalue#KEYvalue" tokens from a reply tail. Callers must strip
 * the 12-byte ESC/I-2 header first — this operates on what comes after.
 *
 * Each '#'-delimited part is expected to start with a 3-char key followed
 * by an arbitrary-length value. Parts shorter than 3 chars are ignored
 * (covers empty leading splits and "##" sequences).
 *
 * Valueless markers like "#pst" become `{"pst": ""}` — callers check
 * presence with `map.has("pst")`.
 *
 * Values are NOT trimmed — trailing padding (common in fixed-width status
 * replies) is preserved. Callers trim if they care about the value itself
 * (e.g. `map.get("par")?.trim() === "OK"`).
 */
export function parseTokens(tail: Buffer): Map<string, string> {
  const str = tail.toString("ascii");
  const tokens = new Map<string, string>();
  const parts = str.split("#");
  for (const part of parts) {
    if (part.length < 3) continue;
    const key = part.substring(0, 3);
    const value = part.substring(3);
    tokens.set(key, value);
  }
  return tokens;
}
