import dgram from "node:dgram";
import { createLogger } from "./logger.js";

const log = createLogger("keepalive");

export interface KeepaliveOptions {
  clientName: string;
  ipAddress: string;
  eventPort: number;
  destId: number;
  language: string;
}

/**
 * Builds the UDP keepalive packet that registers this service as a
 * scan destination on the Epson printer's panel.
 *
 * Packet layout (from Wireshark capture analysis):
 *   Offset 0-1:   02 07          — command type
 *   Offset 2-3:   00 00          — reserved
 *   Offset 4:     total_len      — total packet length
 *   Offset 5-10:  00 00 00 00 00 00 — reserved
 *   Offset 11:    seq            — sequence number echoed from the printer's 02 06 announcement
 *   Offset 12:    00             — padding
 *   Offset 13:    dest_id        — destination ID
 *   Offset 14-15: language       — 2-char ASCII (e.g. "en")
 *   Offset 16-19: str_len        — string data length (big-endian uint32, excludes null terminator)
 *   Offset 20+:   key-value string + null terminator
 */
export function buildKeepalivePacket(opts: KeepaliveOptions, seq: number): Buffer {
  const kvString =
    `(ClientName=${opts.clientName}),` +
    `(IPAddress=${opts.ipAddress}),` +
    `(EventPort=${opts.eventPort})\0`;

  const stringBytes = Buffer.from(kvString, "ascii");
  const headerLen = 20;
  const totalLen = headerLen + stringBytes.length;

  const packet = Buffer.alloc(totalLen);

  // Header
  packet[0] = 0x02; // command type byte 1
  packet[1] = 0x07; // command type byte 2
  // bytes 2-3 stay 0x00 (reserved)
  packet[4] = totalLen; // total packet length
  // bytes 5-10 stay 0x00 (reserved)
  packet[11] = seq; // sequence number echoed from printer's announcement
  // byte 12 stays 0x00 (padding)
  packet[13] = opts.destId; // destination ID
  packet.write(opts.language, 14, 2, "ascii"); // language code
  // str_len excludes the null terminator byte (matches Wireshark capture)
  packet.writeUInt32BE(stringBytes.length - 1, 16); // string data length

  // Key-value string payload
  stringBytes.copy(packet, headerLen);

  return packet;
}

/**
 * Parses a printer announcement packet (broadcast by the printer to 239.255.255.253:2968).
 *
 * The announcement uses command type 02 06. Byte 11 carries the sequence number
 * that must be echoed in our keepalive response.
 *
 * Returns `{ seq }` if the packet looks like a valid announcement, or `null` if it
 * doesn't match (so callers can ignore unrelated multicast traffic).
 */
export function parsePrinterAnnouncement(data: Buffer): { seq: number } | null {
  if (data.length < 12) return null;
  if (data[0] !== 0x02 || data[1] !== 0x06 || data[2] !== 0x00 || data[3] !== 0x00) {
    return null;
  }
  return { seq: data[11] };
}

export interface KeepaliveResponderOptions {
  /** Existing KeepaliveOptions: clientName, ipAddress, eventPort, destId, language */
  keepalive: KeepaliveOptions;
  /** Unicast destination — the printer's IP address */
  printerIp: string;
  /** UDP port to send keepalives to (2968) */
  printerPort: number;
  /** Multicast group to join for printer announcements (239.255.255.253) */
  multicastAddress: string;
  /** UDP port to listen on for multicast announcements (2968) */
  multicastPort: number;
  /** Number of keepalive packets to send per announcement burst (default 3) */
  burstCount: number;
  /** Interval between packets in a burst, in milliseconds (default 500) */
  burstIntervalMs: number;
  /**
   * Window during which repeated announcements of the same seq are ignored.
   * The printer broadcasts each `02 06` beacon 3× per cycle; without this,
   * we'd emit 3 bursts × 3 packets = 9 unicasts per cycle. Dedupping by
   * seq collapses that to 1 burst per distinct seq. Default 30_000 ms —
   * long enough to span a cycle's 3 beacons, short enough that seq
   * wrap-around across cycles still fires a new burst.
   */
  dedupWindowMs?: number;
}

export interface KeepaliveResponder {
  start(): Promise<void>;
  stop(): void;
  /**
   * The UDP port the responder is bound to. Valid only after `start()`
   * resolves. Useful in tests that pass `multicastPort: 0` to get an
   * ephemeral port and then need to address the responder.
   */
  readonly boundPort: number;
}

/**
 * Creates a responder that listens on the multicast group for printer announcements
 * and responds with a burst of keepalive packets echoing the printer's sequence number.
 *
 * This replaces the old `createKeepaliveSender`, which fired unsolicited keepalives
 * every 500 ms with a hardcoded sequence number. The printer only opens UDP 2968
 * during ~60-second windows after broadcasting its own announcement, and only
 * accepts keepalives whose byte 11 matches the announcement sequence.
 */
export function createKeepaliveResponder(opts: KeepaliveResponderOptions): KeepaliveResponder {
  let socket: dgram.Socket | null = null;
  let boundPort = 0;
  // Track all pending burst timers so we can cancel them on stop()
  const pendingTimers: ReturnType<typeof setTimeout>[] = [];
  // seq → auto-expire timer; paired lifecycle so stop() can cancel both.
  // See dedupWindowMs JSDoc above for the rationale.
  const seenSeqs = new Map<number, ReturnType<typeof setTimeout>>();
  const dedupWindowMs = opts.dedupWindowMs ?? 30_000;

  return {
    get boundPort() {
      return boundPort;
    },
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

        socket.on("error", (err) => {
          log.error("Keepalive responder socket error", err);
        });

        socket.on("message", (data: Buffer, rinfo: dgram.RemoteInfo) => {
          const announcement = parsePrinterAnnouncement(data);
          if (!announcement) return; // not an 02 06 announcement — ignore

          const seqHex = `0x${announcement.seq.toString(16).padStart(2, "0")}`;

          if (seenSeqs.has(announcement.seq)) {
            log.debug(
              `Duplicate printer announcement from ${rinfo.address} — seq=${seqHex} already handled within ${dedupWindowMs}ms window, skipping burst`,
            );
            return;
          }
          // Mark this seq as recently handled; auto-expire so a later cycle
          // that reuses the same seq (byte wraps at 256) still fires.
          const expiry = setTimeout(() => {
            seenSeqs.delete(announcement.seq);
          }, dedupWindowMs);
          seenSeqs.set(announcement.seq, expiry);

          log.info(
            `Printer announcement received from ${rinfo.address} — seq=${seqHex}; sending burst of ${opts.burstCount}`,
          );

          // Packet bytes are identical across all N packets in the burst —
          // build once and reuse.
          const packet = buildKeepalivePacket(opts.keepalive, announcement.seq);

          for (let i = 0; i < opts.burstCount; i++) {
            const burstIndex = i + 1;
            const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
              if (!socket) return;
              socket.send(packet, opts.printerPort, opts.printerIp, (err) => {
                if (err) {
                  log.error(`Keepalive burst send #${burstIndex} failed`, err);
                } else {
                  log.debug(
                    `Keepalive burst #${burstIndex}/${opts.burstCount} sent to ${opts.printerIp}:${opts.printerPort} seq=${seqHex}`,
                  );
                }
              });
              // Remove self from pendingTimers so the array doesn't grow
              // unboundedly across beacon cycles.
              const idx = pendingTimers.indexOf(timer);
              if (idx !== -1) pendingTimers.splice(idx, 1);
            }, i * opts.burstIntervalMs);

            pendingTimers.push(timer);
          }
        });

        socket.bind(opts.multicastPort, () => {
          if (!socket) return;
          try {
            const addr = socket.address();
            boundPort = typeof addr === "object" ? addr.port : opts.multicastPort;
            socket.addMembership(opts.multicastAddress);
            log.info(
              `Keepalive responder listening on ${opts.multicastAddress}:${opts.multicastPort} — waiting for printer announcements`,
            );
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
    },

    stop() {
      // Cancel any pending burst timers
      for (const t of pendingTimers) clearTimeout(t);
      pendingTimers.length = 0;
      // Cancel any pending dedup-window expiries
      for (const t of seenSeqs.values()) clearTimeout(t);
      seenSeqs.clear();

      if (socket) {
        try {
          socket.dropMembership(opts.multicastAddress);
        } catch {
          // socket may already be closed — ignore
        }
        socket.close();
        socket = null;
      }
      log.info("Keepalive responder stopped");
    },
  };
}
