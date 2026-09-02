import net from "node:net";
import { createLogger } from "./logger.js";
import { normalizeIPv4 } from "./network.js";

const log = createLogger("pushscan");

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
  return {
    pushScanId,
    jobNumber: getId("JobNumberIn"),
    productName: getId("ProductNameIn"),
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
}

export type PushScanPreResponseHook = (ctx: PushScanPreResponseContext) => Promise<void> | void;

export interface PushScanServerOptions {
  beforeResponse?: PushScanPreResponseHook;
  validatePeer?: (peerAddress: string) => Promise<boolean> | boolean;
}

/**
 * Creates a raw TCP server on the given port that handles POST /PushScan.
 * Uses net.createServer (not http) because Epson's protocol requires
 * non-standard header formatting with spaces before colons.
 */
export function createPushScanServer(
  port: number,
  onPushScan: PushScanCallback,
  options: PushScanServerOptions = {},
): net.Server {
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];

    let totalBytes = 0;
    let handled = false;
    const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");
    const peerAddress = normalizeIPv4(socket.remoteAddress ?? "");
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;

    log.debug(`Connection opened from ${peer}`);

    // Nothing below logs until a complete header block + body has arrived, so
    // a printer that connects and aborts (or sends a shape we never finish
    // parsing) would otherwise vanish without a trace — exactly the case
    // compatibility triage needs to see.
    socket.on("close", () => {
      if (handled) return;
      const buffered = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, totalBytes);
      log.debug(
        `Connection from ${peer} closed before a complete request arrived — ` +
          `${totalBytes} bytes received${
            totalBytes > 0
              ? `: ${buffered.subarray(0, 256).toString("hex")}${totalBytes > 256 ? "…" : ""}`
              : ""
          }`,
      );
    });

    socket.on("data", (chunk: Buffer) => {
      void (async () => {
        chunks.push(chunk);
        totalBytes += chunk.length;

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

        if (combined.length - bodyStart < contentLength) return; // Still waiting for body

        if (handled) return;
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

        if (!peerAddress) {
          log.warn(`Rejecting non-IPv4 push-scan peer ${peer}`);
          socket.destroy();
          return;
        }

        const sendResponse = (status: "OK" | "ERROR") => {
          // The pre-response hook can run for a few hundred ms (an out-of-band
          // job-control round-trip); if the printer closed the trigger socket
          // meanwhile, writing would error and onPushScan must not fire.
          if (socket.destroyed || socket.writableEnded) {
            log.warn(`Push-scan socket closed before ${kind} response could be sent`);
            return;
          }
          const response = buildPushScanResponse(xuid, {
            status,
            protocolVersion,
            capabilities: status === "OK" ? capabilities : [],
          });

          // Send the per-request response, then half-close the TCP socket (FIN)
          // so the printer sees a clean HTTP/1.0 close.
          socket.end(response, "utf-8", () => {
            log.debug(`Sent ${kind} response`);
            if (status !== "OK" || kind !== "pushScan") return;

            log.info(
              `Scan requested: product=${info.productName}, id=${info.pushScanId}, job=${info.jobNumber}`,
            );
            onPushScan(info, peerAddress);
          });
        };

        if (options.validatePeer && !(await options.validatePeer(peerAddress))) {
          log.warn(`Rejecting push-scan from unauthorized peer ${peerAddress}`);
          sendResponse("ERROR");
          return;
        }

        void (async () => {
          try {
            await options.beforeResponse?.({
              kind,
              headers,
              body,
              xuid,
              info,
              capabilities,
              peerAddress,
            });
          } catch (err) {
            log.error(`Pre-response hook failed for ${kind}`, err);
            sendResponse("ERROR");
            return;
          }

          sendResponse("OK");
        })();
      })();
    });

    socket.on("error", (err) => {
      log.error("PushScan socket error", err);
    });
  });

  server.listen(port, () => {
    log.info(`PushScan server listening on TCP port ${port}`);
  });

  return server;
}
