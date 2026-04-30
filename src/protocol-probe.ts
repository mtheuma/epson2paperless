import tls from "node:tls";
import { createLogger } from "./logger.js";

const log = createLogger("protocol-probe");

export type Variant = "esci2" | "legacy";
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

  const variant = await probeTls(opts.printerIp, opts.port, opts.timeoutMs);
  // Cache positive evidence only. ECONNRESET — which classifies as "legacy" —
  // can also be triggered by a transient network blip mid-handshake against
  // a real ET-4950. Caching that misclassification would pin every subsequent
  // scan to the wrong scanner. Re-probing on each scan when the result is
  // "legacy" is cheap (real WF-3620 RSTs back fast), and self-heals once the
  // network blip clears.
  if (variant === "esci2") {
    cache.set(opts.printerIp, variant);
  }
  log.info(`Detected protocol variant for ${opts.printerIp}: ${variant}`);
  return variant;
}

function probeTls(host: string, port: number, timeoutMs: number): Promise<Variant> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const socket = tls.connect({
      host,
      port,
      // We're only probing — accept any cert.
      rejectUnauthorized: false,
    });

    const timer = setTimeout(() => {
      settle(() => {
        socket.destroy();
        log.error(`Probe timeout against ${host}:${port}`);
        reject(new Error(`protocol-probe timeout against ${host}:${port}`));
      });
    }, timeoutMs);

    socket.once("secureConnect", () => {
      settle(() => {
        clearTimeout(timer);
        socket.destroy();
        resolve("esci2");
      });
    });
    socket.once("error", (err: Error & { code?: string }) => {
      settle(() => {
        clearTimeout(timer);
        socket.destroy();
        if (err.code === "ERR_SSL_WRONG_VERSION_NUMBER" || err.code === "ECONNRESET") {
          resolve("legacy");
          return;
        }
        log.error(`Probe failed against ${host}:${port}: ${err.code ?? err.message}`);
        reject(err);
      });
    });
  });
}
