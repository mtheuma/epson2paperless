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

  // Two-arm probe; neither mutates printer state.
  //   1. TLS handshake (port 1865).
  //   2. Plain TCP, listen for an unsolicited `0x8000` welcome and read its
  //      family discriminator (ET-2750 and WF-3620 both send one immediately
  //      on TCP connect; ET-4950 also does, but inside TLS, so it isn't
  //      reachable from this arm).
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
  const fromWelcome = await probePlainWelcome(printerIp, port, timeoutMs);
  if (fromWelcome) {
    return fromWelcome;
  }
  // Neither arm classified. Surface that rather than throwing a generic
  // "no variant detected" error — keep the diagnostic actionable. We
  // classify as `esci` so the caller's existing fallback path (which
  // already tolerates connect failures) runs and surfaces the underlying
  // socket error.
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
 * Legacy ESC/I family discriminator at IS-`0x8000` payload byte 1 (frame
 * offset 13). Real welcome payloads are `01 02 00 00 00` (legacy ESC/I) and
 * `01 04 00 00 00` (ESC/I-2); the discriminator is the second byte.
 *
 * Holds across every capture we have — `0x02` for WF-3620 (all committed
 * fixtures in `tools/pcap-extract/captures/wf-3620/`) and XP-620 (issue #124,
 * whose welcome is byte-for-byte identical to the WF-3620's); `0x04` for
 * ET-2750, XP-7100, ET-4800 and FF-680W. What the byte *means* is unknown —
 * it is treated purely as an observed family marker, not a decoded field.
 */
const LEGACY_ESCI_WELCOME_DISCRIMINATOR = 0x02;

/**
 * Plain-TCP probe: connect, then wait for an inbound IS-`0x8000` welcome
 * frame and classify the printer from its family discriminator. Both
 * generations emit a welcome unsolicited on TCP connect, so the welcome's
 * *presence* says only "plain TCP"; payload byte 1 says which family.
 * ET-4950 also sends a welcome immediately, but only inside its TLS tunnel,
 * so this arm never sees it.
 *
 * Returns the classified variant, or null when the connection yields no
 * usable evidence (timeout, connection refused, peer RST, or an inbound
 * frame that isn't a `0x8000` welcome).
 *
 * This arm is the only wire evidence we act on for plain TCP. There is no
 * follow-up "send `ESC @`, await a bare ACK" probe: real hardware accepts
 * only IS-framed commands, and only after a lock — in both the WF-3620 and
 * XP-620 captures every host write begins with the `IS` magic and `ESC @`
 * appears solely inside a `0x2000` passthru. An unframed `ESC @` therefore
 * models nothing the printer has ever been asked to answer.
 */
function probePlainWelcome(host: string, port: number, timeoutMs: number): Promise<Variant | null> {
  return new Promise((resolve) => {
    let settled = false;
    const recvChunks: Buffer[] = [];
    let recvBytes = 0;
    const settle = (result: Variant | null, fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      resolve(result);
    };

    const socket = net.connect(port, host);

    const timer = setTimeout(() => {
      settle(null, () => {
        socket.destroy();
        log.debug(`Plain-welcome probe timeout against ${host}:${port} (no welcome packet)`);
      });
    }, timeoutMs);

    socket.once("error", (err: Error & { code?: string }) => {
      settle(null, () => {
        clearTimeout(timer);
        socket.destroy();
        log.debug(`Plain-welcome probe rejected by ${host}:${port}: ${err.code ?? err.message}`);
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

      if (!isMagic || type !== 0x8000) {
        settle(null, () => {
          clearTimeout(timer);
          socket.destroy();
          const typeHex = `0x${type.toString(16).padStart(4, "0")}`;
          log.debug(
            `Plain-welcome probe got a non-welcome packet from ${host}:${port}: magic=${isMagic} type=${typeHex}`,
          );
        });
        return;
      }

      const variant: Variant =
        discriminator === LEGACY_ESCI_WELCOME_DISCRIMINATOR ? "esci" : "esci2-plain";
      settle(variant, () => {
        clearTimeout(timer);
        socket.destroy();
        const discHex = `0x${discriminator.toString(16).padStart(2, "0")}`;
        log.debug(
          `Plain-welcome probe classified ${host}:${port} as ${variant} from payload[1]=${discHex}`,
        );
      });
    });
  });
}
