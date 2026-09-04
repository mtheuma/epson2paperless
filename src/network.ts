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

/**
 * How long a single hostname resolution may take before we give up on it.
 *
 * `dns.lookup` has no timeout option of its own and runs on the libuv
 * threadpool — four threads, shared with sharp's JPEG encode. A hung resolver
 * would otherwise park a thread for as long as the OS resolver takes, and the
 * unknown-peer refresh in `accepts()` is reachable at ~1 Hz by any LAN host
 * that sends a well-formed announcement, so a stall here can starve page
 * encoding mid-scan.
 *
 * 3 s is comfortably inside the protocol's own tolerances: the printer's beacon
 * cycle and its keepalive acceptance window are both ~60 s
 * (docs/PROTOCOL-REFERENCE.md), against burst offsets of 0 / 500 / 1000 ms.
 */
export const DEFAULT_LOOKUP_TIMEOUT_MS = 3000;

async function lookupIPv4(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { family: 4, all: true });
  return results
    .map((result) => result.address)
    .filter((address) => normalizeIPv4(address) !== null);
}

/**
 * Bounds a lookup that may never settle, freeing the caller without pretending
 * the work stopped. There is no way to cancel an in-flight `dns.lookup`, so the
 * losing promise stays pending and keeps its threadpool slot; only the timer is
 * cleaned up here. Keeping the number of abandoned lookups bounded, while still
 * allowing a later one to succeed, is the caller's job — see `resolveOnce`.
 */
async function withLookupTimeout(
  pending: Promise<string[]>,
  hostname: string,
  timeoutMs: number,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup for ${hostname} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  options: {
    lookup?: IPv4Lookup;
    refreshIntervalMs?: number;
    lookupTimeoutMs?: number;
    now?: () => number;
  } = {},
): Promise<PrinterTarget> {
  const lookup = options.lookup ?? lookupIPv4;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const intervalMs = options.refreshIntervalMs ?? 30_000;
  const now = options.now ?? Date.now;
  const addresses = new Set<string>(config.printerIp ? [config.printerIp] : []);
  let lastRefresh = config.printerIp ? now() : 0;
  let lastOnDemand = 0;
  let inFlight: Promise<void> | null = null;
  // `dns.lookup` cannot be aborted, so timing a caller out does not stop the
  // `getaddrinfo` behind it: that keeps a libuv threadpool slot until the OS
  // resolver gives up. Two failure modes sit either side of this, and the two
  // counters below exist to avoid both.
  //
  // Start a fresh lookup on every refresh and a wedged resolver parks a new
  // thread each time — once per interval, or ~1 Hz through `accepts()` — until
  // the four-thread pool shared with sharp's JPEG encode is full and page
  // encoding stalls. Never start a second one and a single wedged lookup pins
  // resolution forever: every later refresh joins a promise that will never
  // settle, so the address set can never change and only a restart recovers.
  //
  // So: `joinable` is the lookup callers may share, released as soon as the
  // *caller-facing* budget expires, which lets the next refresh try again.
  // `outstanding` counts lookups whose raw promise has still not settled, and
  // caps how many may be parked at once. The cap is a deliberate stop, not a
  // cure: past it we refuse to resolve until one settles, trading a stalled
  // refresh for a guaranteed-live threadpool. Two leaves half the default pool
  // for sharp.
  const MAX_OUTSTANDING_LOOKUPS = 2;
  let joinable: Promise<string[]> | null = null;
  let outstanding = 0;

  const resolveOnce = (): Promise<string[]> => {
    if (joinable) return joinable;
    if (outstanding >= MAX_OUTSTANDING_LOOKUPS) {
      return Promise.reject(
        new Error(
          `${outstanding} DNS lookups for ${config.printerHostname} are still unsettled — ` +
            `not starting another until one completes`,
        ),
      );
    }

    const started = lookup(config.printerHostname!);
    outstanding++;
    void started
      .finally(() => {
        outstanding--;
      })
      .catch(() => {
        // Settlement is the awaiter's business; this arm only keeps the
        // bookkeeping from surfacing as an unhandled rejection.
      });

    const timed = withLookupTimeout(started, config.printerHostname!, lookupTimeoutMs);
    joinable = timed;
    void timed
      .finally(() => {
        if (joinable === timed) joinable = null;
      })
      .catch(() => {});
    return timed;
  };

  const refresh = async (force = false): Promise<void> => {
    if (config.printerIp || (!force && now() - lastRefresh < intervalMs)) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const resolved = new Set(
          (await resolveOnce()).map((a) => normalizeIPv4(a)).filter((a): a is string => a !== null),
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
        // stale set.
        // Both arms stamp the throttle, because both end with a just-completed
        // resolution: without stamping the join, a peer arriving right after
        // the joined refresh finishes would immediately force a second lookup.
        // The throttled-out path deliberately does not stamp, so a spray of
        // unknown peers can't keep pushing the window forward and starve a
        // genuine new address of its refresh.
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
