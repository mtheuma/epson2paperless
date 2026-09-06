import net from "node:net";
import { createLogger } from "./logger.js";
import { normalizeIPv4 } from "./network.js";
import { extractPid } from "./printer-ids.js";

const log = createLogger("pushscan");

/**
 * Thrown from a `beforeResponse` hook to refuse a trigger on purpose (e.g.
 * another scan is already in flight, issue #137). The printer still gets the
 * protocol ERROR response and the callback never fires, but the refusal is
 * logged at WARN rather than as a hook failure.
 */
export class PushScanRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushScanRefusedError";
  }
}

const XML_NAMESPACE = "http://schema.epson.net/EpsonNet/Scan/2004/pushscan";

export type PushScanRequestKind = "jobList" | "pushScan" | "scanEnd" | "unknown";

function buildResponseBody(status: "OK" | "ERROR", capabilities: string[] = []): string {
  const capabilityLines = capabilities
    .map((capability) => `      <CapabilityOut>${capability}</CapabilityOut>\r\n`)
    .join("");
  return (
    `<?xml version="1.0" ?>\r\n` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">\r\n` +
    `  <s:Body>\r\n` +
    `    <p:PushScanResponse xmlns:p="${XML_NAMESPACE}">\r\n` +
    `      <StatusOut>${status}</StatusOut>\r\n` +
    capabilityLines +
    `    </p:PushScanResponse>\r\n` +
    `  </s:Body>\r\n` +
    `</s:Envelope>\r\n`
  );
}

// The printer sends an `x-uid` header in each push-scan request — a per-scan
// counter it increments and expects to see echoed back in our 200 OK. When
// the values mismatch, the printer surfaces "Scanning Error" on the panel
// even though the scan itself completes. See
// `docs/PROTOCOL-REFERENCE.md#push-scan-trigger-tcp-soap-ish`.
export interface PushScanResponseOptions {
  status?: "OK" | "ERROR";
  capabilities?: string[];
  /**
   * Value echoed in the `x-protocol-version` header. The printer sends its own
   * version in the request (`2.00` for the ESC/I-2 + legacy fleet, `3.00` for
   * the FF-680W's NetScanMonitor v3) and we mirror it back. Defaults to `2.00`
   * — the verified value for every model that predates the FF-680W — so a
   * request without the header (or an unknown caller) reproduces the original
   * behaviour rather than advertising v3 to a v2 device.
   */
  protocolVersion?: string;
}

export function buildPushScanResponse(xuid: string, opts: PushScanResponseOptions = {}): string {
  const body = buildResponseBody(opts.status ?? "OK", opts.capabilities ?? []);
  const bodyLength = Buffer.byteLength(body, "utf-8");
  const headers =
    `HTTP/1.0 200 OK\r\n` +
    `Server : Epson Net Scan Monitor/2.0\r\n` +
    `Content-Type : application/octet-stream\r\n` +
    `Content-Length : ${bodyLength}\r\n` +
    `x-protocol-name : Epson Network Service Protocol\r\n` +
    `x-protocol-version : ${opts.protocolVersion ?? "2.00"}\r\n` +
    `x-uid : ${xuid}\r\n` +
    `x-status : 0001\r\n`;
  return headers + "\r\n" + body;
}

export type PushScanAction = "jpg" | "pdf" | "preview" | "unknown";

export interface PushScanInfo {
  pushScanId: string | null;
  jobNumber: string | null;
  productName: string | null;
  ipAddress: string | null;
  /**
   * True when the printer panel's Sides selection is 2-Sided. Derived from
   * the first character of PushScanIDIn — '0' = 1-Sided, '1' = 2-Sided.
   * Any missing / malformed value defaults to false (safer to under-scan
   * than emit a duplex PARA the user didn't ask for). The encoding was
   * established empirically from three captured scans (1-sided, 2-sided,
   * and a confirmation run).
   *
   * Meaningful only when the printer is in ADF mode. Flatbed scans always
   * physically produce a single side regardless of this value — the scanner
   * auto-detects source via the first @STAT reply and ignores `duplex` in
   * that branch.
   */
  duplex: boolean;
  action: PushScanAction;
}

/** Simple regex-based extraction from the SOAP body — no XML parser needed. */
export function parsePushScanRequest(body: string): PushScanInfo {
  const getId = (tag: string) => {
    const match = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match ? match[1] : null;
  };
  const pushScanId = getId("PushScanIDIn");
  const duplex = computeDuplexFromId(pushScanId);
  const action = computeActionFromId(pushScanId);
  // Canonicalise the PID token here, at the single parse point, so every
  // downstream consumer (dialect resolution, job-control routing, the probe's
  // PID hint) sees the same `PID XXXX` form regardless of firmware
  // casing/spacing. A value with no PID token passes through raw, keeping
  // unknown models diagnosable in the logs.
  const rawProductName = getId("ProductNameIn");
  return {
    pushScanId,
    jobNumber: getId("JobNumberIn"),
    productName: extractPid(rawProductName) ?? rawProductName,
    ipAddress: getId("IPAddressIn"),
    duplex,
    action,
  };
}

export function parsePushScanRequestKind(body: string): PushScanRequestKind {
  if (/<(?:\w+:)?JobList(?:\s|>)/.test(body)) return "jobList";
  if (/<(?:\w+:)?PushScan(?:\s|>)/.test(body)) return "pushScan";
  if (/<(?:\w+:)?ScanEnd(?:\s|>)/.test(body)) return "scanEnd";
  return "unknown";
}

export function parseCapabilityIns(body: string): string[] {
  return Array.from(
    body.matchAll(/<(?:\w+:)?CapabilityIn>([^<]*)<\/(?:\w+:)?CapabilityIn>/g),
    (match) => match[1],
  );
}

/**
 * Classifies a PushScanIDIn value as simplex (false) or duplex (true).
 *   - null (tag absent)      → false, silent — the field is genuinely missing.
 *   - empty string           → false, warn  — tag present but empty: malformed.
 *   - first char '0'         → false, silent.
 *   - first char '1'         → true,  silent.
 *   - any other first char   → false, warn  — unexpected encoding.
 */
function computeDuplexFromId(id: string | null): boolean {
  if (id === null) return false;
  if (id.length === 0) {
    log.warn("PushScanIDIn is empty — treating as simplex");
    return false;
  }
  const first = id[0];
  if (first === "0") return false;
  if (first === "1") return true;
  log.warn(
    `Unexpected PushScanIDIn first character '${first}' (full value '${id}') — treating as simplex`,
  );
  return false;
}

/**
 * Classifies the second character of `PushScanIDIn` as the Action bit.
 * The printer encodes Action as a bitmask on char 1:
 *   '1' (0b001) → jpg
 *   '2' (0b010) → pdf
 *   '4' (0b100) → preview
 * Anything else — including missing input, single-char input, or bit
 * combinations like '3' (0b011) — returns 'unknown' with a warning log.
 */
export function computeActionFromId(id: string | null): PushScanAction {
  if (id === null) return "unknown";
  if (id.length < 2) {
    if (id.length > 0) {
      log.warn(`PushScanIDIn too short to decode action ('${id}') — treating as unknown`);
    }
    return "unknown";
  }
  const second = id[1];
  if (second === "1") return "jpg";
  if (second === "2") return "pdf";
  if (second === "4") return "preview";
  log.warn(
    `Unexpected PushScanIDIn second character '${second}' (full value '${id}') — treating as unknown action`,
  );
  return "unknown";
}

/**
 * Resolves the panel's raw action against the PREVIEW_ACTION config.
 * Returns the format the scanner should actually use, or null when the
 * push-scan event should be skipped entirely (no TLS session, nothing
 * written to disk).
 */
export function resolveEffectiveAction(
  action: PushScanAction,
  previewAction: "reject" | "jpg" | "pdf",
): "jpg" | "pdf" | null {
  if (action === "jpg" || action === "pdf") return action;
  if (action === "preview") {
    if (previewAction === "reject") return null;
    return previewAction;
  }
  // action === "unknown" — refuse to guess
  return null;
}

export type PushScanCallback = (info: PushScanInfo, peerAddress: string) => void;

export interface PushScanPreResponseContext {
  kind: PushScanRequestKind;
  headers: string;
  body: string;
  xuid: string;
  info: PushScanInfo;
  capabilities: string[];
  peerAddress: string;
  /**
   * Hand the server the hook that drops this trigger's admission reservation
   * (see {@link PushScanReleaseHook}). Call it as soon as the slot is
   * reserved, not when the hook returns: the server then owns the release for
   * every way the trigger can end, including the hook itself throwing.
   */
  onAbandon: (release: PushScanReleaseHook) => void;
}

/**
 * Handed to the server through `ctx.onAbandon` by a `beforeResponse` hook that
 * reserved the scan slot for this trigger (issue #137). The server calls it if
 * the trigger ends without the `onPushScan` callback running — socket closed
 * while the hook was pending, response not deliverable, ERROR response, or a
 * non-PushScan kind — so a reservation can never outlive the trigger that took
 * it. It fires only once the response has flushed or the socket has closed,
 * never mid-response: one-shot exits as soon as an admitted trigger is
 * abandoned (issue #202), and the printer must have its ERROR by then. Never
 * called once the callback has fired: from then on the callback owns the slot.
 */
export type PushScanReleaseHook = () => void;

export type PushScanPreResponseHook = (ctx: PushScanPreResponseContext) => Promise<void> | void;

/**
 * Cap on bytes buffered per connection, headers plus body. A real request is
 * under 2 KB (a FF-680W JobList with its CapabilityIn list is the largest
 * seen), so this is generous while keeping the listener's memory use in the
 * peer's hands no longer than one small read.
 */
export const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;

/**
 * How long a connection may stay silent before a complete request has
 * arrived. The printer writes its whole request immediately after connecting;
 * only a stalled or hostile peer sits idle.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

export interface PushScanServerOptions {
  beforeResponse?: PushScanPreResponseHook;
  validatePeer?: (peerAddress: string) => Promise<boolean> | boolean;
  /** Per-connection buffer cap in bytes. Default {@link DEFAULT_MAX_REQUEST_BYTES}. */
  maxRequestBytes?: number;
  /** Idle bound before a complete request. Default {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  idleTimeoutMs?: number;
}

/**
 * Creates a raw TCP server on the given port that handles POST /PushScan.
 * Uses net.createServer (not http) because Epson's protocol requires
 * non-standard header formatting with spaces before colons.
 *
 * Port 2968 binds all interfaces and is unauthenticated by design (the printer
 * has no host-side credential), so every bound here is enforced before the
 * peer can make us hold anything: the peer address is checked before a byte is
 * read, buffered bytes and the declared Content-Length are capped, and a
 * connection that never completes a request is closed after an idle timeout.
 */
export function createPushScanServer(
  port: number,
  onPushScan: PushScanCallback,
  options: PushScanServerOptions = {},
): net.Server {
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");

  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let handled = false;
    const peerAddress = normalizeIPv4(socket.remoteAddress ?? "");
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;

    // Admission hand-off (see PushScanReleaseHook). `callbackFired` marks the
    // point after which the reservation belongs to onPushScan's caller.
    let releaseAdmission: PushScanReleaseHook | undefined;
    let callbackFired = false;
    const abandonAdmission = (): void => {
      const release = releaseAdmission;
      releaseAdmission = undefined;
      release?.();
    };

    log.debug(`Connection opened from ${peer}`);

    socket.on("error", (err) => {
      log.error("PushScan socket error", err);
    });

    // Nothing below logs until a complete header block + body has arrived, so
    // a printer that connects and aborts (or sends a shape we never finish
    // parsing) would otherwise vanish without a trace — exactly the case
    // compatibility triage needs to see. `chunks` never exceeds the byte cap,
    // so the concat here is bounded.
    socket.on("close", () => {
      // The one signal that always fires: whatever path the trigger took, a
      // reservation not handed to the callback is dropped here at the latest.
      if (!callbackFired) abandonAdmission();
      if (handled) return;
      const prefix = Buffer.concat(chunks).subarray(0, 256);
      log.debug(
        `Connection from ${peer} closed before a complete request arrived — ` +
          `${totalBytes} bytes received${
            totalBytes > 0 ? `: ${prefix.toString("hex")}${totalBytes > 256 ? "…" : ""}` : ""
          }`,
      );
    });

    const drop = (reason: string, err?: unknown): void => {
      log.warn(`Dropping push-scan connection from ${peer}: ${reason}`, err);
      socket.destroy();
    };

    if (!peerAddress) {
      log.warn(`Rejecting non-IPv4 push-scan peer ${peer}`);
      socket.destroy();
      return;
    }

    // Armed before anything can wait, including peer validation below: the
    // stock validator may sit on a DNS refresh, which has no bound of its own,
    // and a paused socket does not even process a peer's FIN. The timer is
    // reset by socket activity, so a live request is never cut short by it.
    socket.setTimeout(idleTimeoutMs, () => {
      // A complete request whose response is still pending is our delay
      // (the beforeResponse job-control round-trip), not the peer's.
      if (handled && !socket.writableEnded) return;
      if (!handled) drop(`no complete request within ${idleTimeoutMs}ms`);
      else socket.destroy();
    });

    // Validate the kernel-observed peer before reading anything. The stock
    // validator may refresh DNS, so the socket stays paused (bytes wait in the
    // kernel, bounded by TCP flow control) until it answers; a rejected peer
    // gets no response, just a close.
    socket.pause();
    socket.on("data", onData);
    void (async () => {
      try {
        if (options.validatePeer && !(await options.validatePeer(peerAddress))) {
          log.warn(`Rejecting push-scan from unauthorized peer ${peerAddress}`);
          socket.destroy();
          return;
        }
      } catch (err) {
        drop("peer validation failed", err);
        return;
      }
      if (!socket.destroyed) socket.resume();
    })();

    function onData(chunk: Buffer): void {
      // A throw here would escape the 'data' emit as an uncaughtException and
      // take the daemon down; keep any parse failure to the one connection.
      try {
        handleChunk(chunk);
      } catch (err) {
        drop("request handling failed", err);
      }
    }

    function handleChunk(chunk: Buffer): void {
      if (handled) return; // Response in flight; anything more from the peer is noise.
      totalBytes += chunk.length;
      if (totalBytes > maxRequestBytes) {
        drop(`request exceeds ${maxRequestBytes} bytes`);
        return;
      }
      chunks.push(chunk);

      // Merge chunks into a single Buffer so indexOf / subarray can scan
      // across TCP fragment boundaries without re-decoding UTF-8 each event.
      const combined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes);
      if (chunks.length > 1) {
        chunks.length = 0;
        chunks.push(combined);
      }

      const headerEnd = combined.indexOf(HEADER_TERMINATOR);
      if (headerEnd === -1) return; // Still waiting for headers

      const headers = combined.subarray(0, headerEnd).toString("utf-8");
      const clMatch = headers.match(/Content-Length\s*:\s*(\d+)/i);
      const contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
      const bodyStart = headerEnd + HEADER_TERMINATOR.length;

      if (bodyStart + contentLength > maxRequestBytes) {
        drop(`declared Content-Length ${contentLength} exceeds the ${maxRequestBytes}-byte cap`);
        return;
      }
      if (combined.length - bodyStart < contentLength) return; // Still waiting for body

      handled = true;

      const body = combined.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
      log.info("Received PushScan request");
      log.debug("Request headers", headers);
      log.debug("Request body", body);

      const kind = parsePushScanRequestKind(body);
      const info = parsePushScanRequest(body);
      const capabilities = kind === "jobList" ? parseCapabilityIns(body) : [];

      // Echo the printer's x-uid into our response so the printer can
      // correlate our 200 OK with the scan it triggered. Falls back to "1"
      // if the header is missing (matches the pre-fix hardcoded value and
      // keeps existing tests working).
      const xuidMatch = headers.match(/x-uid\s*:\s*(\S+)/i);
      const xuid = xuidMatch ? xuidMatch[1] : "1";
      log.debug(`Echoing x-uid : ${xuid}`);

      // Mirror the printer's own protocol version (2.00 fleet / 3.00 FF-680W)
      // rather than advertising a fixed version to every device.
      const verMatch = headers.match(/x-protocol-version\s*:\s*(\S+)/i);
      const protocolVersion = verMatch ? verMatch[1] : "2.00";

      const sendResponse = (status: "OK" | "ERROR") => {
        // The pre-response hook can run for a few hundred ms (an out-of-band
        // job-control round-trip); if the printer closed the trigger socket
        // meanwhile, writing would error and onPushScan must not fire.
        if (socket.destroyed || socket.writableEnded) {
          log.warn(`Push-scan socket closed before ${kind} response could be sent`);
          abandonAdmission();
          return;
        }
        const response = buildPushScanResponse(xuid, {
          status,
          protocolVersion,
          capabilities: status === "OK" ? capabilities : [],
        });

        // Node invokes a `writable.end()` callback with an error — code
        // ERR_STREAM_DESTROYED — when the stream is destroyed before the write
        // flushes; the idle-timeout handler above and a peer reset both hit
        // that window. `@types/node` declares the callback as `() => void` and
        // omits the argument, so the type is written out here (an optional
        // parameter keeps it assignable to the declared signature).
        const onResponseWritten = (err?: Error | null): void => {
          if (err) {
            // The printer never got its response, so this trigger is not a
            // scan: no callback, and `callbackFired` stays false so the close
            // handler drops the reservation too (abandonAdmission is
            // idempotent).
            log.warn(`Push-scan ${kind} response could not be delivered`, err);
            abandonAdmission();
            return;
          }
          log.debug(`Sent ${kind} response`);
          if (status !== "OK" || kind !== "pushScan") {
            abandonAdmission();
            return;
          }

          log.info(
            `Scan requested: product=${info.productName}, id=${info.pushScanId}, job=${info.jobNumber}`,
          );
          callbackFired = true;
          onPushScan(info, peerAddress!);
        };

        // Send the per-request response, then half-close the TCP socket (FIN)
        // so the printer sees a clean HTTP/1.0 close.
        socket.end(response, "utf-8", onResponseWritten);
      };

      void (async () => {
        try {
          await options.beforeResponse?.({
            kind,
            headers,
            body,
            xuid,
            info,
            capabilities,
            peerAddress: peerAddress!,
            onAbandon: (release) => {
              releaseAdmission = release;
            },
          });
        } catch (err) {
          if (err instanceof PushScanRefusedError) {
            log.warn(`Refusing ${kind} from ${peer}: ${err.message}`);
          } else {
            log.error(`Pre-response hook failed for ${kind}`, err);
          }
          sendResponse("ERROR");
          return;
        }

        sendResponse("OK");
      })();
    }
  });

  server.listen(port, () => {
    log.info(`PushScan server listening on TCP port ${port}`);
  });

  return server;
}
