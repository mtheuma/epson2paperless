// src/scan-trigger.ts
//
// Pure request logic for the POST /scan webhook (issue #137): bearer-token
// authorisation and query-parameter parsing. No sockets here — the HTTP
// routing lives in health.ts and the scan dispatch in index.ts, so this file
// can be unit-tested without a listener.
import { timingSafeEqual } from "node:crypto";

export type ScanFormat = "jpg" | "pdf";
export type ScanSides = "simplex" | "duplex";

export interface ScanTriggerRequest {
  format: ScanFormat;
  sides: ScanSides;
}

export interface ScanTriggerDefaults {
  scanFormat: ScanFormat;
  scanSides: ScanSides;
}

const FORMATS: readonly ScanFormat[] = ["jpg", "pdf"];
const SIDES: readonly ScanSides[] = ["simplex", "duplex"];

/**
 * True when `authHeader` is `Bearer <token>` for the configured token. The
 * scheme keyword is case-insensitive per RFC 6750; the token is compared
 * byte-for-byte in constant time once the lengths match (a length mismatch
 * is already a rejection, and leaks nothing an attacker can't infer from the
 * 401 itself).
 */
export function authorize(authHeader: string | undefined, token: string): boolean {
  if (!token || authHeader === undefined) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
  if (!match) return false;
  const presented = Buffer.from(match[1], "utf-8");
  const expected = Buffer.from(token, "utf-8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Resolves `format` and `sides` from the query string, falling back to the
 * panel-less defaults (`SCAN_FORMAT` / `SCAN_SIDES`) exactly as `scan:now`
 * does. Unknown keys are ignored; a present-but-invalid value (including the
 * empty string) is an error rather than a silent fallback.
 */
export function parseScanParams(
  query: URLSearchParams,
  defaults: ScanTriggerDefaults,
): ScanTriggerRequest | { error: string } {
  const format = pick(query, "format", FORMATS, defaults.scanFormat);
  if (typeof format === "object") return format;
  const sides = pick(query, "sides", SIDES, defaults.scanSides);
  if (typeof sides === "object") return sides;
  return { format, sides };
}

function pick<T extends string>(
  query: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T | { error: string } {
  if (!query.has(key)) return fallback;
  const value = query.get(key) ?? "";
  if ((allowed as readonly string[]).includes(value)) return value as T;
  return { error: `${key} must be one of ${allowed.join(", ")}` };
}
