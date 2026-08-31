// Announced product IDs (the uppercased "PID XXXX" token the printer reports in
// its keepalive beacon and PushScan SOAP). Named here so the several behaviour
// sets keyed on them — v3 keepalive (keepalive.ts), job-control trigger flow
// (startup.ts), probe welcome-ambiguity hints (protocol-probe.ts) — reference
// one source of truth instead of re-typing the raw strings. Those sets stay
// separate on purpose: they are independent axes that only happen to share
// membership today (a future scanner could need one without the other).
// What's shared is the identifier, not the policy.
//
// The two below are the button-only DS-family scanners: the FastFoto FF-680W and
// its DS-575W document-scanner sibling.
export const PID_FF680W = "PID 016B";
export const PID_DS575W = "PID 0169";

// ET-7700 (A4 EcoTank Photo, ESC/I-2 over plain TCP — issue #145). Verified
// from the reporter's pcap: the push-scan SOAP carries
// `<ProductNameIn>PID 112B</ProductNameIn>`, matching the PRD in the CAPA
// diagnostic that seeded its dialect entry.
export const PID_ET7700 = "PID 112B";

/**
 * Extract and canonicalise the `PID XXXX` token from a wire-sourced string —
 * the SOAP `ProductNameIn` (pushscan.ts) or the latin1-decoded UDP
 * announcement (keepalive.ts). Tolerates prefix/hex casing and spacing
 * variance (each model's exact spelling is pinned by only one or two pcaps),
 * while the alphanumeric guards on both ends keep PID-shaped substrings
 * inside longer tokens ("RAPID 112B") and longer hex runs ("PID 112B7") from
 * matching. In the real announcement the token sits between a length byte and
 * a NUL, so the guards hold there too. Returns the canonical uppercase form,
 * or null when no PID token is present.
 */
export function extractPid(text: string | null | undefined): string | null {
  const match = text?.match(/(?<![0-9A-Za-z])PID\s*([0-9A-Fa-f]{4})(?![0-9A-Za-z])/i);
  return match ? `PID ${match[1].toUpperCase()}` : null;
}
