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

/**
 * Plain-TCP probe: connect, then wait for an inbound IS frame. ET-2750
 * sends an unsolicited `0x8000` welcome packet (5-byte payload)
 * immediately after the TCP handshake completes. WF-3620 doesn't send
 * anything until it receives `ESC @` — so on a legacy printer this
 * probe times out, returns false, and the caller falls through to the
 * legacy probe. (ET-4950 also sends a welcome immediately, but only
 * inside its TLS tunnel; this plain-TCP arm doesn't see it — connecting
 * to an ET-4950 over plain TCP yields no `0x8000` and the arm times
 * out, so this arm matches ET-2750-class hardware only.)
 *
 * Returns true if a `0x8000` IS frame is observed within `timeoutMs`,
 * false otherwise (timeout, connection refused, peer RST, or any other
 * inbound type). Only the IS magic and type field are validated; the
 * offset-4 data-offset byte is `0x300C` on the printer side for both
 * ET-2750 and ET-4950 (host-side is always `0x000C`), so it carries no
 * disambiguating signal and the parser ignores it.
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
      if (recvBytes < 12) return; // need full IS header before deciding
      const head = recvChunks.length === 1 ? recvChunks[0] : Buffer.concat(recvChunks, recvBytes);
      const isMagic = head[0] === 0x49 && head[1] === 0x53;
      const type = head.readUInt16BE(2);
      const isWelcome = isMagic && type === 0x8000;
      settle(isWelcome, () => {
        clearTimeout(timer);
        socket.destroy();
        if (!isWelcome) {
          const typeHex = `0x${type.toString(16).padStart(4, "0")}`;
          log.debug(
            `Plain-esci2 probe got non-welcome packet from ${host}:${port}: magic=${isMagic} type=${typeHex}`,
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
