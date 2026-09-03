import net from "node:net";
import tls from "node:tls";
import { createLogger } from "./logger.js";
import { IS_HEADER_SIZE } from "./protocol.js";
import { PID_ET7700, extractPid } from "./printer-ids.js";

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
  /**
   * The push-scan trigger's `ProductNameIn` ("PID XXXX"), when the dispatch
   * has one (panel-triggered scans; `scan:now` has no panel and passes null).
   * Consulted only after the TLS arm fails: PIDs in
   * `ESCI2_PLAIN_WITH_LEGACY_WELCOME` select `esci2-plain` directly, because
   * their welcome carries no signal. It never overrides a TLS result.
   */
  productName?: string | null;
}

/**
 * ESC/I-2-over-plain-TCP models whose plain-TCP welcome is byte-identical to
 * the legacy ESC/I one, making the payload[1] discriminator alone misclassify
 * them as `esci`. Keyed by the push-scan PID, which is per-model and already
 * pinned by the CAPA diagnostic that seeded each dialect entry. Exported for
 * the disjointness test against the legacy dialect registry — a PID in both
 * would silently shadow its legacy dialect under `auto`.
 *
 * ET-7700: both committed fixtures (`tools/pcap-extract/captures/et-7700/`)
 * open with `49538000300c0000000500000102000000` — the WF-3620's exact
 * welcome — while the model itself is ESC/I-2 (registry entry, issue #145,
 * hardware-validated). Its push-scan SOAP announces "PID 112B" (verified from
 * the reporter's pcap).
 */
export const ESCI2_PLAIN_WITH_LEGACY_WELCOME: ReadonlySet<string> = new Set([PID_ET7700]);

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
  // PID hint (see ESCI2_PLAIN_WITH_LEGACY_WELCOME): once TLS is ruled out,
  // the PID settles the variant directly — the welcome arm is skipped since
  // no outcome of it could change the routing. pushscan.ts already
  // canonicalises productName; re-extracting here is cheap defence for
  // direct callers.
  const pid = extractPid(opts.productName);
  if (pid !== null && ESCI2_PLAIN_WITH_LEGACY_WELCOME.has(pid)) {
    log.info(
      `${pid} is a known ESC/I-2 model whose welcome mimics the legacy one — ` +
        `selecting esci2-plain without welcome classification (PID hint)`,
    );
    return "esci2-plain";
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
 * offset 13). Real welcome payloads are `01 02 00 00 00` and
 * `01 04 00 00 00`; the discriminator is the second byte.
 *
 * `0x02` is seen from WF-3620 (all committed fixtures in
 * `tools/pcap-extract/captures/wf-3620/`) and XP-620 (issue #124, whose
 * welcome is byte-for-byte identical to the WF-3620's) — but ALSO from the
 * ET-7700, an ESC/I-2 model (issue #145; both committed fixtures open with
 * the WF-3620's exact welcome bytes). `0x04` is seen from ET-2750, XP-7100,
 * ET-4800, FF-680W and DS-575W. So the byte separates the families for most
 * models but is NOT a guaranteed family marker; known ESC/I-2 models that
 * present the legacy shape are routed by the push-scan PID hint instead
 * (`ESCI2_PLAIN_WITH_LEGACY_WELCOME` in `runProbe`). What the byte
 * *means* is unknown — it is treated purely as an observed marker, not a
 * decoded field.
 */
const LEGACY_ESCI_WELCOME_DISCRIMINATOR = 0x02;

/**
 * Plain-TCP probe: connect, then wait for an inbound IS-`0x8000` welcome
 * frame and classify the printer from its family discriminator. Both
 * generations emit a welcome unsolicited on TCP connect, so the welcome's
 * *presence* says only "plain TCP"; payload byte 1 says which family — for
 * most models (see the `LEGACY_ESCI_WELCOME_DISCRIMINATOR` caveat; hinted
 * PIDs are routed in `runProbe` and never reach this arm).
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

    // Bytes needed before the discriminator at payload[1] is readable: the
    // IS header, plus payload[0] and payload[1].
    const MIN_CLASSIFIABLE_BYTES = IS_HEADER_SIZE + 2;

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      recvChunks.push(chunk);
      recvBytes += chunk.length;
      // The welcome can arrive split across TCP segments — this family
      // demonstrably fragments IS frames — so accumulate until the
      // discriminator is readable rather than assuming one chunk.
      if (recvBytes < MIN_CLASSIFIABLE_BYTES) return;
      const head = recvChunks.length === 1 ? recvChunks[0] : Buffer.concat(recvChunks, recvBytes);
      const isMagic = head[0] === 0x49 && head[1] === 0x53;
      const type = head.readUInt16BE(2);
      const discriminator = head[IS_HEADER_SIZE + 1];

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
