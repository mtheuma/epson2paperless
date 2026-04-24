#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseIsPacket } from "../../src/protocol.js";

export interface CaptureRecord {
  ts: string;
  hook: "send" | "recv" | "async_event" | "error" | "startup";
  // Present on send/recv/async_event records. Absent on startup/error.
  type_hex?: string;
  payload_hex?: string;
  payload_size?: number;
  // Present on error records (agent-side exception) or startup records (agent load info).
  msg?: string;
  module_base?: string;
  send_addr?: string;
  recv_addr?: string;
}

const TYPE_LABELS: Record<string, string> = {
  "0x1000": "KeepAlive",
  "0x2000": "Passthru",
  "0x2100": "Lock",
  "0x2101": "Unlock",
  "0x2200": "StartScanning",
  "0x8000": "Welcome",
  "0x9000": "AsyncEvent",
  "0xa000": "PassthruReply",
  "0xa100": "LockAck",
};

const ASYNC_EVENT_LABELS: Record<number, string> = {
  0x01: "ScanStart",
  0x02: "Disconnect",
  0x03: "ScanCancel",
  0x04: "Stop",
  0x80: "Timeout",
  0xa0: "ServerError",
};

function dirLabel(hook: CaptureRecord["hook"]): string {
  switch (hook) {
    case "send":
      return "SEND";
    case "recv":
      return "RECV";
    case "async_event":
      return "ASYNC";
    case "error":
      return "ERROR";
    case "startup":
      return "STARTUP";
  }
}

function typeLabel(typeHex: string | undefined): string {
  if (!typeHex) return "";
  return TYPE_LABELS[typeHex.toLowerCase()] ?? "Unknown";
}

function asyncEventLabel(payloadHex: string): string {
  if (payloadHex.length < 2) return "";
  const byte = parseInt(payloadHex.slice(0, 2), 16);
  return ASYNC_EVENT_LABELS[byte] ?? `0x${byte.toString(16).padStart(2, "0")}`;
}

/**
 * Decode the ESC/I-2 command name from an IS payload of type 0x2000 / 0xa0XX.
 * The IS payload layout for passthru packets is:
 *   [4 bytes cmd_size BE][4 bytes reply_size BE][ESC/I-2 command (4-char name + "x" + 7 hex digits)...]
 * Returns the 4-char command name (trimmed) or "" if the payload is too short.
 */
function passthruCmdFromIsPayload(isPayload: Buffer): string {
  if (isPayload.length < 12) return "";
  return isPayload.subarray(8, 12).toString("ascii").trim();
}

export function formatRecord(record: CaptureRecord): string {
  const dir = dirLabel(record.hook);

  // Startup record: agent just loaded — print module base + hook addresses.
  if (record.hook === "startup") {
    return `[${record.ts}] ${dir} module_base=${record.module_base} send_addr=${record.send_addr} recv_addr=${record.recv_addr}`;
  }
  // Error record: agent-side exception. Just show the message.
  if (record.hook === "error") {
    return `[${record.ts}] ${dir} msg=${record.msg ?? ""}`;
  }

  // Send / recv / async_event records.
  const label = typeLabel(record.type_hex);
  const payloadHex = record.payload_hex ?? "";
  const short = payloadHex.length > 48 ? payloadHex.slice(0, 48) + "..." : payloadHex;
  const parts = [
    `[${record.ts}]`,
    dir,
    `type=${record.type_hex}`,
    `(${label})`,
    `size=${record.payload_size}`,
  ];

  // For Send/Recv records, payload_hex is the full IS packet (header + payload).
  // Use parseIsPacket to split so we see the inner payload for passthru decoding.
  if (record.hook === "send" || record.hook === "recv") {
    const typeHex = record.type_hex ?? "";
    if (typeHex === "0x2000" || typeHex.toLowerCase().startsWith("0xa0")) {
      const packetBuf = Buffer.from(payloadHex, "hex");
      const parsed = parseIsPacket(packetBuf);
      if (parsed) {
        const cmd = passthruCmdFromIsPayload(parsed.payload);
        if (cmd) parts.push(`cmd="${cmd}"`);
      }
    }
  }

  // AsyncEvent records carry the raw event payload (no IS header); first byte is the dispatch.
  if (record.hook === "async_event") {
    const evt = asyncEventLabel(payloadHex);
    if (evt) parts.push(`event=${evt}`);
  }

  parts.push(`payload=${short}`);
  return parts.join(" ");
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: tsx tools/frida-capture/pretty-print.ts <capture.jsonl>");
    process.exit(1);
  }
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed) as CaptureRecord;
    console.log(formatRecord(record));
  }
}

// Run main() only when executed directly, not when imported by tests.
// pathToFileURL handles Windows path → file URL conversion correctly.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
