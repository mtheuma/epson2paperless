import dgram from "node:dgram";
import { createLogger } from "./logger.js";
import { PID_FF680W, PID_DS575W, extractPid } from "./printer-ids.js";
import { getLocalIpForTarget, normalizeIPv4, type PrinterTarget } from "./network.js";

const log = createLogger("keepalive");

// Announced PIDs (uppercased "PID XXXX") that get the NetScanMonitor v3.0
// keepalive wire format when their beacon carries no usable tag list. These are
// the button-only DS-family scanners — the FF-680W (016B) and its DS-575W
// sibling (0169). A beacon's tag list, when present, decides instead (see
// chooseKeepaliveFormat); `NETSCAN_VERSION` overrides both.
const V3_KEEPALIVE_PRODUCTS = new Set([PID_FF680W, PID_DS575W]);

export interface KeepaliveOptions {
  clientName: string;
  ipAddress: string;
  eventPort: number;
  destId: number;
  language: string;
  /** Epson NetScanMonitor protocol version. Omitted keeps the v2 wire format. */
  version?: "2.0" | "3.0";
  group?: number;
}

/** Keepalive fields this service can answer, keyed by the tag a beacon requests. */
const KEEPALIVE_TAGS = ["Ver", "ClientName", "IPAddress", "EventPort", "Group"] as const;
type KeepaliveTag = (typeof KEEPALIVE_TAGS)[number];

function isKeepaliveTag(tag: string): tag is KeepaliveTag {
  return (KEEPALIVE_TAGS as readonly string[]).includes(tag);
}

/** The field list each wire format sends when no beacon tag list applies. */
function defaultTags(version: "2.0" | "3.0"): readonly KeepaliveTag[] {
  return version === "3.0" ? KEEPALIVE_TAGS : ["ClientName", "IPAddress", "EventPort"];
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
 *
 * The key-value string answers `tags` in the given order, one `(Tag=value)`
 * per known tag; unknown and repeated tags are left out. Without `tags`, `opts.version`
 * picks the fixed v2 or v3 field list.
 */
export function buildKeepalivePacket(
  opts: KeepaliveOptions,
  seq: number,
  tags: readonly string[] = defaultTags(opts.version ?? "2.0"),
): Buffer {
  const values: Record<KeepaliveTag, string> = {
    Ver: "3.0",
    ClientName: opts.clientName,
    IPAddress: opts.ipAddress,
    EventPort: String(opts.eventPort),
    Group: String(opts.group ?? 0),
  };
  const fields = [...new Set(tags)].filter(isKeepaliveTag).map((tag) => `(${tag}=${values[tag]})`);
  const kvString = `${fields.join(",")}\0`;

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

export interface PrinterAnnouncement {
  /** Sequence number (byte 11) the keepalive must echo. */
  seq: number;
  /** Canonical `PID XXXX` token, or null when the announcement carries none. */
  productName: string | null;
  /**
   * The keepalive fields the printer asks for, in the order it lists them
   * (e.g. `["ClientName", "IPAddress", "EventPort"]`), unknown tags included,
   * or null when the announcement carries no tag list naming a field this
   * service can answer.
   */
  requestedTags: string[] | null;
}

// A tag-list record: comma-separated field names, nothing else. The PID record
// ("PID 016B") never matches, because of its space.
const TAG_LIST_SHAPE = /^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/;

/**
 * Reads the requested tag list from an announcement's body. After the 20-byte
 * header comes the service string (length in bytes 16-19, NUL-terminated),
 * then records of one length byte + text + NUL, ended by a zero length byte.
 * The tag list is the first record shaped like a comma-separated list of
 * field names that names at least one field this service can answer. Any
 * framing inconsistency, or no such record, yields null, so the caller falls
 * back to the PID-based choice rather than to a guessed list.
 */
function parseRequestedTags(data: Buffer): string[] | null {
  if (data.length < 20) return null;
  let offset = 20 + data.readUInt32BE(16);
  if (offset >= data.length || data[offset] !== 0x00) return null;
  offset++;
  while (offset < data.length && data[offset] !== 0x00) {
    const start = offset + 1;
    const end = start + data[offset];
    if (end >= data.length || data[end] !== 0x00) return null;
    const text = data.toString("latin1", start, end);
    if (TAG_LIST_SHAPE.test(text)) {
      const tags = text.split(",");
      if (tags.some(isKeepaliveTag)) return tags;
    }
    offset = end + 1;
  }
  return null;
}

/**
 * Parses a printer announcement packet (broadcast by the printer to 239.255.255.253:2968).
 *
 * The announcement uses command type 02 06. Byte 11 carries the sequence number
 * that must be echoed in our keepalive response.
 *
 * Returns the announcement if the packet looks like a valid one, or `null` if it
 * doesn't match (so callers can ignore unrelated multicast traffic).
 */
export function parsePrinterAnnouncement(data: Buffer): PrinterAnnouncement | null {
  if (data.length < 12) return null;
  if (data[0] !== 0x02 || data[1] !== 0x06 || data[2] !== 0x00 || data[3] !== 0x00) {
    return null;
  }
  return {
    seq: data[11],
    productName: extractPid(data.toString("latin1")),
    requestedTags: parseRequestedTags(data),
  };
}

interface KeepaliveFormat {
  version: "2.0" | "3.0";
  /** The fields to answer, in wire order. */
  tags: readonly string[];
  /** What decided the format, for the INFO log line. */
  basis: string;
}

/**
 * Picks the keepalive reply for one announcement, in priority order:
 *   1. a forced version (`NETSCAN_VERSION`) sends that version's fixed field list;
 *   2. a beacon tag list is answered tag by tag, in its order, and the reply is
 *      v3 exactly when `Ver` is requested. Unknown tags are skipped (debug log);
 *   3. otherwise the announced PID decides (v3 for V3_KEEPALIVE_PRODUCTS).
 */
function chooseKeepaliveFormat(
  forced: "2.0" | "3.0" | undefined,
  announcement: PrinterAnnouncement,
): KeepaliveFormat {
  if (forced) {
    return { version: forced, tags: defaultTags(forced), basis: "forced by NETSCAN_VERSION" };
  }
  const requested = announcement.requestedTags;
  if (requested) {
    const known = requested.filter(isKeepaliveTag);
    const unknown = requested.filter((tag) => !isKeepaliveTag(tag));
    if (unknown.length > 0) {
      log.debug(
        `Announcement requests keepalive tag(s) this service doesn't know — skipping: ${unknown.join(", ")}`,
      );
    }
    return {
      version: known.includes("Ver") ? "3.0" : "2.0",
      tags: known,
      basis: `answering requested tags ${known.join(",")}`,
    };
  }
  const version =
    announcement.productName && V3_KEEPALIVE_PRODUCTS.has(announcement.productName) ? "3.0" : "2.0";
  return {
    version,
    tags: defaultTags(version),
    basis: "no usable tag list, chosen by announced PID",
  };
}

export interface KeepaliveResponderOptions {
  /**
   * clientName, eventPort, destId, language, and optionally version. No
   * ipAddress: the advertised address is computed per announcement, against
   * that announcement's source, so a fixed value here would never reach the
   * wire (and would be wrong on a multi-homed host).
   */
  keepalive: Omit<KeepaliveOptions, "ipAddress">;
  /** Unicast destination — the printer's IP address */
  printerIp: string;
  target?: PrinterTarget;
  localIpForTarget?: (target: string) => Promise<string>;
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
   * The printer broadcasts each `02 06` beacon 3× per announcement; without
   * this, we'd emit 3 bursts × 3 packets = 9 unicasts per announcement.
   * Dedupping by seq collapses that to 1 burst per distinct seq. Default
   * 30_000 ms — long enough to span an announcement's 3 beacons, short
   * enough that seq wrap-around across announcements still fires a new burst.
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
  let sender: dgram.Socket | null = null;
  let boundPort = 0;
  // Track all pending burst timers so we can cancel them on stop()
  const pendingTimers: ReturnType<typeof setTimeout>[] = [];
  // seq → auto-expire timer; paired lifecycle so stop() can cancel both.
  // See dedupWindowMs JSDoc above for the rationale.
  const seenSeqs = new Map<string, ReturnType<typeof setTimeout>>();
  // Unrecognised source IP → auto-expire timer. Throttles the rejected-peer
  // warning to once per address per dedup window, so a chatty stale beacon
  // can't flood the log while the mismatch persists.
  const warnedPeers = new Map<string, ReturnType<typeof setTimeout>>();
  const dedupWindowMs = opts.dedupWindowMs ?? 30_000;

  return {
    get boundPort() {
      return boundPort;
    },
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        sender = dgram.createSocket("udp4");

        socket.on("error", (err) => {
          log.error("Keepalive responder socket error", err);
        });
        sender.on("error", (err) => {
          log.error("Keepalive sender socket error", err);
        });

        socket.on("message", (data: Buffer, rinfo: dgram.RemoteInfo) => {
          void (async () => {
            const announcement = parsePrinterAnnouncement(data);
            if (!announcement) {
              // Not an 02 06 announcement. The socket is bound to 0.0.0.0:2968,
              // so unicast probes land here too — some models may validate a
              // destination with a different command type before scanning.
              // Surface the bytes at debug instead of dropping them invisibly.
              log.debug(
                `Ignoring non-announcement UDP packet from ${rinfo.address}:${rinfo.port} — ` +
                  `${data.length} bytes: ${data.subarray(0, 64).toString("hex")}${data.length > 64 ? "…" : ""}`,
              );
              return;
            }

            const seqHex = `0x${announcement.seq.toString(16).padStart(2, "0")}`;

            const source = normalizeIPv4(rinfo.address);
            if (
              !source ||
              (opts.target
                ? !(await opts.target.accepts(source))
                : source !== normalizeIPv4(opts.printerIp))
            ) {
              // A mismatched beacon means no keepalive goes out and the panel
              // destination never appears — a stale DNS record is the likeliest
              // cause. Warn (parity with the push-scan rejection), naming the
              // observed and expected addresses, throttled per address.
              const observed = rinfo.address;
              if (!warnedPeers.has(observed)) {
                const expected = opts.target
                  ? `${opts.target.hostname ?? "configured target"} [${[...opts.target.addresses].join(", ") || "unresolved"}]`
                  : (normalizeIPv4(opts.printerIp) ?? opts.printerIp);
                log.warn(
                  `Ignoring announcement from unrecognised peer ${observed} — expected ${expected}`,
                );
                const warnExpiry = setTimeout(() => warnedPeers.delete(observed), dedupWindowMs);
                warnedPeers.set(observed, warnExpiry);
              }
              return;
            }
            const dedupKey = `${source}:${announcement.seq}`;
            if (seenSeqs.has(dedupKey)) {
              log.debug(
                `Duplicate printer announcement from ${rinfo.address} — seq=${seqHex} already handled within ${dedupWindowMs}ms window, skipping burst`,
              );
              return;
            }
            // Mark this seq as recently handled; auto-expire so a later
            // announcement that reuses the same seq (byte wraps at 256) still fires.
            const expiry = setTimeout(() => {
              seenSeqs.delete(dedupKey);
            }, dedupWindowMs);
            seenSeqs.set(dedupKey, expiry);

            const format = chooseKeepaliveFormat(opts.keepalive.version, announcement);

            // Surface the announced PID and the chosen keepalive version at INFO —
            // compatibility reports for unrecognised models hinge on both.
            log.info(
              `Printer announcement received from ${rinfo.address} — seq=${seqHex}, ` +
                `product=${announcement.productName ?? "<not reported>"}; ` +
                `sending burst of ${opts.burstCount} (keepalive v${format.version}, ${format.basis})`,
            );
            const localIp = await (async () => {
              try {
                return await (opts.localIpForTarget ?? getLocalIpForTarget)(source);
              } catch (err) {
                // No route to the printer (EHOSTUNREACH / ENETUNREACH), most
                // likely mid-renumber. Drop the dedup entry so the next
                // announcement (sent when the user next opens the panel's scan
                // menu — there is no timer) retries instead of skipping this
                // seq as a duplicate; the two near-simultaneous duplicates of
                // this same announcement have already been skipped by now.
                const timer = seenSeqs.get(dedupKey);
                if (timer) clearTimeout(timer);
                seenSeqs.delete(dedupKey);
                log.warn(
                  `No local route to ${source} for keepalive (seq=${seqHex}) — skipping burst, will retry on the next announcement`,
                  err,
                );
                return null;
              }
            })();
            if (localIp === null) return;
            // Packet bytes are identical across all N packets in the burst —
            // build once and reuse.
            const packet = buildKeepalivePacket(
              { ...opts.keepalive, ipAddress: localIp },
              announcement.seq,
              format.tags,
            );

            // Source-port policy. v3 keepalives go out from an ephemeral source
            // port (as the FF-680W capture shows), via the dedicated unbound
            // `sender`. v2 keepalives keep sending from the bound multicast
            // socket (port 2968), the source port the v2 fleet was validated against.
            const useEphemeralSender = format.version === "3.0";

            for (let i = 0; i < opts.burstCount; i++) {
              const burstIndex = i + 1;
              const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
                // Resolve the live socket inside the timer so stop() (which nulls
                // both) still cancels an in-flight burst.
                const burstSocket = useEphemeralSender ? sender : socket;
                if (!burstSocket) return;
                burstSocket.send(packet, opts.printerPort, source, (err) => {
                  if (err) {
                    log.error(`Keepalive burst send #${burstIndex} failed`, err);
                  } else {
                    log.debug(
                      `Keepalive burst #${burstIndex}/${opts.burstCount} sent to ${source}:${opts.printerPort} seq=${seqHex}`,
                    );
                  }
                });
                // Remove self from pendingTimers so the array doesn't grow
                // unboundedly across announcements.
                const idx = pendingTimers.indexOf(timer);
                if (idx !== -1) pendingTimers.splice(idx, 1);
              }, i * opts.burstIntervalMs);

              pendingTimers.push(timer);
            }
          })();
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
      // Cancel any pending rejected-peer warn throttles
      for (const t of warnedPeers.values()) clearTimeout(t);
      warnedPeers.clear();

      if (socket) {
        try {
          socket.dropMembership(opts.multicastAddress);
        } catch {
          // socket may already be closed — ignore
        }
        socket.close();
        socket = null;
      }
      if (sender) {
        sender.close();
        sender = null;
      }
      log.info("Keepalive responder stopped");
    },
  };
}
