---
status: accepted
---

# Capability-driven dialects, keyed by model identity; colour data stays capture-derived

Every ESC/I-2 printer used to need a hand-written registry entry keyed by a hash of its CAPA reply, so an unlisted model, or a known one whose firmware update changed that reply, failed outright. We now identify the model by its product ID (falling back to its product name, then to the CAPA fingerprint), take every capability field (sources, ADF duplex, optional PARA segments, PARA profile, back-page rotation, source detection) from the printer's own INFO, CAPA and STAT replies on every session, and give a printer with no model override a generic dialect: those derived fields plus a neutral colour pair, marked experimental. Model overrides shrink to what replies cannot tell us: a captured colour pair, a scan window, a poll count, and their provenance.

## Considered options

- **Ship Epson's colour tables, or values generated from them**, for exact per-model colour. Rejected: the data carries licence terms this MIT project would inherit, and keeping it current is ongoing work, for a fidelity gain the host-side post-processing mostly covers. Epson's published software and data may _inform_ our choices: triage of a reporter's printer, or deciding which already-captured colour class a new model most resembles. Nothing derived from it is committed, and provenance records such a choice as inheritance from the resembling model, never by Epson's own identifiers.
- **Keep the CAPA fingerprint as the primary key.** Rejected: it breaks on firmware updates and cannot name an unseen model. It stays as a fallback key, which keeps siblings that share a CAPA reply but whose product IDs are unknown working, and as a consistency check that warns and proceeds.
- **Allow overrides of capability-derived fields (an escape hatch).** Deliberately not offered. Every capability field agrees with the printer's own replies on every model we have evidence for, and an escape hatch would let per-model guesswork creep back in. When a printer's replies first turn out to be wrong, adding the hatch for that field is expected, not a mistake to undo.

## Consequences

- An unknown ESC/I-2 printer scans with neutral colour instead of failing, and the log says so. Printers the service does not support generically still fail with the diagnostic.
- Replay fixtures remain the oracle: a field moves from the override to derivation only once derivation reproduces the committed session bytes for every fixture model.
- A colour pair is chosen whole, as a neutral pair or an Epson-look pair, never mixed.
- A model can be verified on provisional colour evidence, an inherited setting expected to match but not yet confirmed on its hardware, with a README caveat until a reporter scan or capture supersedes it.
