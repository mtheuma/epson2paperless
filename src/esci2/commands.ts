// Legacy ESC/I "FS *" commands shared with the WF-3620 path now live in
// `src/commands-fs.ts`. They retain the same wire bytes; this comment is
// the only thing that moved.

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
