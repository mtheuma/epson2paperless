import { createHash } from "node:crypto";
import { splitHashSegments } from "./segments.js";

/**
 * Prefixes of CAPA segments that mutate between sessions on the same printer.
 * These carry scan counters / jam counts / page counts and must not affect
 * the dialect fingerprint. Prefix-match (not equality) — `#FB CNT...` and
 * `#FB CNTd...` both drop.
 *
 * Adding a prefix here is forward-compatible. Removing one changes existing
 * fingerprints and breaks every registry entry built before the removal.
 */
const VOLATILE_PREFIXES: readonly string[] = ["#ADFSCNT", "#ADFDCNT", "#ADFJAM", "#FB CNT"];

function isVolatile(segment: string): boolean {
  for (const prefix of VOLATILE_PREFIXES) {
    if (segment.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Compute the dialect fingerprint for a CAPA#1 reply body. Returns a 64-char
 * lowercase hex sha256.
 *
 * Steps:
 *   1. Split into `#`-prefixed segments.
 *   2. Drop volatile-prefix segments.
 *   3. Trim trailing ASCII whitespace per segment.
 *   4. Sort lexicographically.
 *   5. Concatenate, UTF-8 encode, sha256, hex-encode.
 */
export function computeCapaFingerprint(capaBody: Buffer): string {
  const segments = splitHashSegments(capaBody)
    .filter((s) => !isVolatile(s))
    .map((s) => s.trimEnd())
    .sort();
  const canonical = segments.join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
