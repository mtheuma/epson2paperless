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
