# Parameterised ESC/I-2 dialect refactor — design spec

**Status**: draft, awaiting review.
**Date**: 2026-05-27.
**Author**: Matt Theuma + Claude (`research/para-variation-analysis` branch).
**Position**: Spec 1 of 2 toward broader ESC/I-2 compatibility. **This spec does not change user-visible behaviour.** It refactors the existing per-printer-family dialect files into a parameterised composer driven by a typed registry, with all known printers' wire bytes byte-identical to today. Unknown-fingerprint auto-dispatch is deferred to Spec 2.

## TL;DR

Replace the four per-family `Dialect` objects (`et-4950-family.ts`, `et-2750.ts`, `xp-7100.ts`, `et-2950.ts`) and their hardcoded `buildPara*` functions with one parameterised composer (`composePara`) driven by a single typed registry. Each known printer's registry entry specifies every parameter (action axis, source axis, scan extents, GMM constant, named gamma class, named CMX class, optional-segment presence, dispatch metadata) explicitly — no derivation, no defaults. Replay tests against existing Frida/pcap fixtures pin the composer to byte-equivalent output. Unknown-fingerprint dispatch still throws `UnsupportedDialectError` as today; relaxing that is Spec 2's job.

## Why this exists, and why it's split

The original spec on this branch attempted both the refactor *and* unknown-fingerprint auto-dispatch in one design. Code review identified four load-bearing problems with the unknown-dispatch portion:

- The ParaSpec dropped the action axis, but XP-7100's PARA is action-aware (different gamma LUT + CMX bytes for JPG vs PDF — see `src/esci2/dialects/xp-7100.ts:209-230`). The composer must accept `action`.
- `#ACQ` extents are not derivable from INFO `#FB AREA`: all three known ESC/I-2 printers report `#FB AREAd850i0001170` in INFO yet emit different `#ACQ` values (ET-4950 2481×3506, ET-2750 2477×3500, XP-7100 2550×3300). Known entries need explicit extents; the encoding is not decoded.
- The "if CAPA has `#CMXLIST`, emit `#CMX` in PARA" auto-derivation rule is wrong: all three printers' CAPA reports `cmxList="UNITUM08"` but ET-4950's PARA omits `#CMX`. Optional-segment presence is empirically per-family, not predictable from CAPA tokens we currently understand.
- "Defaults for unknowns won't wedge the printer" generalises a four-test result on a single ET-4950 to all ESC/I-2 hardware. The empirical document itself flags this scope limitation (`.reference/research/dialect-analysis/empirical-tests.md:46-49`). Defaulting `initPollIterations=3` for unknowns specifically misclassifies any ET-2750-like plain-TCP flatbed-only printer, hard-failing at init-poll.

Each of these is fixable, but together they justify splitting the work. Spec 1 (this document) lands the composer architecture and the foundation for Spec 2 without changing what the wire emits or which printers are supported. Spec 2 will design the unknown-fingerprint dispatch path with its own empirical safety bar — at minimum, wrong-PARA-class tests on a second printer family before defaulting any auto-dispatch behaviour on.

The research that motivated the original spec is still valid for Spec 1's purpose — it proved the existing per-family builders are parameterisable into one composer with no loss of fidelity. The cross-printer segment-aware analysis (`.reference/research/dialect-analysis/FINDINGS.md`) maps directly onto the parameter set the composer needs.

## Goals

- **Known printers are byte-equivalent to today's wire output.** Existing replay tests (`src/esci2/scanner.test.ts` plus per-dialect test files) pass without fixture edits — they are the regression net.
- **Registry becomes data.** Adding a known printer (once we have its capture) becomes one entry in `registry.ts` plus, if novel, one entry each in `gamma-classes.ts` / `cmx-classes.ts`. No new per-printer TypeScript builder function.
- **Composer is pure.** `composePara(spec) → Buffer` takes a fully-resolved `ParaSpec` and returns bytes. No logging, no derivation, no defaults inside. Spec resolution (registry lookup → ParaSpec) is a separate, also-testable function.
- **The action axis is first-class.** XP-7100's per-action gamma/CMX variation drives the composer's API shape.

## Non-goals

- **Unknown-fingerprint dispatch.** `UnsupportedDialectError` stays. Unknown printers still fail at INIT1_CAPA exactly as today. Spec 2.
- **Legacy ESC/I (WF-3620 family).** Different protocol, different parameter block. `src/esci/` is untouched.
- **`SCAN_PROFILE` user knob.** Identified in research as a future improvement (gamma-curve choice affects text-doc readability); separate spec.
- **CAPA/INFO-driven auto-derivation of any field.** Every parameter for every known printer is pinned in its registry entry. No fallbacks, no defaults.

## Design

### 1. Architecture

One new module:

```ts
// src/esci2/para-composer.ts

export interface ParaSpec {
  source: "flatbed" | "adf-simplex" | "adf-duplex";
  action: "jpg" | "pdf";

  // Scan area extents — always explicit, never derived
  fbExtents:  Extents;
  adfExtents: Extents | null;        // null if printer has no ADF

  gmm: string;                       // 4-char ASCII, e.g. "UG10"

  // Per-action class IDs; the composer looks up the actual bytes from the
  // class tables in src/esci2/data/.
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass:   { jpg: CmxClassName | null; pdf: CmxClassName | null };

  optionalSegments: { qit: boolean; cct: boolean };
}

export interface Extents { x0: number; y0: number; w: number; h: number; }

export function composePara(spec: ParaSpec): Buffer;
```

The composer is the single source of truth for PARA byte layout. The existing hardcoded blobs (`buildParaAdf`, `buildParaFlatbedTls`, `buildParaFlatbedPlain`, and the inline tables in `xp-7100.ts` / `et-2950.ts`) are deleted; their bytes are reconstructed by the composer from each printer's registry entry.

Note on the union type: even for printers whose JPG and PDF PARA bodies are byte-identical (ET-4950, ET-2750), the `ParaSpec` still carries both keys — the composer picks the right one given `action`. For action-identical printers, both keys point at the same class name. For XP-7100, they point at different class names.

Two separate non-pure helpers — split because the graph engine needs the registry entry **before** PARA build (to read `sourceDetection` and `initPollIterations` during `INIT1_CAPA` and the init-poll cycles), and `makeParaSpec` runs later at PARA-build time:

```ts
// src/esci2/dialects/dispatch.ts

// Called at INIT1_CAPA, immediately after the CAPA fingerprint is computed.
// Throws UnsupportedDialectError on miss, identical timing/diagnostic to today.
// Result is stored on the scan-session context as ctx.entry for the rest of
// the session.
export function lookupRegistryEntry(
  fingerprint: string,
  capaBody: Buffer,
  infoBody: Buffer,
  transport: "tls" | "plain",
): RegistryEntry;

// Called at PARA-build time. Pure projection of a registry entry plus the
// runtime source/action axes onto a ParaSpec. No I/O, no logging.
export function makeParaSpec(
  entry: RegistryEntry,
  source: ParaSpec["source"],
  action: ParaSpec["action"],
): ParaSpec;

// Called immediately after lookupRegistryEntry at INIT1_CAPA. Pins
// ctx.source = "flatbed" when entry.sourceDetection is "fixed-flatbed".
// Replaces today's applyDialectSourceOverride at graph.ts:83.
export function applyEntrySourceOverride(ctx: Esci2Ctx, entry: RegistryEntry): void;
```

`lookupRegistryEntry` is where Spec 2 will plug in unknown-dispatch behaviour (return a synthesised entry instead of throwing). Spec 1 keeps the throw exactly as today.

### 2. Registry shape

```ts
// src/esci2/dialects/registry.ts

export interface RegistryEntry {
  displayName: string;

  // Dispatch metadata — used by the scan-session engine, not by the composer.
  sourceDetection: "stat-length" | "fixed-flatbed";
  initPollIterations: number;

  // PARA shape — every field required, no defaults.
  fbExtents: Extents;
  adfExtents: Extents | null;
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass:   { jpg: CmxClassName | null; pdf: CmxClassName | null };
  optionalSegments: { qit: boolean; cct: boolean };
}

export const REGISTRY: ReadonlyMap<string, RegistryEntry> = new Map([
  ["2fb08fc1bde6d172…", {
    displayName: "ET-4950 / ET-3950 / ET-4956 (ESC/I-2 over TLS)",
    sourceDetection: "stat-length",
    initPollIterations: 3,
    fbExtents:  { x0: 0,  y0: 0, w: 2481, h: 3506 },
    adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
    gmm: "UG10",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass:   { jpg: null,         pdf: null         },
    optionalSegments: { qit: true, cct: true },
  }],
  ["de76c9302793fa8f…", {
    displayName: "ET-2750 (ESC/I-2 over plain TCP)",
    sourceDetection: "fixed-flatbed",
    initPollIterations: 2,
    fbExtents:  { x0: 0, y0: 0, w: 2477, h: 3500 },
    adfExtents: null,
    gmm: "UG18",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass:   { jpg: "et2750-um08", pdf: "et2750-um08" },
    optionalSegments: { qit: false, cct: false },
  }],
  ["56d26c61896ca417…", {
    displayName: "XP-7100 (ESC/I-2 over plain TCP)",
    sourceDetection: "stat-length",
    initPollIterations: 3,
    fbExtents:  { x0: 0, y0: 0, w: 2550, h: 3300 },
    adfExtents: { x0: 0, y0: 0, w: 2550, h: 3300 },
    gmm: "UG18",
    gammaClass: { jpg: "xp7100-jpg", pdf: "xp7100-pdf" },
    cmxClass:   { jpg: "xp7100-jpg", pdf: "xp7100-pdf" },
    optionalSegments: { qit: true, cct: false },
  }],
  ["b1bf50879666d04c…", {       // ET-2950 — see src/esci2/dialects/et-2950.ts
    displayName: "ET-2950 (ESC/I-2 over TLS)",
    sourceDetection: "fixed-flatbed",
    initPollIterations: 3,
    fbExtents:  { x0: 0, y0: 0, w: 2481, h: 3506 },
    adfExtents: null,
    gmm: "UG10",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass:   { jpg: null,       pdf: null       },
    optionalSegments: { qit: true, cct: true },
  }],
]);
```

(Fingerprints abbreviated above; full 64-char hex in the actual file. `adfExtents` x0 differs between flatbed-origin and ADF-feed-origin — see `#ACQ` analysis in `FINDINGS.md`.)

Named class definitions in small data files:

- `src/esci2/data/gamma-classes.ts` — maps `GammaClassName` → 3 × 256-byte gamma LUT bytes.
- `src/esci2/data/cmx-classes.ts` — maps `CmxClassName` → 24-byte `#CMX…` segment bytes.

Initial named classes (extracted from current dialect files / fixtures):

- **gamma**: `et4950-stock` (the captured 3-channel LUT shared by ET-4950 + ET-2750, reused by ET-2950), `xp7100-jpg`, `xp7100-pdf`.
- **cmx**: `et2750-um08`, `xp7100-jpg`, `xp7100-pdf`.

Naming convention: a class is identified by `<printer-family-of-origin>-<axis>` where `axis` distinguishes action variants. The data file inlines each class as a hex literal — bytes are captured verbatim from a real-hardware fixture, never algorithmically generated.

A trap to call out for the implementer: the `et4950-stock` LUT is *not* a mathematical `[0..255]` identity LUT. The GRN channel happens to be sequential, but RED skips `0x14` and duplicates `0xc6`, and BLU duplicates `0x24` and skips `0xa6` — verified against `src/esci2/commands.ts:91-115` (current `buildParaFlatbedTls`). Hand-generating `Array.from({length: 256}, (_, i) => i)` for all three channels will produce wrong bytes and replay tests will fail. The class must be a verbatim hex literal transcribed from the existing builder.

There is no `et2950-*` class because ET-2950 has no captured wire fixture and just reuses ET-4950's bytes (matching `et-2950.ts:55`'s current `buildParaFlatbedTls()` reuse).

The classes are inlined Buffer hex literals — same shape as today's `buildParaAdf` body. The change is just structural: the bytes live in small named files instead of being interleaved into source-dispatching builder functions.

### 3. Composer behaviour

`composePara(spec)` assembles the PARA body in segment order. The order below covers all three current dialects: ET-4950 (`#QIT` + `#CCT`, no `#CMX`), ET-2750 (`#CMX` only), XP-7100 (`#CMX` + `#QIT`). Verified against the `FINDINGS.md` segment-offset tables — XP-7100 emits `#CMX` before `#QIT`, so the unified order has `#CMX` first among the optional segments.

1. Source segment — `#FB ` (4b, trailing space) | `#ADF` (4b) | `#ADFDPLX` (8b), chosen by `spec.source`.
2. `#RSM`, `#RSS`, `#COL`, `#FMT`, `#JPG` — fixed constants shared across all known printers (`i0000300`, `i0000300`, `C024`, `JPG `, `d090`). Hardcoded in the composer.
3. `#GMM` + 4 chars from `spec.gmm` (e.g. emits `#GMMUG10`).
4. Three `#GMT` segments (GRN/RED/BLU) — bytes pulled from the gamma class table keyed by `spec.gammaClass[spec.action]`.
5. `#CMX…` segment if `spec.cmxClass[spec.action]` is non-null, bytes from cmx-classes table.
6. `#QITOFF ` if `spec.optionalSegments.qit`, omitted otherwise.
7. `#CCTCOL ` if `spec.optionalSegments.cct`, omitted otherwise.
8. `#PAGd000` if `spec.source` is an ADF variant.
9. `#ACQ` segment encoding `fbExtents` or `adfExtents` per source (formatted as four `i%07d` ASCII integers).
10. `#BSZi1048576` — fixed constant.

Note on token spellings: every `#XXX` segment concatenates the 3-char key and its value bytes directly, no separator space. The trailing space inside `#QITOFF ` and `#CCTCOL ` is part of the value (`OFF ` and `COL ` are 4-char padded values), not a delimiter. The composer's literals must match this exactly or replay tests will fail.

Total body length depends on which optional segments are present; the caller's `buildParaHeader(body.length)` declares the size to the printer.

The composer validates its inputs:
- `gammaClass[action]` and `cmxClass[action]` names must exist in their data tables (throw at first scan if not).
- All extent values must be non-negative integers.
- If `spec.source` is `"adf-simplex"` or `"adf-duplex"` and `spec.adfExtents` is `null`, throw a clear error (e.g. `composePara: source=${spec.source} requires non-null adfExtents`). Preserves the flatbed-only guard that current `et-2750.ts:21` and `et-2950.ts:50` provide.

These are bug catchers, not graceful fallbacks.

### 4. Dispatch flow

Two distinct touch points in the graph state machine, matching today's:

**At `INIT1_CAPA`** (where the fingerprint is computed today):

1. Compute fingerprint (unchanged).
2. Call `lookupRegistryEntry(fingerprint, capaBody, infoBody, transport)`. Store the result on `ctx.entry`. On miss, throw `UnsupportedDialectError` with the existing diagnostic block — same byte-for-byte message, same timing.
3. Call `applyEntrySourceOverride(ctx, ctx.entry)` to pin `ctx.source = "flatbed"` for entries with `sourceDetection: "fixed-flatbed"`. This preserves the existing override (today: `applyDialectSourceOverride` at `graph.ts:83`), which the TLS scanner shell depends on — it pre-sets `ctx.source = "adf"` (`scanner.ts:67`) and expects the override to flip it for TLS flatbed-only printers (ET-2950). Without this step, an ET-2950 session would attempt ADF handling and hit the composer's flatbed-only guard.

**At PARA build** (`buildParaSend` in `graph.ts`):

```ts
const paraSource: ParaSpec["source"] =
  ctx.source === "flatbed" ? "flatbed"
  : ctx.duplex ? "adf-duplex"
  : "adf-simplex";
const spec = makeParaSpec(ctx.entry, paraSource, ctx.action);
return composePara(spec);
```

The call site translates the engine's two-axis (`ctx.source: "adf" | "flatbed"` × `ctx.duplex: boolean`, see `graph.ts:38-40`) representation into ParaSpec's three-value source axis. The encoding lives at the call site, not inside `makeParaSpec`, so `makeParaSpec` stays a pure projection of one entry + axes onto one ParaSpec.

The graph engine continues to read `ctx.entry.sourceDetection` (at `INIT_POLL_STAT_DRAIN` decision, currently `graph.ts:557`) and `ctx.entry.initPollIterations` (at `INIT_POLL_FIN`, currently `graph.ts:599`) for init-poll behaviour, unchanged in shape — the field names move from `ctx.dialect` to `ctx.entry`, otherwise identical.

`ctx.dialect` is renamed to `ctx.entry` throughout `Esci2Ctx` and the graph file. No other ctx changes.

No log lines change. No new env vars. No new error paths. From the user's perspective the service behaves identically.

### 5. Test strategy

**Tier 1 — Replay regression (the safety net)**.

`src/esci2/scanner.test.ts` and the four per-dialect test files (`et-4950-family.test.ts`, `et-2750.test.ts`, `xp-7100.test.ts`, `et-2950.test.ts`) keep replaying every committed fixture against the scanner. The PARA-body assertion (`extractScannerParaWrite` vs `extractCapturedParaBody`) keeps comparing byte-for-byte. The composer must reproduce each captured PARA exactly given the printer's registry entry + source + action. This is *the* proof the refactor doesn't regress.

The per-dialect test files survive the refactor essentially unchanged in shape; only the imports change (they now import `composePara` and the registry rather than per-family `Dialect` objects).

**Tier 2 — Composer + dispatch unit tests** (`src/esci2/para-composer.test.ts` and `src/esci2/dialects/dispatch.test.ts`, both new).

`composePara` (pure):
- **Source axis**: identical other params, source swap (FB ↔ ADF simplex ↔ ADF duplex) produces correct segment shape changes.
- **Action axis**: a spec with `xp7100-jpg` vs `xp7100-pdf` gamma classes produces the corresponding LUT bytes. Round-trip via the XP-7100 fixtures (asserted in Tier 1 but unit-covered here).
- **Optional segments**: explicit `qit: true/false`, `cct: true/false`, and `cmxClass[action]: null` vs non-null produce the expected presence/absence in the right order (`#CMX` → `#QIT` → `#CCT`).
- **GMM**: arbitrary 4-char string lands at the right offset.
- **Extents**: arbitrary `Extents` value renders to the right `#ACQ` ASCII bytes (four `i%07d` integers).
- **Gamma/CMX class lookup**: name → bytes mapping; unknown name throws with the expected error message.
- **Flatbed-only guard**: `source: "adf-simplex"` or `"adf-duplex"` with `adfExtents: null` throws a clear error.
- **Body length and `#BSZi1048576`**: the trailing constant is at the correct offset for every combination of optional segments.

`makeParaSpec` (pure projection):
- Given a fully-specified `RegistryEntry` + axes, returns a `ParaSpec` whose fields all derive from the entry. No defaults applied.
- Source axis picks `fbExtents` or `adfExtents` correctly (including `null` adfExtents → adf source = error in composer; pre-condition validated by composer, not by makeParaSpec).

`lookupRegistryEntry`:
- Hit → returns the entry from the table.
- Miss → throws `UnsupportedDialectError` with the existing diagnostic block. Same fields, same message format as today.

`applyEntrySourceOverride`:
- Entry with `sourceDetection: "fixed-flatbed"` and `ctx.source` starting as `"adf"` (TLS shell pre-set) → ctx.source becomes `"flatbed"`. Regression test for ET-2950's TLS-flatbed-only path.
- Entry with `sourceDetection: "stat-length"` → ctx.source unchanged. Regression test for the ET-4950 family path.

PARA-build call-site logic (`(ctx.source, ctx.duplex) → paraSource`):
- Covered by Tier 1 fixture replays (all three known printer × source combinations exercise the derivation).
- Add a small explicit test that confirms the mapping in isolation: `(adf, true) → "adf-duplex"`, `(adf, false) → "adf-simplex"`, `(flatbed, *) → "flatbed"`.

**No Tier 3 unknown-printer test in Spec 1.** The unknown path is unchanged (still throws), so there's nothing new to test on that axis. Spec 2 introduces this.

### 6. Error handling

`UnsupportedDialectError` is **preserved** with identical semantics. Its throw site moves from `dialect-registry.ts` into `dispatch.ts`. The diagnostic-block helper (`buildDiagnostic`) moves alongside it; same output shape.

New validation, all at first-scan-time:

- **Registry references unknown class name** (e.g. `gammaClass.jpg = "doesnt-exist"`): throw with `Registry entry for fingerprint X references undefined gammaClass "doesnt-exist"`. Developer error in the data; caught early.
- **Composer receives invalid `ParaSpec`** (negative extents, non-existent class name, ADF source with null `adfExtents`): throw with a clear message. Indicates a bug in `makeParaSpec` or in a registry entry.

Existing protocol/socket/lifecycle error paths are untouched.

### 7. Files and migration

**Deleted**:

- `src/esci2/dialects/et-4950-family.ts`
- `src/esci2/dialects/et-2750.ts`
- `src/esci2/dialects/xp-7100.ts`
- `src/esci2/dialects/et-2950.ts`
- `src/esci2/dialect-registry.ts`
- `buildParaAdf`, `buildParaFlatbedTls`, `buildParaFlatbedPlain` in `src/esci2/commands.ts`. The `buildParaHeader` and `buildEsci2Command` helpers stay.

**New**:

- `src/esci2/para-composer.ts` — `composePara` + `ParaSpec` type.
- `src/esci2/dialects/registry.ts` — `REGISTRY` map + `RegistryEntry` type.
- `src/esci2/dialects/dispatch.ts` — `lookupRegistryEntry` (called at INIT1_CAPA, throws `UnsupportedDialectError` on miss) + `applyEntrySourceOverride` (called immediately after, preserves today's `applyDialectSourceOverride` semantics for `fixed-flatbed` entries) + `makeParaSpec` (called at PARA build time, pure projection of entry + axes onto `ParaSpec`).
- `src/esci2/data/gamma-classes.ts` — named gamma LUT bytes.
- `src/esci2/data/cmx-classes.ts` — named CMX segment bytes.
- `src/esci2/diagnostic.ts` — `buildDiagnostic` helper (relocated, unchanged).

**Modified**:

- `src/esci2/graph.ts` — INIT1_CAPA handler calls `lookupRegistryEntry`, stores the result on `ctx.entry` (rename from `ctx.dialect`), and calls `applyEntrySourceOverride(ctx, ctx.entry)`; init-poll handlers read `ctx.entry.sourceDetection` and `ctx.entry.initPollIterations`; PARA build call site derives `paraSource` from `ctx.source` + `ctx.duplex` and calls `composePara(makeParaSpec(ctx.entry, paraSource, ctx.action))` (see Section 4 snippet). Other graph state untouched.
- `src/esci2/dialect.ts` — old `Dialect` interface removed or trimmed; the new types live in the new files.
- Per-dialect test files — imports updated to the new modules; assertion shape unchanged.

**Single PR, single release**. Refactor only. No env var. No staged rollout. The replay tests are the confidence that nothing changed on the wire.

User-facing changes:

- None to runtime behaviour. The compatibility table in `README.md` is unchanged.
- `docs/PROTOCOL-REFERENCE.md` "How printer-model differences are handled" section gets a structural update: replace per-family builder discussion with composer + registry shape. Note that the wire bytes for known printers are unchanged.

## Future work

### Spec 2 — unknown-fingerprint auto-dispatch

The original motivation for this work — the ET-4800 reporter on issue #80 — is not addressed by Spec 1. Spec 2 picks up that thread by making `lookupRegistryEntry` synthesise a best-effort `RegistryEntry` for unknown fingerprints instead of throwing. From there the existing pipeline (`makeParaSpec` → `composePara`) runs unchanged.

Open design questions Spec 2 needs to settle:

- **Empirical safety bar for default-on rollout.** The existing ET-4950 perturbation tests (`empirical-tests.md`) show four single-axis perturbations are accepted. Before defaulting auto-dispatch on, we want similar evidence from at least a second printer family (preferably ET-2750 since it's the closest non-trivially-different known model). Until that's done, Spec 2 likely ships behind a default-off opt-in.
- **Optional-segment presence**: not derivable from any CAPA token we currently understand (P2 #1 in the review). Spec 2 needs either a heuristic, a reverse-engineering pass on more captures, or an explicit registry-based "presence pattern" that auto-dispatch picks from.
- **Extents for unknown printers**: same situation — INFO `#FB AREA` doesn't predict `#ACQ`. Default could be the most common known value (ET-4950 extents), with a clear log line that scan area may be wrong.
- **Dispatch metadata defaults**: `sourceDetection` and `initPollIterations` need transport- and ADF-capability-conditioned defaults. ET-2750-class printers (plain TCP, flatbed-only, init-poll-2) must not silently get the ET-4950 defaults.
- **Failure-mode discovery**: what happens when a printer rejects PARA, hangs, or wedges. Currently untested on hardware other than ET-4950; needs a probe protocol that's safe to default on.

### Future enhancement — `SCAN_PROFILE` knob

The empirical-tests.md observation that GMM and gamma-LUT choice produced visibly different file sizes (Test 3 + Test 4 on the same test page) suggests that a user-selectable gamma profile could improve output for text-document scanning. Test 4's XP-7100-style curve produced higher-contrast text-on-white than the `et4950-stock` default. Out of scope for both Spec 1 and Spec 2; tracked as future enhancement.

## References

- **Research (gitignored, on this branch)**:
  - `.reference/research/dialect-analysis/FINDINGS.md` — cross-dialect PARA variation analysis across 11 capture sessions.
  - `.reference/research/dialect-analysis/empirical-tests.md` — four PARA-perturbation tests on ET-4950.
  - `.reference/research/dialect-analysis/extracted.json` — recovered PARA / CAPA / INFO bodies per fixture.
- **Issue trigger**: [#80 — Compatibility: ET-4800](https://github.com/mtheuma/epson2paperless/issues/80) (deferred to Spec 2; Spec 1 does not address this directly).
- **Current code touched**:
  - `src/esci2/dialects/{et-4950-family,et-2750,xp-7100,et-2950}.ts` — deleted.
  - `src/esci2/dialect-registry.ts` — replaced.
  - `src/esci2/commands.ts` — `buildParaAdf` / `buildParaFlatbedTls` / `buildParaFlatbedPlain` deleted.
  - `src/esci2/graph.ts` — PARA-build call site updated.
