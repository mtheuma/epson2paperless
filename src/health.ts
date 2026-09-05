import http from "node:http";
import { createLogger } from "./logger.js";
import { normalizeIPv4 } from "./network.js";
import {
  authorize,
  parseScanParams,
  type ScanTriggerDefaults,
  type ScanTriggerRequest,
} from "./scan-trigger.js";

const log = createLogger("health");

let lastScan: string | null = null;

/** Records when the most recent scan was *triggered* (panel or webhook) — not its outcome. */
export function setLastScanTime(time: string | null): void {
  lastScan = time;
}

/**
 * The caller's address as the push-scan path reports it: a dual-stack listener
 * (Node binds `::` when IPv6 is available, as on CI runners) presents IPv4
 * peers as `::ffff:a.b.c.d`, which is unmapped; native IPv6 passes through.
 */
export function peerAddressOf(remoteAddress: string | undefined): string {
  if (!remoteAddress) return "unknown";
  return normalizeIPv4(remoteAddress) ?? remoteAddress;
}

export interface ScanTriggerOptions {
  /** Shared secret; requests must send `Authorization: Bearer <token>`. */
  token: string;
  /** Panel-less fallbacks applied when the query omits format / sides. */
  defaults: ScanTriggerDefaults;
  /** True while a scan is in flight — the request is refused with 409. */
  isBusy: () => boolean;
  /**
   * Fire-and-forget dispatch. Evaluated in the same synchronous turn as
   * `isBusy`, so the caller must register the scan with the inflight tracker
   * before yielding (see index.ts) for the busy check to be race-free.
   */
  onScan: (request: ScanTriggerRequest, peerAddress: string) => void;
}

export interface HealthServerOptions {
  /** Enables `POST /scan` (issue #137). Omitted = the path is a plain 404. */
  scanTrigger?: ScanTriggerOptions;
}

export function createHealthServer(port: number, options: HealthServerOptions = {}): http.Server {
  const trigger = options.scanTrigger;

  const server = http.createServer((req, res) => {
    // Never read the body: /health has none and /scan takes its inputs from
    // the query string. Draining keeps an unread body from stalling the socket.
    req.resume();

    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { status: "ok", lastScan });
      return;
    }

    if (url.pathname === "/scan" && trigger) {
      handleScan(req, res, url, trigger);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    log.info(`Health check server listening on port ${port}`);
  });

  return server;
}

function handleScan(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  trigger: ScanTriggerOptions,
): void {
  const peer = peerAddressOf(req.socket.remoteAddress);

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    return;
  }
  if (!authorize(req.headers.authorization, trigger.token)) {
    log.warn(`Rejecting POST /scan from ${peer}: missing or invalid bearer token`);
    sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    return;
  }
  const parsed = parseScanParams(url.searchParams, trigger.defaults);
  if ("error" in parsed) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  if (trigger.isBusy()) {
    log.warn(`Refusing POST /scan from ${peer}: another scan is in flight`);
    sendJson(res, 409, { error: "a scan is already in progress" });
    return;
  }

  trigger.onScan(parsed, peer);
  sendJson(res, 202, { status: "accepted", format: parsed.format, sides: parsed.sides });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}
