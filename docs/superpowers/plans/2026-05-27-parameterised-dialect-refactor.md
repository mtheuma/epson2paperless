# Parameterised ESC/I-2 dialect refactor — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four per-printer-family ESC/I-2 dialect files and their hardcoded `buildPara*` functions with a single parameterised composer driven by a typed registry, with byte-equivalent output for every currently-supported printer.

**Architecture:** Pure `composePara(spec)` function reads a `ParaSpec` and produces the PARA body bytes. `RegistryEntry` per fingerprint pins every parameter explicitly (no derivation, no defaults). Three small dispatch helpers (`lookupRegistryEntry`, `applyEntrySourceOverride`, `makeParaSpec`) replace today's dialect-object dispatch in the graph state machine. Replay tests against existing Frida/pcap fixtures are the regression net — they pass only if the composer reproduces today's captured PARA byte-for-byte.

**Tech Stack:** TypeScript, Vitest, Node Buffer (no external deps).

**Spec:** [docs/superpowers/specs/2026-05-27-broader-compatibility-design.md](../specs/2026-05-27-broader-compatibility-design.md)

---

## File-structure map

**Created**:
- `src/esci2/diagnostic.ts` — `buildDiagnostic` helper (relocated from `dialect-registry.ts`) + `UnsupportedDialectError`.
- `src/esci2/data/gamma-classes.ts` — named gamma-LUT byte sequences (`et4950-stock`, `xp7100-jpg`, `xp7100-pdf`).
- `src/esci2/data/cmx-classes.ts` — named CMX-segment byte sequences (`et2750-um08`, `xp7100-jpg`, `xp7100-pdf`).
- `src/esci2/para-composer.ts` — `composePara(spec)` + `ParaSpec` type + class-name unions + `Extents` type.
- `src/esci2/para-composer.test.ts` — composer unit tests (source/action/optional-segments/extents/validation).
- `src/esci2/dialects/registry.ts` — `REGISTRY` map + `RegistryEntry` type, with all four known printer entries.
- `src/esci2/dialects/dispatch.ts` — `lookupRegistryEntry`, `applyEntrySourceOverride`, `makeParaSpec`.
- `src/esci2/dialects/dispatch.test.ts` — dispatch unit tests.

**Modified**:
- `src/esci2/graph.ts` — `Esci2Ctx.dialect` → `Esci2Ctx.entry`; INIT1_CAPA handler swaps `lookupDialect` → `lookupRegistryEntry` + `applyEntrySourceOverride`; init-poll handlers reference `ctx.entry`; PARA-build call site derives `paraSource` and calls `composePara(makeParaSpec(...))`.
- `src/esci2/dialect.ts` — old `Dialect` interface trimmed/removed (the shape moves to `RegistryEntry`).
- `src/esci2/dialects/{et-4950-family,et-2750,xp-7100,et-2950}.test.ts` — assertions retargeted at the new registry entries + composer pipeline.
- `docs/PROTOCOL-REFERENCE.md` — "How printer-model differences are handled" section structurally updated.

**Deleted**:
- `src/esci2/dialects/et-4950-family.ts`
- `src/esci2/dialects/et-2750.ts`
- `src/esci2/dialects/xp-7100.ts`
- `src/esci2/dialects/et-2950.ts`
- `src/esci2/dialect-registry.ts`
- `buildParaAdf`, `buildParaFlatbedTls`, `buildParaFlatbedPlain` (in `src/esci2/commands.ts`).

---

## Test running commands

Reference for every task:

- Whole esci2 suite: `npx vitest run src/esci2/ --reporter=verbose`
- Specific file: `npx vitest run <path>`
- Lint: `npm run lint`
- Format check: `npm run format:check`

After each task's commit, run `npx vitest run src/esci2/` and confirm green before moving on.

---

### Task 1: Relocate `buildDiagnostic` + `UnsupportedDialectError` into `diagnostic.ts`

**Background**: `UnsupportedDialectError` currently lives in `src/esci2/dialect.ts:50` (NOT in `dialect-registry.ts`). `buildDiagnostic` lives in `src/esci2/dialect-registry.ts:34`. `graph.ts:324` and `dialect-registry.test.ts:7` both import the error from `dialect.ts`. The relocation must move the error from `dialect.ts` and the function from `dialect-registry.ts` to the new `diagnostic.ts`, with the original homes re-exporting so no caller breaks during this task.

**Files:**
- Create: `src/esci2/diagnostic.ts`
- Create: `src/esci2/diagnostic.test.ts` (move the buildDiagnostic tests here)
- Modify: `src/esci2/dialect.ts` (delete `UnsupportedDialectError` class body, re-export from diagnostic.ts)
- Modify: `src/esci2/dialect-registry.ts` (delete `buildDiagnostic` body, re-export from diagnostic.ts)
- Modify: `src/esci2/dialect-registry.test.ts` (delete the `describe("buildDiagnostic", …)` block + the `UnsupportedDialectError` standalone test — they move to diagnostic.test.ts; keep the lookup/registry tests for now)

**Steps:**

- [ ] **Step 1: Create the new module — copy `buildDiagnostic` VERBATIM from `dialect-registry.ts`**

The current `buildDiagnostic` (`src/esci2/dialect-registry.ts:34-72`) includes a `CCT list:` row and an `orAbsent` helper that distinguishes null tokens from empty-string tokens (a bare `#CCTLIST` parses to `""`, not `null`, and must still render as `(absent)` per the pinned tests in `dialect-registry.test.ts:84-114`). Copy the body verbatim:

```ts
// src/esci2/diagnostic.ts
import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";

/**
 * Thrown when a session lands on a printer whose CAPA fingerprint isn't
 * in the registry. Carries enough context for the user to file an issue
 * that the maintainer can act on.
 *
 * Relocated from dialect.ts to live next to the diagnostic-block renderer.
 * dialect.ts re-exports for backward compatibility.
 */
export class UnsupportedDialectError extends Error {
  constructor(
    public readonly capaFingerprint: string,
    public readonly diagnostic: string,
  ) {
    super(
      `Unsupported printer CAPA fingerprint ${capaFingerprint}. ` +
        `Please file an issue with the diagnostic block below:\n\n${diagnostic}`,
    );
    this.name = "UnsupportedDialectError";
  }
}

/**
 * Renders a copy-pasteable diagnostic block for the UnsupportedDialectError
 * raised when CAPA fingerprint doesn't resolve. Includes everything a
 * maintainer needs to add a new dialect or reproduce locally.
 *
 * Body relocated verbatim from dialect-registry.ts. Pinned tests in
 * diagnostic.test.ts (moved from dialect-registry.test.ts) assert the
 * exact rendering, including the `(absent)` treatment of bare LIST tokens.
 */
export function buildDiagnostic(args: {
  capaBody: Buffer;
  infoBody: Buffer;
  transport: "tls" | "plain";
  fingerprint: string;
}): string {
  const info = parseInfoTokens(args.infoBody);
  const capa = parseCapaTokens(args.capaBody);
  const transportLabel = args.transport === "tls" ? "esci2-tls" : "esci2-plain";
  // Source caps derived from segment presence:
  //   flatbed: any #FB ALGNxx or #FB AREA segment seen in INFO
  //   ADF:     any #ADFxxxx segment seen in INFO (#ADFAREA, #ADFTYPE, etc.)
  //   duplex:  CAPA contains #ADFDPLX
  const hasFlatbed = info.segments.some((s) => s.startsWith("#FB "));
  const hasAdf = info.segments.some((s) => s.startsWith("#ADF"));
  const hasDuplex = capa.adfDuplex;
  const yn = (v: boolean) => (v ? "Y" : "N");
  // Treat empty string as absent: a bare `#XXXLIST` (segment present, value
  // empty) parses to "" rather than null, but for at-a-glance reading the
  // diagnostic should still mark it as (absent). Matters most for CCT, where
  // present-vs-absent drives PARA-variant selection.
  const orAbsent = (s: string | null) => (s && s.length > 0 ? s : "(absent)");
  return [
    `CAPA fingerprint:  ${args.fingerprint}`,
    `PRD:               PID ${info.prdPid ?? "(absent)"}`,
    `Firmware:          ${info.firmware ?? "(absent)"}`,
    `Transport:         ${transportLabel}`,
    `Source caps:       flatbed: ${yn(hasFlatbed)}  ADF: ${yn(hasAdf)}  duplex: ${yn(hasDuplex)}`,
    `Scan area (FB):    ${info.fbArea ?? "(absent)"}`,
    `Scan area (ADF):   ${info.adfArea ?? "(absent)"}`,
    `GMM list:          ${orAbsent(capa.gmmList)}`,
    `CMX list:          ${orAbsent(capa.cmxList)}`,
    `QIT list:          ${orAbsent(capa.qitList)}`,
    `FMT list:          ${orAbsent(capa.fmtList)}`,
    `CCT list:          ${orAbsent(capa.cctList)}`,
    `INFO segments:     ${info.segments.length}`,
    `CAPA segments:     ${capa.segments.length}`,
  ].join("\n");
}
```

- [ ] **Step 2: Move the diagnostic-related tests to a new file**

Create `src/esci2/diagnostic.test.ts` with the exact contents of the `describe("buildDiagnostic", …)` block plus the standalone `UnsupportedDialectError` test from `dialect-registry.test.ts:41-121`. Update the imports at the top of the new file:

```ts
import { describe, it, expect } from "vitest";
import { buildDiagnostic, UnsupportedDialectError } from "./diagnostic.js";
```

Delete those same blocks (the `describe("buildDiagnostic", …)` and the `UnsupportedDialectError`-throw test) from `dialect-registry.test.ts`, plus the now-unused `buildDiagnostic` / `UnsupportedDialectError` imports there. Keep the lookup/registry describe blocks — they get deleted in Task 9.

- [ ] **Step 3: Make `dialect.ts` re-export from the new location**

Open `src/esci2/dialect.ts`. Delete the `export class UnsupportedDialectError` declaration (lines 50-61). Replace with:

```ts
export { UnsupportedDialectError } from "./diagnostic.js";
```

Leave the `Dialect` interface and `ParaAxes` interface in place — they're deleted in Task 9.

- [ ] **Step 4: Make `dialect-registry.ts` re-export `buildDiagnostic`**

Open `src/esci2/dialect-registry.ts`. Delete the `buildDiagnostic` function (lines 34-72) and the now-unused `parseCapaTokens` / `parseInfoTokens` imports at the top. Add:

```ts
export { buildDiagnostic } from "./diagnostic.js";
```

Leave `lookupDialect` and `DIALECTS` in place — they're deleted in Task 9.

- [ ] **Step 5: Run the test suite**

```
npx vitest run src/esci2/ --reporter=verbose
```

Expected: all 252 tests pass. The diagnostic block format is unchanged byte-for-byte, just its physical location moves. `UnsupportedDialectError` is exactly one class (now exported from diagnostic.ts, re-exported from dialect.ts) so `instanceof` checks in graph.ts and dialect-registry.test.ts still work.

- [ ] **Step 6: Lint + format**

```
npm run lint && npm run format:check
```

- [ ] **Step 7: Commit**

```
git add src/esci2/diagnostic.ts src/esci2/diagnostic.test.ts src/esci2/dialect.ts src/esci2/dialect-registry.ts src/esci2/dialect-registry.test.ts
git commit -m "refactor(esci2): extract buildDiagnostic + UnsupportedDialectError into diagnostic.ts"
```

---

### Task 2: Add `gamma-classes.ts` data module

**Files:**
- Create: `src/esci2/data/` (directory, doesn't exist yet)
- Create: `src/esci2/data/gamma-classes.ts`
- Create: `src/esci2/data/gamma-classes.test.ts`

The classes are 804-byte verbatim copies of the three concatenated `#GMT{GRN,RED,BLU} h100<256-byte LUT>` segments from existing builders. Source line ranges (in current code) to copy from:

- `et4950-stock` (used by ET-4950 family, ET-2750, ET-2950): lines 99–115 of `src/esci2/commands.ts` (the hex inside `buildParaFlatbedTls`'s `bodyHex`, starting at the byte sequence `23474d545245442068313030` for `#GMTRED h100`). The exact three segments span offsets 60..864 of the resulting 928-byte body — that is, bytes 60..328 (#GMTGRN), 328..596 (#GMTRED), 596..864 (#GMTBLU). Reuse the hex literal directly.
- `xp7100-jpg`: comes from XP-7100's captured flatbed-JPG body; the existing dialect file `src/esci2/dialects/xp-7100.ts` defines inlined per-source/per-action bodies — extract from the flatbed JPG body's bytes 60..864.
- `xp7100-pdf`: same offsets from XP-7100's PDF base body (also inlined in `xp-7100.ts`).

**Steps:**

- [ ] **Step 0: Create the `src/esci2/data/` directory**

Doesn't exist in the current tree. Create it before writing any file under it (the test file in Step 1 lives there, so this step must run first):

```bash
# Git Bash / cross-platform
mkdir -p src/esci2/data
```

PowerShell equivalent: `New-Item -ItemType Directory -Force src/esci2/data | Out-Null`.

- [ ] **Step 1: Write the failing tests first**

```ts
// src/esci2/data/gamma-classes.test.ts
import { describe, it, expect } from "vitest";
import { GAMMA_CLASSES, type GammaClassName } from "./gamma-classes.js";

describe("gamma-classes", () => {
  it("exposes et4950-stock with the expected size", () => {
    expect(GAMMA_CLASSES["et4950-stock"].length).toBe(804); // 3 × 268
  });

  it("et4950-stock starts with #GMTGRN h100 header", () => {
    expect(GAMMA_CLASSES["et4950-stock"].subarray(0, 12).toString("ascii")).toBe("#GMTGRN h100");
  });

  it("et4950-stock has #GMTRED h100 at offset 268", () => {
    expect(GAMMA_CLASSES["et4950-stock"].subarray(268, 280).toString("ascii")).toBe("#GMTRED h100");
  });

  it("et4950-stock has #GMTBLU h100 at offset 536", () => {
    expect(GAMMA_CLASSES["et4950-stock"].subarray(536, 548).toString("ascii")).toBe("#GMTBLU h100");
  });

  it("et4950-stock RED channel is NOT a strict [0..255] identity (skips 0x14)", () => {
    // RED LUT bytes start at offset 268 + 12 = 280. In a strict identity LUT
    // red[i] === i, so red[19] would be 0x13 and red[20] would be 0x14. The
    // captured fixture instead has red[19] = 0x13, red[20] = 0x15 — 0x14 is
    // skipped. This test pins the documented anomaly so a future regenerated
    // identity LUT doesn't silently break replay parity.
    const red = GAMMA_CLASSES["et4950-stock"].subarray(280, 280 + 256);
    expect(red[19]).toBe(0x13);
    expect(red[20]).toBe(0x15); // the 0x14 skip
  });

  it("xp7100-jpg has the same size as et4950-stock", () => {
    expect(GAMMA_CLASSES["xp7100-jpg"].length).toBe(804);
  });

  it("xp7100-jpg and xp7100-pdf differ", () => {
    expect(GAMMA_CLASSES["xp7100-jpg"].equals(GAMMA_CLASSES["xp7100-pdf"])).toBe(false);
  });

  it("class names enumerate as a type", () => {
    const _names: GammaClassName[] = ["et4950-stock", "xp7100-jpg", "xp7100-pdf"];
    expect(_names).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run src/esci2/data/gamma-classes.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Generate the data module via a one-shot extraction script**

The hex bytes are long (804 bytes × 3 classes = ~5KB) and copy-paste-prone to transcription errors. Instead, run a deterministic Node script that reads from the existing code + .bin fixtures and writes `gamma-classes.ts` directly. The `src/esci2/data/` directory does not exist yet — the script creates it. Run from the repo root:

```bash
npx tsx --eval '
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { buildParaFlatbedTls } from "./src/esci2/commands.ts";

mkdirSync("src/esci2/data", { recursive: true });

// ET-4950 stock — from the existing builder (which is what we are
// preserving byte-for-byte). 928-byte body, gamma is offsets 60..864.
const et4950 = buildParaFlatbedTls().subarray(60, 864).toString("hex");

// XP-7100 — from committed binary fixtures.
const xpJpg = readFileSync("src/esci2/dialects/xp-7100-fixtures/jpg-flatbed.bin")
  .subarray(60, 864).toString("hex");
const xpPdf = readFileSync("src/esci2/dialects/xp-7100-fixtures/pdf-single.bin")
  .subarray(60, 864).toString("hex");

// Sanity checks before writing.
for (const [name, hex] of [["et4950-stock", et4950], ["xp7100-jpg", xpJpg], ["xp7100-pdf", xpPdf]]) {
  if (hex.length !== 1608) throw new Error(`${name} extracted ${hex.length / 2} bytes, expected 804`);
}

const out = `// src/esci2/data/gamma-classes.ts
//
// AUTO-GENERATED-LITERAL data module. Hex bytes captured verbatim from:
//   - et4950-stock: buildParaFlatbedTls() in commands.ts, offsets 60..864.
//   - xp7100-jpg:   xp-7100-fixtures/jpg-flatbed.bin, offsets 60..864.
//   - xp7100-pdf:   xp-7100-fixtures/pdf-single.bin, offsets 60..864.
//
// Each class is the 804-byte sequence of three #GMT{GRN,RED,BLU} h100 segments.
//
// Important: the et4950-stock LUT is NOT a strict mathematical [0..255]
// identity — RED skips 0x14 and duplicates 0xc6; BLU duplicates 0x24 and
// skips 0xa6. These anomalies are present in the captured Frida fixture
// and replay tests pin them. Do not "fix" them.

export type GammaClassName = "et4950-stock" | "xp7100-jpg" | "xp7100-pdf";

export const GAMMA_CLASSES: Readonly<Record<GammaClassName, Buffer>> = {
  "et4950-stock": Buffer.from("${et4950}", "hex"),
  "xp7100-jpg":   Buffer.from("${xpJpg}", "hex"),
  "xp7100-pdf":   Buffer.from("${xpPdf}", "hex"),
};
`;

writeFileSync("src/esci2/data/gamma-classes.ts", out);
console.log("Wrote src/esci2/data/gamma-classes.ts");
'
```

The script runs through `tsx` so it imports directly from the TypeScript source — no need for a built `dist/`. It validates each hex length before writing and throws if anything is off. The resulting file has three Buffer.from() calls with the full 1608-character literals on a single line each.

Then run `npm run format` once so prettier line-wraps the long literals if desired (optional — `Buffer.from` doesn't care).

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run src/esci2/data/gamma-classes.test.ts
```

Expected: PASS (all 7 tests).

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/esci2/data/gamma-classes.ts src/esci2/data/gamma-classes.test.ts
git commit -m "feat(esci2): add gamma-classes data module"
```

---

### Task 3: Add `cmx-classes.ts` data module

**Files:**
- Create: `src/esci2/data/cmx-classes.ts`
- Create: `src/esci2/data/cmx-classes.test.ts`

CMX classes are 24-byte verbatim copies of the `#CMX…` segment. Sources:

- `et2750-um08`: from `buildParaFlatbedPlain()` in `commands.ts`. The 24 bytes are at offsets 864..888 of the 936-byte body. Hex: `23434d58554d303868303039200000002000000020000000` (ASCII: `#CMXUM08h009 \0\0\0 \0\0\0 \0\0\0`).
- `xp7100-jpg`: 24 bytes at offsets 864..888 of XP-7100's flatbed JPG body in `xp-7100.ts`.
- `xp7100-pdf`: 24 bytes at the same offsets of XP-7100's flatbed PDF body.

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
// src/esci2/data/cmx-classes.test.ts
import { describe, it, expect } from "vitest";
import { CMX_CLASSES, type CmxClassName } from "./cmx-classes.js";

describe("cmx-classes", () => {
  it("exposes et2750-um08 as a 24-byte segment", () => {
    expect(CMX_CLASSES["et2750-um08"].length).toBe(24);
  });

  it("et2750-um08 starts with #CMXUM08h009 ASCII", () => {
    expect(CMX_CLASSES["et2750-um08"].subarray(0, 12).toString("ascii")).toBe("#CMXUM08h009");
  });

  it("xp7100-jpg is 24 bytes and differs from et2750", () => {
    expect(CMX_CLASSES["xp7100-jpg"].length).toBe(24);
    expect(CMX_CLASSES["xp7100-jpg"].equals(CMX_CLASSES["et2750-um08"])).toBe(false);
  });

  it("xp7100-jpg and xp7100-pdf differ", () => {
    expect(CMX_CLASSES["xp7100-jpg"].equals(CMX_CLASSES["xp7100-pdf"])).toBe(false);
  });

  it("class names enumerate", () => {
    const _names: CmxClassName[] = ["et2750-um08", "xp7100-jpg", "xp7100-pdf"];
    expect(_names).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run src/esci2/data/cmx-classes.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Generate the data module via a one-shot extraction script**

Same pattern as Task 2. The `src/esci2/data/` directory was created in Task 2 — the `mkdirSync` call here is idempotent (recursive: true). Run from the repo root:

```bash
npx tsx --eval '
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

// ET-2750 #CMX is a fixed 24-byte literal — extract from buildParaFlatbedPlain
// to keep the script self-verifying.
import { buildParaFlatbedPlain } from "./src/esci2/commands.ts";

mkdirSync("src/esci2/data", { recursive: true });
const et2750 = buildParaFlatbedPlain().subarray(864, 888).toString("hex");

const xpJpg = readFileSync("src/esci2/dialects/xp-7100-fixtures/jpg-flatbed.bin")
  .subarray(864, 888).toString("hex");
const xpPdf = readFileSync("src/esci2/dialects/xp-7100-fixtures/pdf-single.bin")
  .subarray(864, 888).toString("hex");

for (const [name, hex] of [["et2750-um08", et2750], ["xp7100-jpg", xpJpg], ["xp7100-pdf", xpPdf]]) {
  if (hex.length !== 48) throw new Error(`${name} extracted ${hex.length / 2} bytes, expected 24`);
}

const out = `// src/esci2/data/cmx-classes.ts
//
// AUTO-GENERATED-LITERAL data module. Each class is the 24-byte #CMX...
// segment captured verbatim from:
//   - et2750-um08: buildParaFlatbedPlain() in commands.ts, offsets 864..888.
//   - xp7100-jpg:  xp-7100-fixtures/jpg-flatbed.bin, offsets 864..888.
//   - xp7100-pdf:  xp-7100-fixtures/pdf-single.bin, offsets 864..888.

export type CmxClassName = "et2750-um08" | "xp7100-jpg" | "xp7100-pdf";

export const CMX_CLASSES: Readonly<Record<CmxClassName, Buffer>> = {
  "et2750-um08": Buffer.from("${et2750}", "hex"),
  "xp7100-jpg":  Buffer.from("${xpJpg}", "hex"),
  "xp7100-pdf":  Buffer.from("${xpPdf}", "hex"),
};
`;

writeFileSync("src/esci2/data/cmx-classes.ts", out);
console.log("Wrote src/esci2/data/cmx-classes.ts");
'
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run src/esci2/data/cmx-classes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/esci2/data/cmx-classes.ts src/esci2/data/cmx-classes.test.ts
git commit -m "feat(esci2): add cmx-classes data module"
```

---

### Task 4: Create `para-composer.ts` skeleton with full failing test suite

**Files:**
- Create: `src/esci2/para-composer.ts`
- Create: `src/esci2/para-composer.test.ts`

This task writes ALL the composer's unit tests up front (the spec's Tier 2 list), with a stub implementation that throws. Subsequent tasks implement features incrementally to make these pass.

**Steps:**

- [ ] **Step 1: Write the skeleton module**

```ts
// src/esci2/para-composer.ts
import { GAMMA_CLASSES, type GammaClassName } from "./data/gamma-classes.js";
import { CMX_CLASSES, type CmxClassName } from "./data/cmx-classes.js";

export interface Extents {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface ParaSpec {
  source: "flatbed" | "adf-simplex" | "adf-duplex";
  action: "jpg" | "pdf";
  fbExtents: Extents;
  adfExtents: Extents | null;
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass: { jpg: CmxClassName | null; pdf: CmxClassName | null };
  optionalSegments: { qit: boolean; cct: boolean };
}

export function composePara(_spec: ParaSpec): Buffer {
  throw new Error("composePara: not implemented");
}

export type { GammaClassName, CmxClassName };
```

- [ ] **Step 2: Write the full test file**

```ts
// src/esci2/para-composer.test.ts
import { describe, it, expect } from "vitest";
import { composePara, type ParaSpec } from "./para-composer.js";

// A reusable baseline spec — ET-4950 flatbed JPG params. Tests override fields
// individually to isolate axes.
function baselineSpec(): ParaSpec {
  return {
    source: "flatbed",
    action: "jpg",
    fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
    gmm: "UG10",
    gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
    cmxClass: { jpg: null, pdf: null },
    optionalSegments: { qit: true, cct: true },
  };
}

function findSegmentOffset(body: Buffer, key: string): number {
  return body.indexOf(Buffer.from(key, "ascii"));
}

describe("composePara — source axis", () => {
  it("flatbed emits #FB  (4 bytes, trailing space) as the leading segment", () => {
    const body = composePara({ ...baselineSpec(), source: "flatbed" });
    expect(body.subarray(0, 4).toString("ascii")).toBe("#FB ");
  });

  it("adf-simplex emits #ADF (4 bytes, no trailing) as the leading segment", () => {
    const body = composePara({ ...baselineSpec(), source: "adf-simplex" });
    expect(body.subarray(0, 4).toString("ascii")).toBe("#ADF");
    // #ADFDPLX would be 8 bytes; simplex must NOT have the DPLX suffix.
    expect(body.subarray(0, 8).toString("ascii")).not.toBe("#ADFDPLX");
  });

  it("adf-duplex emits #ADFDPLX (8 bytes) as the leading segment", () => {
    const body = composePara({ ...baselineSpec(), source: "adf-duplex" });
    expect(body.subarray(0, 8).toString("ascii")).toBe("#ADFDPLX");
  });

  it("adf sources emit #PAGd000 (8 bytes); flatbed does not", () => {
    const flatbed = composePara({ ...baselineSpec(), source: "flatbed" });
    expect(findSegmentOffset(flatbed, "#PAG")).toBe(-1);
    const simplex = composePara({ ...baselineSpec(), source: "adf-simplex" });
    const dupl = composePara({ ...baselineSpec(), source: "adf-duplex" });
    for (const body of [simplex, dupl]) {
      const off = findSegmentOffset(body, "#PAG");
      expect(off).toBeGreaterThan(0);
      expect(body.subarray(off, off + 8).toString("ascii")).toBe("#PAGd000");
    }
  });
});

describe("composePara — action axis (gamma + CMX lookup)", () => {
  it("jpg uses spec.gammaClass.jpg bytes; pdf uses spec.gammaClass.pdf bytes", () => {
    const spec: ParaSpec = {
      ...baselineSpec(),
      gammaClass: { jpg: "et4950-stock", pdf: "xp7100-pdf" },
    };
    const jpg = composePara({ ...spec, action: "jpg" });
    const pdf = composePara({ ...spec, action: "pdf" });
    expect(jpg.equals(pdf)).toBe(false);
  });

  it("identical gamma class for both actions => same output ignoring CMX", () => {
    const spec = { ...baselineSpec() };
    const jpg = composePara({ ...spec, action: "jpg" });
    const pdf = composePara({ ...spec, action: "pdf" });
    expect(jpg.equals(pdf)).toBe(true);
  });

  it("cmxClass[action] = null omits the #CMX segment", () => {
    const body = composePara({
      ...baselineSpec(),
      cmxClass: { jpg: null, pdf: null },
    });
    expect(findSegmentOffset(body, "#CMX")).toBe(-1);
  });

  it("cmxClass[action] = 'et2750-um08' inserts the 24-byte CMX segment", () => {
    const body = composePara({
      ...baselineSpec(),
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
    });
    const off = findSegmentOffset(body, "#CMX");
    expect(off).toBeGreaterThan(0);
    expect(body.subarray(off, off + 12).toString("ascii")).toBe("#CMXUM08h009");
  });
});

describe("composePara — optional segments", () => {
  it("qit: false omits #QIT", () => {
    const body = composePara({
      ...baselineSpec(),
      optionalSegments: { qit: false, cct: false },
    });
    expect(findSegmentOffset(body, "#QIT")).toBe(-1);
  });

  it("qit: true emits #QITOFF (no space between key and value)", () => {
    const body = composePara({
      ...baselineSpec(),
      optionalSegments: { qit: true, cct: false },
    });
    const off = findSegmentOffset(body, "#QIT");
    expect(off).toBeGreaterThan(0);
    expect(body.subarray(off, off + 8).toString("ascii")).toBe("#QITOFF ");
  });

  it("cct: true emits #CCTCOL  (4-char value padded with trailing space)", () => {
    const body = composePara({
      ...baselineSpec(),
      optionalSegments: { qit: false, cct: true },
    });
    const off = findSegmentOffset(body, "#CCT");
    expect(off).toBeGreaterThan(0);
    expect(body.subarray(off, off + 8).toString("ascii")).toBe("#CCTCOL ");
  });

  it("segment order is #CMX before #QIT before #CCT (when all present)", () => {
    const body = composePara({
      ...baselineSpec(),
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      optionalSegments: { qit: true, cct: true },
    });
    const cmx = findSegmentOffset(body, "#CMX");
    const qit = findSegmentOffset(body, "#QIT");
    const cct = findSegmentOffset(body, "#CCT");
    expect(cmx).toBeLessThan(qit);
    expect(qit).toBeLessThan(cct);
  });
});

describe("composePara — extents (#ACQ rendering)", () => {
  it("renders fbExtents as four i%07d ASCII integers for flatbed", () => {
    const body = composePara({
      ...baselineSpec(),
      source: "flatbed",
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
    });
    const off = findSegmentOffset(body, "#ACQ");
    expect(off).toBeGreaterThan(0);
    expect(body.subarray(off, off + 36).toString("ascii")).toBe(
      "#ACQi0000000i0000000i0002481i0003506",
    );
  });

  it("renders adfExtents for ADF sources", () => {
    const body = composePara({
      ...baselineSpec(),
      source: "adf-simplex",
      adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
    });
    const off = findSegmentOffset(body, "#ACQ");
    expect(body.subarray(off, off + 36).toString("ascii")).toBe(
      "#ACQi0000069i0000000i0002481i0003506",
    );
  });

  it("renders 0-padded values up to 7 digits", () => {
    const body = composePara({
      ...baselineSpec(),
      fbExtents: { x0: 12345, y0: 6789, w: 100, h: 9999999 },
    });
    const off = findSegmentOffset(body, "#ACQ");
    expect(body.subarray(off, off + 36).toString("ascii")).toBe(
      "#ACQi0012345i0006789i0000100i9999999",
    );
  });
});

describe("composePara — GMM rendering", () => {
  it("renders #GMM + 4-char value (e.g. UG10)", () => {
    const body = composePara({ ...baselineSpec(), gmm: "UG10" });
    const off = findSegmentOffset(body, "#GMM");
    expect(body.subarray(off, off + 8).toString("ascii")).toBe("#GMMUG10");
  });

  it("renders different GMM constants distinctly (UG18)", () => {
    const body = composePara({ ...baselineSpec(), gmm: "UG18" });
    const off = findSegmentOffset(body, "#GMM");
    expect(body.subarray(off, off + 8).toString("ascii")).toBe("#GMMUG18");
  });
});

describe("composePara — trailing #BSZ constant", () => {
  it("emits #BSZi1048576 (12 bytes) as the last segment", () => {
    const body = composePara(baselineSpec());
    const tail = body.subarray(body.length - 12);
    expect(tail.toString("ascii")).toBe("#BSZi1048576");
  });
});

describe("composePara — fixed-constant segments", () => {
  it("emits #RSMi0000300, #RSSi0000300 in that order after the source segment", () => {
    const body = composePara(baselineSpec());
    const rsm = findSegmentOffset(body, "#RSM");
    const rss = findSegmentOffset(body, "#RSS");
    expect(rsm).toBeLessThan(rss);
    expect(body.subarray(rsm, rsm + 12).toString("ascii")).toBe("#RSMi0000300");
    expect(body.subarray(rss, rss + 12).toString("ascii")).toBe("#RSSi0000300");
  });

  it("emits #COLC024, #FMTJPG , #JPGd090 fixed constants", () => {
    const body = composePara(baselineSpec());
    expect(body.indexOf("#COLC024")).toBeGreaterThan(0);
    expect(body.indexOf("#FMTJPG ")).toBeGreaterThan(0);
    expect(body.indexOf("#JPGd090")).toBeGreaterThan(0);
  });
});

describe("composePara — gamma LUT placement", () => {
  it("inserts the GammaClass bytes verbatim", async () => {
    const { GAMMA_CLASSES } = await import("./data/gamma-classes.js");
    const body = composePara(baselineSpec());
    const gmtStart = body.indexOf("#GMT");
    expect(gmtStart).toBeGreaterThan(0);
    const slice = body.subarray(gmtStart, gmtStart + 804);
    expect(slice.equals(GAMMA_CLASSES["et4950-stock"])).toBe(true);
  });
});

describe("composePara — validation", () => {
  it("throws when ADF source is requested but adfExtents is null", () => {
    expect(() =>
      composePara({
        ...baselineSpec(),
        source: "adf-simplex",
        adfExtents: null,
      }),
    ).toThrow(/adf.*adfExtents/i);
  });

  it("throws when adf-duplex source is requested but adfExtents is null", () => {
    expect(() =>
      composePara({
        ...baselineSpec(),
        source: "adf-duplex",
        adfExtents: null,
      }),
    ).toThrow(/adf.*adfExtents/i);
  });

  it("throws when any extent value is negative", () => {
    expect(() =>
      composePara({
        ...baselineSpec(),
        fbExtents: { x0: -1, y0: 0, w: 100, h: 100 },
      }),
    ).toThrow(/extent/i);
  });

  it("throws when gammaClass name is missing from GAMMA_CLASSES", () => {
    expect(() =>
      composePara({
        ...baselineSpec(),
        // @ts-expect-error testing runtime defence against bad class name
        gammaClass: { jpg: "made-up", pdf: "made-up" },
      }),
    ).toThrow(/gamma.*made-up/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they all fail (TDD red phase — DO NOT COMMIT YET)**

```
npx vitest run src/esci2/para-composer.test.ts
```

Expected: all tests FAIL (composePara throws "not implemented"). This proves the tests exercise the code. **No commit at this point** — the next step implements the function so the suite is green before committing.

- [ ] **Step 4: Replace the stub `composePara` with the full implementation**

Open `src/esci2/para-composer.ts` and replace `export function composePara` with:

```ts
const FIXED_PREFIX = Buffer.from(
  "#RSMi0000300" + // bytes 0..12
  "#RSSi0000300" + // 12..24
  "#COLC024" + //    24..32
  "#FMTJPG " + //    32..40
  "#JPGd090", //     40..48
  "ascii",
);

function renderAcq(e: Extents): Buffer {
  const fmt = (n: number) => n.toString().padStart(7, "0");
  return Buffer.from(`#ACQi${fmt(e.x0)}i${fmt(e.y0)}i${fmt(e.w)}i${fmt(e.h)}`, "ascii");
}

function renderSourceSegment(source: ParaSpec["source"]): Buffer {
  switch (source) {
    case "flatbed":     return Buffer.from("#FB ", "ascii");
    case "adf-simplex": return Buffer.from("#ADF", "ascii");
    case "adf-duplex":  return Buffer.from("#ADFDPLX", "ascii");
  }
}

function validate(spec: ParaSpec): void {
  if ((spec.source === "adf-simplex" || spec.source === "adf-duplex") && spec.adfExtents === null) {
    throw new Error(`composePara: source=${spec.source} requires non-null adfExtents`);
  }
  const checkExtents = (name: string, e: Extents | null): void => {
    if (e === null) return;
    for (const k of ["x0", "y0", "w", "h"] as const) {
      if (!Number.isInteger(e[k]) || e[k] < 0) {
        throw new Error(`composePara: ${name}.${k}=${e[k]} must be a non-negative integer`);
      }
    }
  };
  checkExtents("fbExtents", spec.fbExtents);
  checkExtents("adfExtents", spec.adfExtents);
  const gJpg = GAMMA_CLASSES[spec.gammaClass.jpg];
  const gPdf = GAMMA_CLASSES[spec.gammaClass.pdf];
  if (!gJpg) throw new Error(`composePara: unknown gammaClass.jpg=${spec.gammaClass.jpg}`);
  if (!gPdf) throw new Error(`composePara: unknown gammaClass.pdf=${spec.gammaClass.pdf}`);
  if (spec.cmxClass.jpg !== null && !CMX_CLASSES[spec.cmxClass.jpg]) {
    throw new Error(`composePara: unknown cmxClass.jpg=${spec.cmxClass.jpg}`);
  }
  if (spec.cmxClass.pdf !== null && !CMX_CLASSES[spec.cmxClass.pdf]) {
    throw new Error(`composePara: unknown cmxClass.pdf=${spec.cmxClass.pdf}`);
  }
  if (spec.gmm.length !== 4) {
    throw new Error(`composePara: gmm must be exactly 4 ASCII chars, got ${spec.gmm.length}`);
  }
}

export function composePara(spec: ParaSpec): Buffer {
  validate(spec);

  const parts: Buffer[] = [];
  // 1. Source segment.
  parts.push(renderSourceSegment(spec.source));
  // 2. Fixed constants.
  parts.push(FIXED_PREFIX);
  // 3. GMM.
  parts.push(Buffer.from(`#GMM${spec.gmm}`, "ascii"));
  // 4. Gamma LUT triplet (verbatim bytes for the action's class).
  parts.push(GAMMA_CLASSES[spec.gammaClass[spec.action]]);
  // 5. CMX, if class non-null.
  const cmxName = spec.cmxClass[spec.action];
  if (cmxName !== null) {
    parts.push(CMX_CLASSES[cmxName]);
  }
  // 6. QIT, if requested.
  if (spec.optionalSegments.qit) {
    parts.push(Buffer.from("#QITOFF ", "ascii"));
  }
  // 7. CCT, if requested.
  if (spec.optionalSegments.cct) {
    parts.push(Buffer.from("#CCTCOL ", "ascii"));
  }
  // 8. PAG, if ADF source.
  if (spec.source !== "flatbed") {
    parts.push(Buffer.from("#PAGd000", "ascii"));
  }
  // 9. ACQ extents (fb or adf, per source).
  const acqExtents = spec.source === "flatbed" ? spec.fbExtents : spec.adfExtents!;
  parts.push(renderAcq(acqExtents));
  // 10. BSZ trailing constant.
  parts.push(Buffer.from("#BSZi1048576", "ascii"));

  return Buffer.concat(parts);
}
```

- [ ] **Step 5: Run the composer tests**

```
npx vitest run src/esci2/para-composer.test.ts --reporter=verbose
```

Expected: all tests PASS. If any fail, fix the specific issue (likely a segment-order or token-spelling bug).

- [ ] **Step 6: Run the full esci2 suite to confirm no other regressions**

```
npx vitest run src/esci2/
```

Expected: all existing 252 tests + new para-composer tests pass. The composer is not yet wired into the graph, so other tests continue to use the legacy builders unchanged.

- [ ] **Step 7: Commit (composer module + tests together)**

```
git add src/esci2/para-composer.ts src/esci2/para-composer.test.ts
git commit -m "feat(esci2): add composePara with full unit-test coverage"
```

---

### Task 5: Add `dialects/registry.ts` with all four printer entries

**Files:**
- Create: `src/esci2/dialects/registry.ts`
- Create: `src/esci2/dialects/registry.test.ts`

Each registry entry is a complete `RegistryEntry` with every field pinned explicitly. Fingerprints copied verbatim from existing dialect files.

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
// src/esci2/dialects/registry.test.ts
import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";

describe("REGISTRY", () => {
  it("contains exactly four known fingerprints", () => {
    expect(REGISTRY.size).toBe(4);
  });

  it("includes ET-4950 family entry", () => {
    const e = REGISTRY.get(
      "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
    );
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("stat-length");
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG10");
    expect(e!.optionalSegments).toEqual({ qit: true, cct: true });
    expect(e!.adfExtents).not.toBeNull();
  });

  it("includes ET-2750 entry", () => {
    const e = REGISTRY.get(
      "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7",
    );
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("fixed-flatbed");
    expect(e!.initPollIterations).toBe(2);
    expect(e!.gmm).toBe("UG18");
    expect(e!.adfExtents).toBeNull();
    expect(e!.cmxClass.jpg).toBe("et2750-um08");
    expect(e!.optionalSegments).toEqual({ qit: false, cct: false });
  });

  it("includes XP-7100 entry", () => {
    const e = REGISTRY.get(
      "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e",
    );
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("stat-length");
    expect(e!.initPollIterations).toBe(3);
    expect(e!.gmm).toBe("UG18");
    expect(e!.gammaClass.jpg).toBe("xp7100-jpg");
    expect(e!.gammaClass.pdf).toBe("xp7100-pdf");
    expect(e!.cmxClass.jpg).toBe("xp7100-jpg");
    expect(e!.cmxClass.pdf).toBe("xp7100-pdf");
    expect(e!.optionalSegments).toEqual({ qit: true, cct: false });
  });

  it("includes ET-2950 entry that reuses ET-4950 LUT", () => {
    const e = REGISTRY.get(
      "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
    );
    expect(e).toBeDefined();
    expect(e!.sourceDetection).toBe("fixed-flatbed");
    expect(e!.gammaClass).toEqual({ jpg: "et4950-stock", pdf: "et4950-stock" });
    expect(e!.cmxClass).toEqual({ jpg: null, pdf: null });
    expect(e!.adfExtents).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```
npx vitest run src/esci2/dialects/registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement registry.ts**

```ts
// src/esci2/dialects/registry.ts
import type { GammaClassName, CmxClassName, Extents } from "../para-composer.js";

export interface RegistryEntry {
  displayName: string;
  sourceDetection: "stat-length" | "fixed-flatbed";
  initPollIterations: number;
  fbExtents: Extents;
  adfExtents: Extents | null;
  gmm: string;
  gammaClass: { jpg: GammaClassName; pdf: GammaClassName };
  cmxClass: { jpg: CmxClassName | null; pdf: CmxClassName | null };
  optionalSegments: { qit: boolean; cct: boolean };
}

export const REGISTRY: ReadonlyMap<string, RegistryEntry> = new Map([
  [
    "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
    {
      displayName: "ET-4950 / ET-3950 / ET-4956 (ESC/I-2 over TLS)",
      sourceDetection: "stat-length",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: { x0: 69, y0: 0, w: 2481, h: 3506 },
      gmm: "UG10",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: null, pdf: null },
      optionalSegments: { qit: true, cct: true },
    },
  ],
  [
    "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7",
    {
      displayName: "ET-2750 (ESC/I-2 over plain TCP)",
      sourceDetection: "fixed-flatbed",
      initPollIterations: 2,
      fbExtents: { x0: 0, y0: 0, w: 2477, h: 3500 },
      adfExtents: null,
      gmm: "UG18",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: "et2750-um08", pdf: "et2750-um08" },
      optionalSegments: { qit: false, cct: false },
    },
  ],
  [
    "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e",
    {
      displayName: "XP-7100 (ESC/I-2 over plain TCP)",
      sourceDetection: "stat-length",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2550, h: 3300 },
      adfExtents: { x0: 0, y0: 0, w: 2550, h: 3300 },
      gmm: "UG18",
      gammaClass: { jpg: "xp7100-jpg", pdf: "xp7100-pdf" },
      cmxClass: { jpg: "xp7100-jpg", pdf: "xp7100-pdf" },
      optionalSegments: { qit: true, cct: false },
    },
  ],
  [
    "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb",
    {
      displayName: "ET-2950 (ESC/I-2 over TLS)",
      sourceDetection: "fixed-flatbed",
      initPollIterations: 3,
      fbExtents: { x0: 0, y0: 0, w: 2481, h: 3506 },
      adfExtents: null,
      gmm: "UG10",
      gammaClass: { jpg: "et4950-stock", pdf: "et4950-stock" },
      cmxClass: { jpg: null, pdf: null },
      optionalSegments: { qit: true, cct: true },
    },
  ],
]);
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run src/esci2/dialects/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/esci2/dialects/registry.ts src/esci2/dialects/registry.test.ts
git commit -m "feat(esci2): add typed registry with four known printer entries"
```

---

### Task 6: Add `dialects/dispatch.ts` (lookup + override + makeParaSpec)

**Files:**
- Create: `src/esci2/dialects/dispatch.ts`
- Create: `src/esci2/dialects/dispatch.test.ts`

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
// src/esci2/dialects/dispatch.test.ts
import { describe, it, expect } from "vitest";
import {
  lookupRegistryEntry,
  applyEntrySourceOverride,
  makeParaSpec,
} from "./dispatch.js";
import { REGISTRY } from "./registry.js";
import { UnsupportedDialectError } from "../diagnostic.js";

const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";
const ET2750_FP = "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7";
const UNKNOWN_FP = "0000000000000000000000000000000000000000000000000000000000000000";

const ET4950_CAPA = Buffer.from("#GMMLISTUG10UG18#CMXLISTUNITUM08", "ascii"); // minimal stub
const ET4950_INFO = Buffer.from("#PRDh010PID 1147        #FB AREAd850i0001170", "ascii");

describe("lookupRegistryEntry", () => {
  it("returns the entry for a known fingerprint", () => {
    const e = lookupRegistryEntry(ET4950_FP, ET4950_CAPA, ET4950_INFO, "tls");
    expect(e).toBe(REGISTRY.get(ET4950_FP));
  });

  it("throws UnsupportedDialectError with diagnostic for an unknown fingerprint", () => {
    expect(() =>
      lookupRegistryEntry(UNKNOWN_FP, ET4950_CAPA, ET4950_INFO, "plain"),
    ).toThrow(UnsupportedDialectError);
  });

  it("the thrown error carries the fingerprint and diagnostic", () => {
    try {
      lookupRegistryEntry(UNKNOWN_FP, ET4950_CAPA, ET4950_INFO, "plain");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedDialectError);
      const e = err as UnsupportedDialectError;
      expect(e.capaFingerprint).toBe(UNKNOWN_FP);
      expect(e.diagnostic).toContain("CAPA fingerprint:");
      expect(e.diagnostic).toContain("esci2-plain");
    }
  });
});

describe("applyEntrySourceOverride", () => {
  it("pins ctx.source = 'flatbed' for fixed-flatbed entries", () => {
    const entry = REGISTRY.get(ET2750_FP)!; // fixed-flatbed
    const ctx = { source: "adf" as "adf" | "flatbed", duplex: false };
    applyEntrySourceOverride(ctx as any, entry); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ctx.source).toBe("flatbed");
  });

  it("leaves ctx.source unchanged for stat-length entries", () => {
    const entry = REGISTRY.get(ET4950_FP)!; // stat-length
    const ctx = { source: "adf" as "adf" | "flatbed", duplex: false };
    applyEntrySourceOverride(ctx as any, entry); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ctx.source).toBe("adf");
  });
});

describe("makeParaSpec", () => {
  it("projects entry + flatbed onto ParaSpec.fbExtents", () => {
    const entry = REGISTRY.get(ET4950_FP)!;
    const spec = makeParaSpec(entry, "flatbed", "jpg");
    expect(spec.source).toBe("flatbed");
    expect(spec.action).toBe("jpg");
    expect(spec.gmm).toBe("UG10");
    expect(spec.fbExtents).toEqual(entry.fbExtents);
    expect(spec.adfExtents).toEqual(entry.adfExtents);
    expect(spec.optionalSegments).toEqual({ qit: true, cct: true });
  });

  it("projects entry + adf-simplex correctly", () => {
    const entry = REGISTRY.get(ET4950_FP)!;
    const spec = makeParaSpec(entry, "adf-simplex", "jpg");
    expect(spec.source).toBe("adf-simplex");
  });

  it("projects entry + adf-duplex correctly", () => {
    const entry = REGISTRY.get(ET4950_FP)!;
    const spec = makeParaSpec(entry, "adf-duplex", "pdf");
    expect(spec.source).toBe("adf-duplex");
    expect(spec.action).toBe("pdf");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```
npx vitest run src/esci2/dialects/dispatch.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement dispatch.ts**

```ts
// src/esci2/dialects/dispatch.ts
import { REGISTRY, type RegistryEntry } from "./registry.js";
import type { ParaSpec } from "../para-composer.js";
import { buildDiagnostic, UnsupportedDialectError } from "../diagnostic.js";

/**
 * Looks up the registry entry for a CAPA fingerprint. Throws
 * UnsupportedDialectError on miss with the existing diagnostic block.
 *
 * Called from INIT1_CAPA in the graph state machine, immediately after the
 * fingerprint is computed.
 */
export function lookupRegistryEntry(
  fingerprint: string,
  capaBody: Buffer,
  infoBody: Buffer,
  transport: "tls" | "plain",
): RegistryEntry {
  const entry = REGISTRY.get(fingerprint);
  if (entry === undefined) {
    const diagnostic = buildDiagnostic({ capaBody, infoBody, transport, fingerprint });
    throw new UnsupportedDialectError(fingerprint, diagnostic);
  }
  return entry;
}

/**
 * Pins ctx.source = "flatbed" when the resolved entry uses fixed-flatbed
 * source detection. Replaces the legacy applyDialectSourceOverride helper.
 *
 * Necessary because the TLS scanner shell pre-sets ctx.source = "adf"
 * (src/esci2/scanner.ts) and expects the override to flip it for
 * flatbed-only TLS printers (ET-2950).
 */
export function applyEntrySourceOverride(
  ctx: { source: "adf" | "flatbed" },
  entry: RegistryEntry,
): void {
  if (entry.sourceDetection === "fixed-flatbed") {
    ctx.source = "flatbed";
  }
}

/**
 * Pure projection of a registry entry + source/action axes onto a ParaSpec.
 * Called at PARA-build time after the source axis has been resolved (with
 * duplex folded in by the call site).
 */
export function makeParaSpec(
  entry: RegistryEntry,
  source: ParaSpec["source"],
  action: ParaSpec["action"],
): ParaSpec {
  return {
    source,
    action,
    fbExtents: entry.fbExtents,
    adfExtents: entry.adfExtents,
    gmm: entry.gmm,
    gammaClass: entry.gammaClass,
    cmxClass: entry.cmxClass,
    optionalSegments: entry.optionalSegments,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run src/esci2/dialects/dispatch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full esci2 suite to confirm no regression**

```
npx vitest run src/esci2/
```

Expected: all tests pass (existing tests still use the legacy builders).

- [ ] **Step 6: Commit**

```
git add src/esci2/dialects/dispatch.ts src/esci2/dialects/dispatch.test.ts
git commit -m "feat(esci2): add dispatch helpers (lookup + override + makeParaSpec)"
```

---

### Task 7: Rewire `graph.ts` + `graph.test.ts` — INIT1_CAPA dispatch + PARA-build call site + ET-2750 byte-equivalence shield (single commit)

**Files:**
- Modify: `src/esci2/scanner.test.ts` (extend the ET-2750 replay with a byte-equivalence assertion — see Step 0 below)
- Modify: `src/esci2/graph.ts`
- Modify: `src/esci2/graph.test.ts` (renames + helper-rebind)

This is the surgery: replace `lookupDialect` + `applyDialectSourceOverride` + `ctx.dialect!.buildPara(...)` with the new pipeline AND update the graph unit tests in the same commit. We do not commit between sub-steps because `ctx.dialect`/`ctx.entry` rename + `applyDialectSourceOverride` deletion would leave the suite red mid-task otherwise.

The first step *strengthens* the regression net for ET-2750 before any rewiring happens. Today's ET-2750 replay (`scanner.test.ts:1082-1136`) only asserts behavioural outputs (PDF produced, correct page count). Unlike the XP-7100 replay at line 1173+, it does NOT compare the scanner's emitted PARA bytes to the captured-from-driver PARA bytes. After Task 9 deletes `buildParaFlatbedPlain` and Task 8's replacement test drops the legacy byte check, ET-2750 would have NO byte-level regression net — `driveFixture` replays printer responses regardless of what PARA the scanner sent, so silent regressions wouldn't fail any test. Adding the byte assertion *before* the rewire means the moment the composer ships wrong bytes for ET-2750, this test fails loudly.

**Steps:**

- [ ] **Step 0: Add an ET-2750 byte-equivalence assertion to the existing replay**

Open `src/esci2/scanner.test.ts`. Find the existing ET-2750 replay test (`it("flatbed-single-page-pdf: drives the captured wire and produces one PDF", …)` around line 1082). After `await driveFixture(...)` (around line 1111) and before the for-loop that waits for the PDF, insert:

```ts
// Byte-equivalence shield: assert the scanner's PARA wire bytes match
// what the captured Wireshark session sent. Without this, driveFixture
// replays the printer's responses regardless of what PARA the scanner
// emitted, so a composer regression on ET-2750 would not fail this test.
// Mirrors the XP-7100 replay pattern at line ~1173 of this file.
const capturedPara = extractCapturedParaBody(fixture);
const scannerPara = extractScannerParaWrite(fake);
expect(scannerPara.equals(capturedPara)).toBe(true);
```

`extractCapturedParaBody` and `extractScannerParaWrite` are already defined in scanner.test.ts (used by the XP-7100 replay). No new imports required.

Run the suite to confirm the shield passes against the current pre-refactor code:

```
npx vitest run src/esci2/scanner.test.ts
```

Expected: all tests pass. The legacy `et2750Dialect.buildPara` already produces the right bytes, so this assertion is a pure tightening — no behaviour change yet.

- [ ] **Step 1: Update the `Esci2Ctx` interface**

Open `src/esci2/graph.ts`. Find `interface Esci2Ctx` (around line 38). Replace the `dialect` field:

```ts
  dialect: Dialect | undefined;
```

with:

```ts
  entry: RegistryEntry | undefined;
```

Update imports at the top of the file: remove `Dialect` and `applyDialectSourceOverride` (if exported from this file) — add `RegistryEntry` from `./dialects/registry.js`, `lookupRegistryEntry` + `applyEntrySourceOverride` + `makeParaSpec` from `./dialects/dispatch.js`, and `composePara` + `type ParaSpec` from `./para-composer.js`.

- [ ] **Step 2: Delete the legacy `applyDialectSourceOverride` helper**

Around `graph.ts:83-87` the file defines `applyDialectSourceOverride`. Delete the entire function — it's replaced by `applyEntrySourceOverride` imported from dispatch.ts. The doc comment above it can stay (the *why* it exists is still relevant) but the function body is gone.

- [ ] **Step 3: Update the INIT1_CAPA handler**

Find the INIT1_CAPA two-phase-read callback (around `graph.ts:307-333` — the `(ctx, body) => { … }` block passed to `twoPhaseRead`). **The callback parameter is named `body`, not `packet.payload`** — there is no `packet` in scope at this layer. The current code is:

```ts
(ctx, body) => {
  ctx.capaBody = body;
  const fingerprint = computeCapaFingerprint(body);
  const dialect = lookupDialect(fingerprint);
  if (dialect === null) {
    const diagnostic = buildDiagnostic({
      capaBody: ctx.capaBody,
      infoBody: ctx.infoBody,
      transport: ctx.transport,
      fingerprint,
    });
    return { error: new UnsupportedDialectError(fingerprint, diagnostic) };
  }
  ctx.dialect = dialect;
  log.debug("Dialect resolved", { name: dialect.displayName, fingerprint });
  applyDialectSourceOverride(ctx, dialect);
}
```

Replace with:

```ts
(ctx, body) => {
  ctx.capaBody = body;
  const fingerprint = computeCapaFingerprint(body);
  try {
    ctx.entry = lookupRegistryEntry(fingerprint, ctx.capaBody, ctx.infoBody, ctx.transport);
  } catch (err) {
    return { error: err as Error };
  }
  log.debug("Dialect resolved", { name: ctx.entry.displayName, fingerprint });
  applyEntrySourceOverride(ctx, ctx.entry);
}
```

The `log.debug("Dialect resolved", …)` line is preserved — traces stay self-documenting. Also remove the now-unused `lookupDialect`, `buildDiagnostic`, `UnsupportedDialectError` imports from the top of `graph.ts` if no other handler uses them.

- [ ] **Step 4: Update init-poll handler references**

Find every `ctx.dialect!.sourceDetection` and `ctx.dialect!.initPollIterations` reference. Approximate locations: `graph.ts:557` (`INIT_POLL_STAT_DRAIN` decision) and `graph.ts:599` (`INIT_POLL_FIN`).

- `ctx.dialect!.sourceDetection` → `ctx.entry!.sourceDetection`
- `ctx.dialect!.initPollIterations` → `ctx.entry!.initPollIterations`

- [ ] **Step 5: Update the PARA-build call site**

Find `buildParaSend(ctx)` (around `graph.ts:621`). Replace:

```ts
const paraPayload = ctx.dialect!.buildPara({
  source: ctx.source,
  duplex: ctx.duplex,
  action: ctx.action,
});
```

with:

```ts
const paraSource: ParaSpec["source"] =
  ctx.source === "flatbed"
    ? "flatbed"
    : ctx.duplex
      ? "adf-duplex"
      : "adf-simplex";
const paraPayload = composePara(makeParaSpec(ctx.entry!, paraSource, ctx.action));
```

- [ ] **Step 6: Update `graph.test.ts` to track the rename and helper deletion**

`graph.test.ts` imports `applyDialectSourceOverride` from `graph.js` and threads `dialect:` overrides through its `makeCtx()` helper. After steps 2-4 above the suite would go red until this file is updated. Make these changes:

1. Replace the top-level import line:
   ```ts
   import { esci2Graph, ESCI2_TIMEOUT_MS, applyDialectSourceOverride } from "./graph.js";
   ```
   with:
   ```ts
   import { esci2Graph, ESCI2_TIMEOUT_MS } from "./graph.js";
   import { applyEntrySourceOverride } from "./dialects/dispatch.js";
   import { REGISTRY } from "./dialects/registry.js";
   ```

2. The legacy per-dialect imports (`et4950FamilyDialect`, `et2750Dialect`, `et2950Dialect`) stay in place for now — those files still exist until Task 9. Every `dialect: <obj>` field in a `makeCtx()` call needs to become `entry: REGISTRY.get(<obj>.capaFingerprint)!`. **There are seven occurrences** — sanity-check by running `rg -n "dialect:" src/esci2/graph.test.ts` and confirming you see seven matches. Replace each:

   - Line ~192 (`INIT_POLL_FIN loops` test): `makeCtx({ dialect: et2750Dialect, initPollIteration: 0 })` → `makeCtx({ entry: REGISTRY.get(et2750Dialect.capaFingerprint)!, initPollIteration: 0 })`
   - Line ~205 (`INIT_POLL_FIN advances` test): same shape with `initPollIteration: 1`
   - Line ~482 (fixture-replay describe): `dialect: et4950FamilyDialect,` → `entry: REGISTRY.get(et4950FamilyDialect.capaFingerprint)!,`
   - Line ~562 (`skips source-detect override` test): `dialect: et2750Dialect,` → same shape
   - Line ~583 (`applyDialectSourceOverride` describe, ET-2950 test): `makeCtx({ source: "adf", transport: "tls", dialect: et2950Dialect })` → `makeCtx({ source: "adf", transport: "tls", entry: REGISTRY.get(et2950Dialect.capaFingerprint)! })`
   - Line ~589 (same describe, ET-2750 test): `dialect: et2750Dialect` → `entry: REGISTRY.get(et2750Dialect.capaFingerprint)!`
   - Line ~595 (same describe, ET-4950 test): `dialect: et4950FamilyDialect` → `entry: REGISTRY.get(et4950FamilyDialect.capaFingerprint)!`

   Also update `makeCtx()` itself: change the field name `dialect` → `entry` in its default initializer and any `Partial<Esci2Ctx>` typing.

3. Rewrite the `describe("applyDialectSourceOverride", …)` block (around line 572) as `describe("applyEntrySourceOverride", …)`, replacing every `applyDialectSourceOverride(ctx, <obj>)` call with `applyEntrySourceOverride(ctx, REGISTRY.get(<obj>.capaFingerprint)!)`. The `makeCtx` calls inside this block are already covered by step 2 above (lines ~583, ~589, ~595). The dialect-object imports stay in place — they're just used as fingerprint lookups now, and get deleted in Task 9.

After Task 9 deletes the dialect objects, those `.capaFingerprint` lookups stop working. Task 9 includes a follow-up step to replace them with inlined fingerprint constants. Don't pre-empt that here; the test file should compile and pass at the end of this task with the imports still in place.

- [ ] **Step 7: Run the full esci2 suite — the moment of truth**

```
npx vitest run src/esci2/ --reporter=verbose
```

Expected: **all existing tests + new composer/dispatch tests pass**, including every replay test (`scanner.test.ts`, all four `dialects/*.test.ts`). If any replay test fails, the composer + registry are not byte-equivalent to the legacy builders for that fixture — investigate the diff and fix in the data files or composer logic. Do NOT modify the fixture.

Common causes of replay test failures at this point:
- Wrong byte offset when extracting gamma/CMX class hex from current builder or .bin file.
- Off-by-one in segment order.
- Token spelling (e.g. accidentally typed `#QIT OFF ` with a space).
- Extents mismatch in a registry entry.

- [ ] **Step 8: Commit**

```
git add src/esci2/scanner.test.ts src/esci2/graph.ts src/esci2/graph.test.ts
git commit -m "refactor(esci2): rewire graph dispatch to use composePara + registry + ET-2750 byte shield"
```

---

### Task 8: Update per-dialect test files to assert against the new pipeline

**Files:**
- Modify: `src/esci2/dialects/et-4950-family.test.ts`
- Modify: `src/esci2/dialects/et-2750.test.ts`
- Modify: `src/esci2/dialects/xp-7100.test.ts`
- Modify: `src/esci2/dialects/et-2950.test.ts`

These tests currently assert against the `Dialect` object's properties and call `buildPara` directly. After the refactor, they need to assert against the registry entry + use the composer.

**Critical: preserve byte-equality assertions against the committed `.bin` fixtures.** `xp-7100.test.ts` currently has five `out.equals(loadFixture("...bin"))` assertions, including for the PDF actions (`pdf-single.bin`, `pdf-duplex.bin`). `scanner.test.ts:1167` only exercises XP-7100 with `action: "jpg"`, so the per-dialect file is the *only* test that pins XP-7100's PDF wire bytes against the captured fixture. The replacement below preserves all five assertions — don't simplify them to length/difference checks.

**Steps:**

- [ ] **Step 1: Rewrite `et-2750.test.ts`**

Replace the file with:

```ts
import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET2750_FP = "de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7";
const entry = REGISTRY.get(ET2750_FP)!;

describe("ET-2750 registry entry", () => {
  it("is flatbed-only (no ADF extents)", () => {
    expect(entry.adfExtents).toBeNull();
  });

  it("uses fixed-flatbed source detection", () => {
    expect(entry.sourceDetection).toBe("fixed-flatbed");
  });

  it("uses 2 init-poll iterations", () => {
    expect(entry.initPollIterations).toBe(2);
  });
});

describe("ET-2750 composed PARA", () => {
  it("flatbed JPG matches flatbed PDF (action-invariant)", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(true);
  });

  it("composer throws on adf-simplex (no adfExtents)", () => {
    expect(() => composePara(makeParaSpec(entry, "adf-simplex", "jpg"))).toThrow(
      /adf.*adfExtents/i,
    );
  });
});
```

- [ ] **Step 2: Rewrite `et-4950-family.test.ts` along the same shape**

Replace assertions to query `REGISTRY.get(ET4950_FP)` and verify entry properties; for byte-level PARA assertions, call `composePara(makeParaSpec(entry, source, action))` and compare to known offsets (e.g. body length 928 for flatbed, 936 for adf-simplex, 940 for adf-duplex).

```ts
import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET4950_FP = "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2";
const entry = REGISTRY.get(ET4950_FP)!;

describe("ET-4950 registry entry", () => {
  it("supports flatbed + ADF", () => {
    expect(entry.adfExtents).not.toBeNull();
  });
  it("uses stat-length source detection", () => {
    expect(entry.sourceDetection).toBe("stat-length");
  });
  it("uses 3 init-poll iterations", () => {
    expect(entry.initPollIterations).toBe(3);
  });
});

describe("ET-4950 composed PARA size", () => {
  it("flatbed is 928 bytes", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(928);
  });
  it("adf-simplex is 936 bytes", () => {
    expect(composePara(makeParaSpec(entry, "adf-simplex", "jpg")).length).toBe(936);
  });
  it("adf-duplex is 940 bytes", () => {
    expect(composePara(makeParaSpec(entry, "adf-duplex", "jpg")).length).toBe(940);
  });
});
```

- [ ] **Step 3: Rewrite `xp-7100.test.ts` — preserve all five `.bin` equality assertions**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const XP7100_FP = "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e";
const entry = REGISTRY.get(XP7100_FP)!;

const FIXTURE_DIR = path.resolve("src/esci2/dialects/xp-7100-fixtures");
function loadFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

describe("XP-7100 registry entry", () => {
  it("supports flatbed + ADF + duplex (has adfExtents)", () => {
    expect(entry.adfExtents).not.toBeNull();
  });
  it("uses stat-length source detection", () => {
    expect(entry.sourceDetection).toBe("stat-length");
  });
  it("uses 3 init-poll iterations", () => {
    expect(entry.initPollIterations).toBe(3);
  });
  it("uses per-action gamma + CMX classes (action-aware)", () => {
    expect(entry.gammaClass.jpg).not.toBe(entry.gammaClass.pdf);
    expect(entry.cmxClass.jpg).not.toBe(entry.cmxClass.pdf);
  });
});

describe("XP-7100 captured-axis byte equality (the only coverage of PDF wire bytes)", () => {
  it("flatbed JPG matches jpg-flatbed.bin", () => {
    const out = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    expect(out.equals(loadFixture("jpg-flatbed.bin"))).toBe(true);
  });
  it("ADF simplex JPG matches jpg-single.bin", () => {
    const out = composePara(makeParaSpec(entry, "adf-simplex", "jpg"));
    expect(out.equals(loadFixture("jpg-single.bin"))).toBe(true);
  });
  it("ADF simplex PDF matches pdf-single.bin", () => {
    const out = composePara(makeParaSpec(entry, "adf-simplex", "pdf"));
    expect(out.equals(loadFixture("pdf-single.bin"))).toBe(true);
  });
  it("ADF duplex JPG matches jpg-duplex.bin", () => {
    const out = composePara(makeParaSpec(entry, "adf-duplex", "jpg"));
    expect(out.equals(loadFixture("jpg-duplex.bin"))).toBe(true);
  });
  it("ADF duplex PDF matches pdf-duplex.bin", () => {
    const out = composePara(makeParaSpec(entry, "adf-duplex", "pdf"));
    expect(out.equals(loadFixture("pdf-duplex.bin"))).toBe(true);
  });
});

describe("XP-7100 flatbed PDF (no captured fixture — synthesised by composer)", () => {
  // Today's xp-7100.test.ts:65-84 synthesises the expected bytes by splicing
  // PDF LUTs from pdf-single.bin into a copy of jpg-flatbed.bin. The composer
  // achieves the same result via gammaClass.pdf="xp7100-pdf" + cmxClass.pdf=
  // "xp7100-pdf" applied to the flatbed source. Replicate the synthesis as
  // the expected-bytes oracle and assert byte equality.
  const LUT_OFFSETS = {
    flatbed: { grn: 60, red: 328, blu: 596, cmx: 864 },
    adfSimplex: { grn: 60, red: 328, blu: 596, cmx: 864 },
  };

  it("composed flatbed-PDF equals the JPG-flatbed body with PDF LUT triplet + CMX spliced in", () => {
    const flatbedJpg = loadFixture("jpg-flatbed.bin");
    const pdfSrc = loadFixture("pdf-single.bin");
    const fb = LUT_OFFSETS.flatbed;
    const adf = LUT_OFFSETS.adfSimplex;
    const expected = Buffer.from(flatbedJpg);
    pdfSrc.subarray(adf.grn + 12, adf.grn + 12 + 256).copy(expected, fb.grn + 12);
    pdfSrc.subarray(adf.red + 12, adf.red + 12 + 256).copy(expected, fb.red + 12);
    pdfSrc.subarray(adf.blu + 12, adf.blu + 12 + 256).copy(expected, fb.blu + 12);
    pdfSrc.subarray(adf.cmx + 12, adf.cmx + 12 + 12).copy(expected, fb.cmx + 12);

    const out = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(out.equals(expected)).toBe(true);
  });
});
```

- [ ] **Step 4: Rewrite `et-2950.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const ET2950_FP = "b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb";
const entry = REGISTRY.get(ET2950_FP)!;

describe("ET-2950 registry entry", () => {
  it("is flatbed-only", () => {
    expect(entry.adfExtents).toBeNull();
  });
  it("reuses ET-4950's gamma class (no et2950-specific bytes)", () => {
    expect(entry.gammaClass).toEqual({ jpg: "et4950-stock", pdf: "et4950-stock" });
  });
  it("composed flatbed PARA equals ET-4950 family flatbed PARA in bytes", () => {
    const et4950 = REGISTRY.get(
      "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
    )!;
    const et2950Body = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const et4950Body = composePara(makeParaSpec(et4950, "flatbed", "jpg"));
    expect(et2950Body.equals(et4950Body)).toBe(true);
  });
});
```

- [ ] **Step 5: Run the full suite**

```
npx vitest run src/esci2/
```

Expected: all pass.

- [ ] **Step 6: Commit**

```
git add src/esci2/dialects/*.test.ts
git commit -m "test(esci2): retarget per-dialect tests at the registry-driven pipeline"
```

---

### Task 9: Delete the old dialect files, legacy `buildPara*` helpers, and stale test fixtures

**Files:**
- Delete: `src/esci2/dialects/et-4950-family.ts`
- Delete: `src/esci2/dialects/et-2750.ts`
- Delete: `src/esci2/dialects/xp-7100.ts`
- Delete: `src/esci2/dialects/et-2950.ts`
- Delete: `src/esci2/dialect-registry.ts`
- Delete: `src/esci2/dialect-registry.test.ts` (its diagnostic tests moved to `diagnostic.test.ts` in Task 1; its lookup/registry tests are superseded by `registry.test.ts` from Task 5; nothing of value remains)
- Modify: `src/esci2/commands.ts` (remove `buildParaAdf`, `buildParaFlatbedTls`, `buildParaFlatbedPlain`)
- Modify: `src/esci2/commands.test.ts` (remove the `describe("buildParaAdf", …)`, `describe("buildParaFlatbedTls", …)`, and `describe("buildParaFlatbedPlain", …)` blocks; keep the buildFsY/X/Z, buildEsci2Command, buildParaHeader, parseEsci2ReplyHeader, parseTokens blocks)
- Modify: `src/esci2/scanner.test.ts` (replace the `xp7100Dialect.buildPara(...)` recipe cross-check at line ~1182 with `composePara(makeParaSpec(...))`; update the import at line 13)
- Modify: `src/esci2/graph.test.ts` (replace `<dialect-obj>.capaFingerprint` references introduced in Task 7 with inlined fingerprint string constants; drop the now-unused `et4950FamilyDialect`, `et2750Dialect`, `et2950Dialect` imports)
- Modify: `src/esci2/dialect.ts` (trim/remove the old `Dialect` interface and `ParaAxes`; keep the `UnsupportedDialectError` re-export from Task 1 unless nothing imports it from this path)

**Steps:**

- [ ] **Step 1: Delete the four dialect files, the legacy registry, and its test**

```
git rm src/esci2/dialects/et-4950-family.ts
git rm src/esci2/dialects/et-2750.ts
git rm src/esci2/dialects/xp-7100.ts
git rm src/esci2/dialects/et-2950.ts
git rm src/esci2/dialect-registry.ts
git rm src/esci2/dialect-registry.test.ts
```

- [ ] **Step 2: Remove the legacy builders from `commands.ts` and their tests from `commands.test.ts`**

Open `src/esci2/commands.ts`. Find and delete:

- `export function buildParaAdf(duplex: boolean): Buffer { ... }`
- `export function buildParaFlatbedTls(): Buffer { ... }`
- `export function buildParaFlatbedPlain(): Buffer { ... }`

Plus their leading doc comments and any `// Blob transcribed from ...` headers.

Keep `buildEsci2Command`, `buildParaHeader`, `parseEsci2ReplyHeader`, and any other helpers — they're still used.

Then open `src/esci2/commands.test.ts` and delete:

- The `describe("buildParaAdf", …)` block (~lines 63-141).
- The `describe("buildParaFlatbedTls", …)` block (~lines 143-195).
- The `describe("buildParaFlatbedPlain", …)` block (~lines 197-272).
- The `buildParaAdf`, `buildParaFlatbedTls`, `buildParaFlatbedPlain` names from the top-level import (lines 3-12).

Keep all other describe blocks (buildFsY/X/Z, buildEsci2Command, buildParaHeader, parseEsci2ReplyHeader, parseTokens) — they test surviving functions.

- [ ] **Step 2b: Update `scanner.test.ts` cross-check**

`scanner.test.ts:1178-1187` cross-checks captured XP-7100 PARA against `xp7100Dialect.buildPara(...)`. Replace the recipe call with the new pipeline.

At line 13, replace:
```ts
import { xp7100Dialect } from "./dialects/xp-7100.js";
```
with:
```ts
import { REGISTRY } from "./dialects/registry.js";
import { makeParaSpec } from "./dialects/dispatch.js";
import { composePara, type ParaSpec } from "./para-composer.js";

const XP7100_FP = "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e";
```

At line 1182, replace:
```ts
const recipePara = xp7100Dialect.buildPara({
  source: opts.source,
  duplex: opts.duplex,
  action: "jpg",
});
```
with:
```ts
const paraSource: ParaSpec["source"] =
  opts.source === "flatbed"
    ? "flatbed"
    : opts.duplex
      ? "adf-duplex"
      : "adf-simplex";
const recipePara = composePara(
  makeParaSpec(REGISTRY.get(XP7100_FP)!, paraSource, "jpg"),
);
```

- [ ] **Step 2c: Update `graph.test.ts` to drop the deleted-dialect-object imports**

Task 7 left `graph.test.ts` using `<dialect-obj>.capaFingerprint` for registry lookup. Now that the dialect objects are deleted, replace those lookups with the literal fingerprint strings:

- Replace `REGISTRY.get(et4950FamilyDialect.capaFingerprint)!` with `REGISTRY.get("2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2")!`
- Replace `REGISTRY.get(et2750Dialect.capaFingerprint)!` with `REGISTRY.get("de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7")!`
- Replace `REGISTRY.get(et2950Dialect.capaFingerprint)!` with `REGISTRY.get("b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb")!`

Then drop the now-unused imports:
```ts
import { et4950FamilyDialect } from "./dialects/et-4950-family.js";
import { et2750Dialect } from "./dialects/et-2750.js";
import { et2950Dialect } from "./dialects/et-2950.js";
```

- [ ] **Step 3: Trim `dialect.ts`**

Open `src/esci2/dialect.ts`. If the file still exports `Dialect` or `ParaAxes` types, decide:

- If anything still imports them: keep, but trim to just what's used.
- If nothing imports them: delete the whole file via `git rm src/esci2/dialect.ts`.

`ParaAxes` is unlikely to survive — it was the legacy `(source, duplex, action)` tuple, replaced by the call-site derivation in graph.ts.

- [ ] **Step 4: Verify the build still compiles**

```
npx vitest run src/esci2/
```

Expected: all tests pass. If any import error: there's a stale reference to the deleted files somewhere. Find with ripgrep:

```
rg "buildParaFlatbedTls|buildParaAdf|buildParaFlatbedPlain|et4950FamilyDialect|et2750Dialect|xp7100Dialect|et2950Dialect|lookupDialect" src/
```

(Use `rg` rather than POSIX `grep -rn` — `rg` is the project standard on Windows + Git Bash, faster on large trees, and respects `.gitignore`.)

- [ ] **Step 5: Lint + format check**

```
npm run lint && npm run format:check
```

- [ ] **Step 6: Commit**

```
git add -A
git commit -m "refactor(esci2): delete legacy per-family dialect files and buildPara* helpers"
```

---

### Task 10: Update `docs/PROTOCOL-REFERENCE.md`

**Files:**
- Modify: `docs/PROTOCOL-REFERENCE.md`

**Steps:**

- [ ] **Step 1: Find the "How printer-model differences are handled" section**

```
rg -n "printer-model differences" docs/PROTOCOL-REFERENCE.md
```

- [ ] **Step 2: Rewrite the section**

The current text frames per-printer support as "byte-for-byte from a captured Frida/pcap fixture". Replace with framing that describes:

- The composer (`composePara`) reads a `ParaSpec` and produces PARA bytes.
- The registry (`REGISTRY` in `src/esci2/dialects/registry.ts`) pins every parameter per known fingerprint.
- Adding a known printer = (a) capture wire bytes, (b) extract gamma/CMX bytes into the data files if novel, (c) add a registry entry.
- Known printers still produce byte-identical output to today; replay tests are the regression net.

Keep references to the per-family fixtures (Frida ET-4950, pcap ET-2750/WF-3620/XP-7100/ET-2950) where they discuss the source-of-truth bytes — they're still the captured fixtures, just consumed by the composer instead of inlined into per-printer builders.

The section's length and depth should match the surrounding sections — concise paragraphs, not a re-implementation of the spec.

Suggested replacement structure (~10-15 lines of prose):

```markdown
### How printer-model differences are handled

Each printer family that the service supports has an entry in
`src/esci2/dialects/registry.ts`, keyed by a sha256 fingerprint over its
CAPA reply (`src/esci2/capa-fingerprint.ts`). Entries are pure data:
- Dispatch metadata (`sourceDetection`, `initPollIterations`).
- Scan extents (`fbExtents`, `adfExtents`) — manually pinned per family.
- A `gmm` constant + named `gammaClass` and `cmxClass` lookups in
  `src/esci2/data/gamma-classes.ts` and `cmx-classes.ts`. Class definitions
  are inlined verbatim from captured fixtures; never algorithmically
  generated.
- Optional-segment presence flags (`#QIT`, `#CCT`).

At INIT1_CAPA the scan-session graph computes the fingerprint, looks up the
entry (`lookupRegistryEntry`), and stores it on the session context. At
PARA build time the entry plus the runtime source/action axes feed into
`makeParaSpec`, and `composePara` assembles the PARA body.

Adding support for a new printer model is a data-only change in the
normal case: capture its wire bytes, extract any novel gamma/CMX class
into the data files, and add a registry entry. Replay tests
(`src/esci2/scanner.test.ts` and per-dialect files under
`src/esci2/dialects/*.test.ts`) pin the composed output byte-for-byte
against the captured fixture.

Legacy ESC/I (WF-3620 family) uses a separate code path under `src/esci/`
with a 64-byte `FS W` parameter block instead of the `PARA` command;
none of the above applies to it.
```

- [ ] **Step 3: Commit**

```
git add docs/PROTOCOL-REFERENCE.md
git commit -m "docs: update PROTOCOL-REFERENCE for composer + registry architecture"
```

---

### Task 11: Final-pass verification

**Steps:**

- [ ] **Step 1: Run the full project test suite**

```
npm test
```

Expected: all tests pass (replay + new composer + new dispatch + retargeted per-dialect tests).

- [ ] **Step 2: Run lint + format check**

```
npm run lint && npm run format:check
```

Expected: no warnings, no errors.

- [ ] **Step 3: Confirm no stale references in the source tree**

```
rg "lookupDialect|et4950FamilyDialect|et2750Dialect|xp7100Dialect|et2950Dialect|buildParaAdf|buildParaFlatbedTls|buildParaFlatbedPlain" src/ docs/PROTOCOL-REFERENCE.md
```

Expected: no results (or only comments that explicitly reference the refactor history, e.g. release notes).

The search deliberately excludes `docs/superpowers/**` — this plan and the design spec under `docs/superpowers/specs/` legitimately reference the deleted identifiers as part of describing the refactor.

- [ ] **Step 4: Confirm the production behaviour smoke test**

Since this is a refactor with byte-equivalent output, the strongest smoke test is the existing replay suite, already covered by Step 1. No further runtime smoke test required.

(Optional, only if hardware available: run `npm run dev` against a real ET-4950 and confirm one panel-initiated flatbed scan still produces a valid JPG. The replay tests already prove this at the byte level — this is belt-and-braces.)

- [ ] **Step 5: Push the branch**

```
git push -u origin research/para-variation-analysis
```

(or whichever branch this work lives on)

- [ ] **Step 6: Open the PR**

```
gh pr create --base main --head research/para-variation-analysis \
  --title "refactor(esci2): parameterised dialect composer (Spec 1)" \
  --body "$(cat <<'EOF'
## Summary

- Replaces four per-family ESC/I-2 dialect files + hardcoded buildPara* with one parameterised composer driven by a typed registry.
- Known printers stay byte-identical on the wire (replay tests pinned to existing fixtures).
- Foundation for Spec 2 (unknown-fingerprint auto-dispatch); does not change user-visible behaviour.

Spec: \`docs/superpowers/specs/2026-05-27-broader-compatibility-design.md\`

## Test plan

- [ ] \`npm test\` green locally
- [ ] \`npm run lint\` + \`npm run format:check\` green
- [ ] CI green
EOF
)"
```

---

## Spec coverage check (self-review)

Walking through each spec section to confirm a task implements it:

- **Section 1 (Architecture)** — `composePara` + `ParaSpec` types: Task 4. `makeParaSpec` + `lookupRegistryEntry` + `applyEntrySourceOverride`: Task 6.
- **Section 2 (Registry shape)** — Task 5.
- **Section 3 (Composer body assembly + validation)** — Task 4.
- **Section 4 (Dispatch flow)** — Task 7 covers both the INIT1_CAPA swap and the PARA-build call site (committed together to avoid intermediate red).
- **Section 5 (Test strategy)** — Tier 1 covered by existing replay tests preserved through Task 7, plus Task 7 Step 0 tightens the ET-2750 replay with a byte-equivalence assertion (parity with the XP-7100 replay). Tier 2 composer/dispatch tests in Tasks 4, 5, 6. Per-dialect test retargeting (including XP-7100 PDF `.bin` equality) in Task 8.
- **Section 6 (Error handling)** — `UnsupportedDialectError` preserved (Task 1 relocates; Task 6 owns the throw site via `lookupRegistryEntry`). Composer input validation (Task 4).
- **Section 7 (Files + Migration)** — Deletions (including the now-orphaned `dialect-registry.test.ts`) in Task 9. Docs in Task 10.
- **Future work** — Out of scope for this plan, no tasks needed.

No spec gaps identified.

## Implementation notes for whichever engineer/agent picks this up

- **TDD throughout.** Each new module (Tasks 1–6) writes tests before implementation. Task 4 specifically has a "see tests fail, then implement" sequence within a single task to avoid a red-commit boundary. The refactor tasks (7 + 8) lean on the existing replay tests as their definition of done.
- **Replay tests are the regression net.** If `scanner.test.ts` fails after Task 7, the composer is not byte-equivalent to the legacy builder — debug the data files and composer logic, not the fixture.
- **The `et4950-stock` LUT is not a strict `[0..255]` identity.** GRN is sequential but RED skips `0x14` / duplicates `0xc6`, BLU duplicates `0x24` / skips `0xa6`. Verify against `src/esci2/commands.ts:91-115` of the pre-refactor code (or `git show HEAD~N:src/esci2/commands.ts` after the deletion in Task 9). Tests in Task 2 pin these anomalies.
- **Token spellings have no spaces between key and value.** `#QITOFF ` (the trailing space is part of `OFF `), `#CCTCOL `, `#PAGd000`, `#GMMUG10`, `#BSZi1048576`. Test in Task 4 pins this.
- **Segment order**: `#CMX` before `#QIT` before `#CCT`. The composer test in Task 4 pins this.
- **No red commits.** Every task ends with a green test suite. Tasks 4 and 7 internally have multi-step sequences where intermediate states would be red — the commit is held until the final step makes the suite green.
