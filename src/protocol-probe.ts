import net from "node:net";
import tls from "node:tls";
import { createLogger } from "./logger.js";

const log = createLogger("protocol-probe");

/**
 * Detected protocol variant. Three values:
 * - `esci2` — TLS on 1865 (ET-4950 family).
 * - `esci2-plain` — same ESC/I-2 vocabulary on plain TCP, no TLS (ET-2750).
 * - `esci` — legacy WF-3620 protocol on plain TCP.
 */
export type Variant = "esci2" | "esci2-plain" | "esci";
export type Override = "auto" | Variant;

export interface DetectOptions {
  printerIp: string;
  port: number;
  override: Override;
  timeoutMs: number;
}

const cache = new Map<string, Variant>();

export function resetCache(): void {
  cache.clear();
}

export async function detectVariant(opts: DetectOptions): Promise<Variant> {
  if (opts.override !== "auto") return opts.override;
  const cached = cache.get(opts.printerIp);
  if (cached) return cached;

  // Three-arm probe ordered by handshake aggressiveness — try the
  // protocols that don't mutate printer state first, fall back to the
  // ESC @ probe last.
  //   1. TLS handshake (port 1865).
  //   2. Plain TCP, listen for an unsolicited `0x8000` welcome (ET-2750
  //      sends one immediately on TCP connect; ET-4950 also does, but
  //      inside TLS, so it isn't reachable from this arm).
  //   3. Plain TCP, send `ESC @`, await ACK (legacy ESC/I init).
  const variant = await runProbe(opts);

  // Cache positive evidence only — and only for `esci2` (TLS). The
  // ECONNRESET / version-mismatch errors that classify as plain or
  // legacy can also be triggered by a transient network blip mid-
  // handshake against a real ET-4950. Caching that misclassification
  // would pin every subsequent scan to the wrong scanner. Plain-TCP
  // probes are cheap to re-run; self-heal on the next scan.
  if (variant === "esci2") {
    cache.set(opts.printerIp, variant);
  }
  log.info(`Detected protocol variant for ${opts.printerIp}: ${variant}`);
  return variant;
}

async function runProbe(opts: DetectOptions): Promise<Variant> {
  const { printerIp, port, timeoutMs } = opts;

  if (await probeTls(printerIp, port, timeoutMs)) {
    return "esci2";
  }
  if (await probePlainEsci2(printerIp, port, timeoutMs)) {
    return "esci2-plain";
  }
  if (await probeLegacyEsci(printerIp, port, timeoutMs)) {
    return "esci";
  }
  // No probe succeeded. Surface the last attempt's failure mode rather
  // than throwing a generic "no variant detected" error — keep the
  // diagnostic actionable. We classify as `esci` so the caller's
  // existing fallback path (which already tolerates connect failures)
  // runs and surfaces the underlying socket error.
  log.error(
    `All probes failed against ${printerIp}:${port}; assuming esci so the legacy scanner's connect path can surface the underlying error.`,
  );
  return "esci";
}

function probeTls(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: boolean, fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      resolve(result);
    };

    const socket = tls.connect({
      host,
      port,
      // We're only probing — accept any cert.
      rejectUnauthorized: false,
    });

    const timer = setTimeout(() => {
      settle(false, () => {
        socket.destroy();
        log.debug(`TLS probe timeout against ${host}:${port}`);
      });
    }, timeoutMs);

    socket.once("secureConnect", () => {
      settle(true, () => {
        clearTimeout(timer);
        socket.destroy();
      });
    });
    socket.once("error", (err: Error & { code?: string }) => {
      settle(false, () => {
        clearTimeout(timer);
        socket.destroy();
        log.debug(`TLS probe rejected by ${host}:${port}: ${err.code ?? err.message}`);
      });
    });
  });
}

/** WF-3620 family discriminator at IS-`0x8000` payload byte 1 (frame offset 13).
 * Stable across every committed WF-3620 fixture in
 * `tools/pcap-extract/captures/wf-3620/`; ET-2750 emits `0x04` here.
 * Real fixture payloads are `01 02 00 00 00` (WF-3620) and `01 04 00 00 00`
 * (ET-2750); the discriminator is the second byte. */
const WF3620_WELCOME_DISCRIMINATOR = 0x02;

/**
 * Plain-TCP probe: connect, then wait for an inbound IS-`0x8000` welcome
 * frame. Both ET-2750 and WF-3620 emit one unsolicited on TCP connect
 * (the original plan to use the welcome's *presence* as the ET-2750
 * signal turned out wrong — the WF-3620 emits one too). Disambiguates by
 * the welcome's payload byte 1: WF-3620 = `0x02`, ET-2750 = `0x04`. ET-4950
 * also sends a welcome immediately, but only inside its TLS tunnel; this
 * plain-TCP arm doesn't see it.
 *
 * Returns true on any `0x8000` welcome whose payload byte 1 is NOT the
 * WF-3620 marker; false on the WF-3620 marker, timeout, connection
 * refused, peer RST, or any other inbound type. The negative-form check
 * is deliberate: the WF-3620 byte is consistent across every committed
 * WF-3620 fixture, while we have only one ET-2750 capture, so the WF-3620
 * byte is the better-evidenced anchor. A future ET-2750-class device that
 * emits something other than `0x04` here is still accepted, as long as
 * it isn't the WF-3620 shape.
 */
function probePlainEsci2(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const recvChunks: Buffer[] = [];
    let recvBytes = 0;
    const settle = (result: boolean, fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      resolve(result);
    };

    const socket = net.connect(port, host);

    const timer = setTimeout(() => {
      settle(false, () => {
        socket.destroy();
        log.debug(`Plain-esci2 probe timeout against ${host}:${port} (no welcome packet)`);
      });
    }, timeoutMs);

    socket.once("error", (err: Error & { code?: string }) => {
      settle(false, () => {
        clearTimeout(timer);
        socket.destroy();
        log.debug(`Plain-esci2 probe rejected by ${host}:${port}: ${err.code ?? err.message}`);
      });
    });

    socket.on("data", (chunk: Buffer) => {
      recvChunks.push(chunk);
      recvBytes += chunk.length;
      // Need 12 bytes (IS header) + 2 payload bytes to read the
      // family-discriminator at payload[1] (frame offset 13).
      if (recvBytes < 14) return;
      const head = recvChunks.length === 1 ? recvChunks[0] : Buffer.concat(recvChunks, recvBytes);
      const isMagic = head[0] === 0x49 && head[1] === 0x53;
      const type = head.readUInt16BE(2);
      const discriminator = head[13];
      const isEsci2Welcome =
        isMagic && type === 0x8000 && discriminator !== WF3620_WELCOME_DISCRIMINATOR;
      settle(isEsci2Welcome, () => {
        clearTimeout(timer);
        socket.destroy();
        if (!isEsci2Welcome) {
          const typeHex = `0x${type.toString(16).padStart(4, "0")}`;
          const discHex = `0x${discriminator.toString(16).padStart(2, "0")}`;
          log.debug(
            `Plain-esci2 probe got non-esci2-welcome packet from ${host}:${port}: magic=${isMagic} type=${typeHex} payload[1]=${discHex}`,
          );
        }
      });
    });
  });
}

/**
 * Legacy plain-TCP probe: send `ESC @` (0x1b 0x40), await a 1-byte ACK
 * (0x06). Used after TLS and plain-esci2 probes have both failed —
 * anything still listening on plain TCP that responds to ESC @ with ACK
 * is a WF-3620-class device.
 *
 * Returns true on a clean ACK; false on any other reply, timeout, or
 * connection error.
 */
function probeLegacyEsci(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: boolean, fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      resolve(result);
    };

    const socket = net.connect(port, host);

    const timer = setTimeout(() => {
      settle(false, () => {
        socket.destroy();
        log.debug(`Legacy-esci probe timeout against ${host}:${port}`);
      });
    }, timeoutMs);

    socket.once("error", (err: Error & { code?: string }) => {
      settle(false, () => {
        clearTimeout(timer);
        socket.destroy();
        log.debug(`Legacy-esci probe rejected by ${host}:${port}: ${err.code ?? err.message}`);
      });
    });

    socket.once("connect", () => {
      socket.write(Buffer.from([0x1b, 0x40])); // ESC @
    });

    socket.on("data", (chunk: Buffer) => {
      const isAck = chunk.length >= 1 && chunk[0] === 0x06;
      settle(isAck, () => {
        clearTimeout(timer);
        socket.destroy();
        if (!isAck) {
          log.debug(
            `Legacy-esci probe got non-ACK reply from ${host}:${port}: byte0=0x${(chunk[0] ?? 0).toString(16)}`,
          );
        }
      });
    });
  });
}
