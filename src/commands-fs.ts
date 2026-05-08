// src/commands-fs.ts
//
// Legacy ESC/I "FS *" two-byte commands. Used by both protocol generations:
// the WF-3620 ESC/I path emits FS Y (in the diagnose-protocol probe), and
// the ET-4950 ESC/I-2 path uses FS Y / FS X / FS Z to drive the legacy
// init poll before switching to extended mode. Lifting them out of
// `src/esci2/commands.ts` keeps `src/esci/graph.ts` free of cross-protocol
// imports — `from "../esci2/commands.js"` was the only such reach across
// the protocol boundary.

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
