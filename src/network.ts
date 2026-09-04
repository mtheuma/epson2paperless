import dgram from "node:dgram";
import dns from "node:dns/promises";
import net from "node:net";
import { createLogger } from "./logger.js";

const log = createLogger("network");

export function normalizeIPv4(address: string): string | null {
  if (net.isIPv4(address)) return address;
  const mapped = address.match(/^::ffff:(\d+(?:\.\d+){3})$/i);
  return mapped && net.isIPv4(mapped[1]) ? mapped[1] : null;
}

export type IPv4Lookup = (hostname: string) => Promise<string[]>;

async function lookupIPv4(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { family: 4, all: true });
  return results
    .map((result) => result.address)
    .filter((address) => normalizeIPv4(address) !== null);
}

export interface PrinterTarget {
  readonly configuredIp?: string;
  readonly hostname?: string;
  readonly addresses: ReadonlySet<string>;
  refresh(force?: boolean): Promise<void>;
  accepts(peer: string): Promise<boolean>;
  target(): Promise<string>;
  stop(): void;
}

export async function createPrinterTarget(
  config: { printerIp?: string; printerHostname?: string },
  options: { lookup?: IPv4Lookup; refreshIntervalMs?: number; now?: () => number } = {},
): Promise<PrinterTarget> {
  const lookup = options.lookup ?? lookupIPv4;
  const intervalMs = options.refreshIntervalMs ?? 30_000;
  const now = options.now ?? Date.now;
  const addresses = new Set<string>(config.printerIp ? [config.printerIp] : []);
  let lastRefresh = config.printerIp ? now() : 0;
  let lastOnDemand = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = async (force = false): Promise<void> => {
    if (config.printerIp || (!force && now() - lastRefresh < intervalMs)) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const resolved = new Set(
          (await lookup(config.printerHostname!))
            .map((a) => normalizeIPv4(a))
            .filter((a): a is string => a !== null),
        );
        if (resolved.size === 0) throw new Error("hostname has no IPv4 address");
        const added = [...resolved].filter((a) => !addresses.has(a));
        const removed = [...addresses].filter((a) => !resolved.has(a));
        addresses.clear();
        for (const address of resolved) addresses.add(address);
        lastRefresh = now();
        if (added.length || removed.length)
          log.info(
            `Resolved ${config.printerHostname}: +[${added.join(", ")}] -[${removed.join(", ")}]`,
          );
      } catch (err) {
        if (addresses.size === 0) {
          throw new Error(
            `Cannot resolve PRINTER_HOSTNAME=${config.printerHostname} to IPv4: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        log.warn(
          `Unable to refresh ${config.printerHostname}; retaining last-known-good addresses`,
          err,
        );
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  await refresh(true);
  const timer = config.printerHostname ? setInterval(() => void refresh(), intervalMs) : null;
  timer?.unref();
  return {
    configuredIp: config.printerIp,
    hostname: config.printerHostname,
    get addresses() {
      return new Set(addresses);
    },
    refresh,
    async accepts(peer) {
      const normalized = normalizeIPv4(peer);
      if (!normalized) return false;
      if (config.printerIp) return normalized === config.printerIp;
      if (!addresses.has(normalized)) {
        // A refresh already in flight will publish its result to the shared
        // set, so join it rather than being throttled against it: without
        // this, a second unknown peer arriving inside the resolver window
        // (~100-200 ms) would skip the refresh and be tested against the
        // stale set. Both arms stamp the throttle, because both end with a
        // just-completed resolution. The throttled-out path deliberately does
        // not stamp, so a spray of unknown peers can't keep pushing the window
        // forward and starve a genuine new address of its refresh.
        if (inFlight) {
          await inFlight;
          lastOnDemand = now();
        } else if (now() - lastOnDemand >= 1000) {
          lastOnDemand = now();
          await refresh(true);
        }
      }
      return addresses.has(normalized);
    },
    async target() {
      // Unforced: construction already resolved once, and honouring the
      // staleness guard here is what keeps that from becoming two
      // back-to-back lookups on every daemon start and every scan:now.
      await refresh();
      const value = config.printerIp ?? [...addresses][0];
      if (!value) throw new Error(`PRINTER_HOSTNAME=${config.printerHostname} has no IPv4 address`);
      return value;
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

/**
 * Determines which local IP address can reach the given target IP.
 * Opens a temporary UDP socket aimed at the target and checks which
 * local address the OS selects — no packet is actually sent.
 */
export function getLocalIpForTarget(targetIp: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    // connect() on a UDP socket just sets the default destination —
    // it doesn't send anything. The OS picks the right local interface.
    sock.connect(1, targetIp, () => {
      const addr = sock.address();
      sock.close();
      resolve(addr.address);
    });
    sock.on("error", (err) => {
      sock.close();
      reject(new Error(`Cannot determine local IP for target ${targetIp}: ${err.message}`));
    });
  });
}
