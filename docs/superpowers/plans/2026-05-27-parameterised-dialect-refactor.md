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

**Files:**
- Create: `src/esci2/diagnostic.ts`
- Modify: `src/esci2/dialect-registry.ts` (re-export from new location to preserve callers)

**Steps:**

- [ ] **Step 1: Create the new module**

```ts
// src/esci2/diagnostic.ts
import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";

export class UnsupportedDialectError extends Error {
  constructor(
    public readonly capaFingerprint: string,
    public readonly diagnostic: string,
  ) {
    super(
      `Unsupported printer CAPA fingerprint ${capaFingerprint}. Please file an issue with the diagnostic block below:\n\n${diagnostic}`,
    );
    this.name = "UnsupportedDialectError";
  }
}

/**
 * Renders a copy-pasteable diagnostic block for the UnsupportedDialectError
 * raised when CAPA fingerprint doesn't resolve. Includes everything a
 * maintainer needs to add a new dialect or reproduce locally.
 *
 * Relocated from dialect-registry.ts. The body of this function is moved
 * verbatim — do not change the rendering or test fixtures pinned to the
 * exact output will break.
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
  const hasFlatbed = info.segments.some((s) => s.startsWith("#FB "));
  const hasAdf = info.segments.some((s) => s.startsWith("#ADF"));
  const hasDuplex = capa.adfDuplex;
  const yn = (v: boolean) => (v ? "Y" : "N");
  return [
    `CAPA fingerprint:  ${args.fingerprint}`,
    `PRD:               PID ${info.prdPid ?? "(absent)"}`,
    `Firmware:          ${info.firmware ?? "(absent)"}`,
    `Transport:         ${transportLabel}`,
    `Source caps:       flatbed: ${yn(hasFlatbed)}  ADF: ${yn(hasAdf)}  duplex: ${yn(hasDuplex)}`,
    `Scan area (FB):    ${info.fbArea ?? "(absent)"}`,
    `Scan area (ADF):   ${info.adfArea ?? "(absent)"}`,
    `GMM list:          ${capa.gmmList ?? "(absent)"}`,
    `CMX list:          ${capa.cmxList ?? "(absent)"}`,
    `QIT list:          ${capa.qitList ?? "(absent)"}`,
    `FMT list:          ${capa.fmtList ?? "(absent)"}`,
    `INFO segments:     ${info.segments.length}`,
    `CAPA segments:     ${capa.segments.length}`,
  ].join("\n");
}
```

- [ ] **Step 2: Update `dialect-registry.ts` to re-export**

Open `src/esci2/dialect-registry.ts`. Remove the `buildDiagnostic` function body and the now-unused `parseCapaTokens` / `parseInfoTokens` imports. Add:

```ts
export { buildDiagnostic, UnsupportedDialectError } from "./diagnostic.js";
```

If `dialect-registry.ts` currently defines `UnsupportedDialectError` inline (which it likely does given today's strict-gate behaviour), delete the inline definition — `diagnostic.ts` now owns it.

- [ ] **Step 3: Run the test suite**

```
npx vitest run src/esci2/ --reporter=verbose
```

Expected: all 252 tests pass. The diagnostic block format hasn't changed, just its physical location. Any test asserting against the error's `diagnostic` property continues to work.

- [ ] **Step 4: Lint + format**

```
npm run lint && npm run format:check
```

- [ ] **Step 5: Commit**

```
git add src/esci2/diagnostic.ts src/esci2/dialect-registry.ts
git commit -m "refactor(esci2): extract buildDiagnostic + UnsupportedDialectError into diagnostic.ts"
```

---

### Task 2: Add `gamma-classes.ts` data module

**Files:**
- Create: `src/esci2/data/gamma-classes.ts`
- Create: `src/esci2/data/gamma-classes.test.ts`

The classes are 804-byte verbatim copies of the three concatenated `#GMT{GRN,RED,BLU} h100<256-byte LUT>` segments from existing builders. Source line ranges (in current code) to copy from:

- `et4950-stock` (used by ET-4950 family, ET-2750, ET-2950): lines 99–115 of `src/esci2/commands.ts` (the hex inside `buildParaFlatbedTls`'s `bodyHex`, starting at the byte sequence `23474d545245442068313030` for `#GMTRED h100`). The exact three segments span offsets 60..864 of the resulting 928-byte body — that is, bytes 60..328 (#GMTGRN), 328..596 (#GMTRED), 596..864 (#GMTBLU). Reuse the hex literal directly.
- `xp7100-jpg`: comes from XP-7100's captured flatbed-JPG body; the existing dialect file `src/esci2/dialects/xp-7100.ts` defines inlined per-source/per-action bodies — extract from the flatbed JPG body's bytes 60..864.
- `xp7100-pdf`: same offsets from XP-7100's PDF base body (also inlined in `xp-7100.ts`).

**Steps:**

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
    // RED LUT bytes start at offset 268 + 12 = 280. Sequential identity would
    // place 0x14 at offset 280+20 = 300, but the captured bytes skip it. This
    // test pins the documented anomaly so a future regenerated identity LUT
    // doesn't silently break replay parity.
    const red = GAMMA_CLASSES["et4950-stock"].subarray(280, 280 + 256);
    expect(red[20]).toBe(0x13);
    expect(red[21]).toBe(0x15); // the 0x14 skip
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

- [ ] **Step 3: Implement the data module**

```ts
// src/esci2/data/gamma-classes.ts

/**
 * Named gamma-LUT class definitions.
 *
 * Each class is the verbatim 804-byte sequence of three `#GMT{GRN,RED,BLU} h100`
 * segments (4-byte `#GMT` key + 8-byte channel/version + 256-byte LUT, ×3).
 * Bytes are captured from real-hardware fixtures — never algorithmically
 * generated.
 *
 * Important: the `et4950-stock` LUT is NOT a strict mathematical [0..255]
 * identity. GRN happens to be sequential, but RED skips 0x14 and duplicates
 * 0xc6; BLU duplicates 0x24 and skips 0xa6. These anomalies are present in
 * the captured Frida fixture and replay tests pin them. Do not "fix" them.
 */
export type GammaClassName = "et4950-stock" | "xp7100-jpg" | "xp7100-pdf";

const ET4950_STOCK_HEX = "<PASTE 1608 hex chars here — see step 3 instructions below>";
const XP7100_JPG_HEX   = "<PASTE 1608 hex chars here — see step 3 instructions below>";
const XP7100_PDF_HEX   = "<PASTE 1608 hex chars here — see step 3 instructions below>";

export const GAMMA_CLASSES: Readonly<Record<GammaClassName, Buffer>> = {
  "et4950-stock": Buffer.from(ET4950_STOCK_HEX, "hex"),
  "xp7100-jpg":   Buffer.from(XP7100_JPG_HEX, "hex"),
  "xp7100-pdf":   Buffer.from(XP7100_PDF_HEX, "hex"),
};
```

**Filling in the three hex literals**:

1. Open `src/esci2/commands.ts` and locate `buildParaFlatbedTls()` (around line 87). The `bodyHex` string is the 928-byte ET-4950 flatbed PARA. Offsets 60..864 (in bytes) cover the three `#GMT` segments. In hex-character terms that is character positions 120..1728 of `bodyHex` (each byte is 2 chars).

2. Concatenate the line-broken hex segments between those bounds, drop the `"` and `+` boundaries, and paste as `ET4950_STOCK_HEX`. Verify the resulting buffer is exactly 804 bytes (1608 hex chars).

3. For `XP7100_JPG_HEX`, open `src/esci2/dialects/xp-7100.ts`, find `JPG_FLATBED_BASE` (or the equivalent flatbed-JPG body), extract offsets 60..864 the same way.

4. For `XP7100_PDF_HEX`, find the corresponding flatbed-PDF body or the PDF_SINGLE constant and extract offsets 60..864.

5. Run the test (next step). If sizes are wrong, you got the offsets wrong.

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

- [ ] **Step 3: Implement the module**

```ts
// src/esci2/data/cmx-classes.ts

/**
 * Named CMX-segment class definitions. Each class is the verbatim 24-byte
 * `#CMX…` segment from a captured fixture. Bytes are inlined as hex
 * literals — never algorithmically generated.
 */
export type CmxClassName = "et2750-um08" | "xp7100-jpg" | "xp7100-pdf";

// ET-2750 #CMX bytes — from buildParaFlatbedPlain in commands.ts, offsets 864..888.
const ET2750_UM08_HEX = "23434d58554d303868303039200000002000000020000000";

// XP-7100 #CMX bytes — extract from xp-7100.ts JPG_FLATBED_BASE and PDF_SINGLE,
// offsets 864..888 of each body. Each is 48 hex chars (24 bytes).
const XP7100_JPG_HEX = "<PASTE 48 hex chars from xp-7100.ts JPG body offsets 864..888>";
const XP7100_PDF_HEX = "<PASTE 48 hex chars from xp-7100.ts PDF body offsets 864..888>";

export const CMX_CLASSES: Readonly<Record<CmxClassName, Buffer>> = {
  "et2750-um08": Buffer.from(ET2750_UM08_HEX, "hex"),
  "xp7100-jpg": Buffer.from(XP7100_JPG_HEX, "hex"),
  "xp7100-pdf": Buffer.from(XP7100_PDF_HEX, "hex"),
};
```

Extract the XP-7100 hex from `src/esci2/dialects/xp-7100.ts`. The dialect inlines `JPG_FLATBED_BASE` and `PDF_SINGLE` constants (or similar — exact identifier per current file). Offset 864 in bytes = character position 1728 in the hex string. Take 48 hex chars (24 bytes) from there.

Run the tests after pasting each. Sizes mismatched = wrong offsets.

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
    expect(body.subarray(off, off + 40).toString("ascii")).toBe(
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
    expect(body.subarray(off, off + 40).toString("ascii")).toBe(
      "#ACQi0000069i0000000i0002481i0003506",
    );
  });

  it("renders 0-padded values up to 7 digits", () => {
    const body = composePara({
      ...baselineSpec(),
      fbExtents: { x0: 12345, y0: 6789, w: 100, h: 9999999 },
    });
    const off = findSegmentOffset(body, "#ACQ");
    expect(body.subarray(off, off + 40).toString("ascii")).toBe(
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

- [ ] **Step 3: Run tests to verify they all fail**

```
npx vitest run src/esci2/para-composer.test.ts
```

Expected: all tests FAIL (composePara throws "not implemented").

- [ ] **Step 4: Commit the failing-test scaffolding**

```
git add src/esci2/para-composer.ts src/esci2/para-composer.test.ts
git commit -m "test(esci2): add full para-composer unit-test suite (skeleton implementation)"
```

---

### Task 5: Implement `composePara` body — all segments and validation

**Files:**
- Modify: `src/esci2/para-composer.ts`

This is the meat of the refactor. Implement `composePara` such that all tests from Task 4 pass.

**Steps:**

- [ ] **Step 1: Replace the stub `composePara` with the full implementation**

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

- [ ] **Step 2: Run the composer tests**

```
npx vitest run src/esci2/para-composer.test.ts --reporter=verbose
```

Expected: all tests PASS. If any fail, fix the specific issue (likely a segment-order or token-spelling bug).

- [ ] **Step 3: Run the full esci2 suite to confirm no other regressions**

```
npx vitest run src/esci2/
```

Expected: all 252 tests pass (existing 252 + new para-composer tests). The composer is not yet wired into the graph, so other tests continue to use the legacy builders unchanged.

- [ ] **Step 4: Commit**

```
git add src/esci2/para-composer.ts
git commit -m "feat(esci2): implement composePara"
```

---

### Task 6: Add `dialects/registry.ts` with all four printer entries

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

### Task 7: Add `dialects/dispatch.ts` (lookup + override + makeParaSpec)

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

### Task 8: Rename `ctx.dialect` → `ctx.entry` and rewire INIT1_CAPA in `graph.ts`

**Files:**
- Modify: `src/esci2/graph.ts`

This task swaps the graph's lookup from the legacy `lookupDialect` to the new `lookupRegistryEntry` + `applyEntrySourceOverride`. After this task the replay tests should all still pass because the new pipeline is functionally identical for known printers.

**Steps:**

- [ ] **Step 1: Update the `Esci2Ctx` interface**

Open `src/esci2/graph.ts`. Find `interface Esci2Ctx` (around line 38). Replace:

```ts
  dialect: Dialect | undefined;
```

with:

```ts
  entry: RegistryEntry | undefined;
```

Update the `import` at the top of the file: remove `Dialect` import, add `RegistryEntry` import from `./dialects/registry.js`.

- [ ] **Step 2: Update the legacy override helper to call the new one**

Find `applyDialectSourceOverride` (around line 83). Replace its body:

```ts
export function applyEntrySourceOverride(ctx: Esci2Ctx, entry: RegistryEntry): void {
  if (entry.sourceDetection === "fixed-flatbed") {
    ctx.source = "flatbed";
  }
}
```

(Effectively rename the function and parameter, no behaviour change.) Also remove its old name from any export aggregator if applicable.

Better: delete the inline definition in graph.ts entirely and import the canonical implementation from `./dialects/dispatch.js`. Replace `applyDialectSourceOverride(ctx, dialect)` call sites later with `applyEntrySourceOverride(ctx, ctx.entry!)`.

- [ ] **Step 3: Update the INIT1_CAPA handler to call `lookupRegistryEntry`**

Find the INIT1_CAPA_DATA handler (likely around graph.ts:318, where `lookupDialect` is currently called). It currently does roughly:

```ts
const fingerprint = computeCapaFingerprint(packet.payload);
const dialect = lookupDialect(fingerprint);
if (dialect === null) {
  const diagnostic = buildDiagnostic({ ... });
  return { error: new UnsupportedDialectError(fingerprint, diagnostic) };
}
ctx.dialect = dialect;
applyDialectSourceOverride(ctx, dialect);
```

Replace with:

```ts
const fingerprint = computeCapaFingerprint(packet.payload);
try {
  ctx.entry = lookupRegistryEntry(fingerprint, ctx.capaBody, ctx.infoBody, ctx.transport);
} catch (err) {
  return { error: err as Error };
}
applyEntrySourceOverride(ctx, ctx.entry);
```

Import `lookupRegistryEntry` and `applyEntrySourceOverride` from `./dialects/dispatch.js`. Remove the old `lookupDialect`, `applyDialectSourceOverride`, `buildDiagnostic`, `UnsupportedDialectError` imports if no longer used in this file.

- [ ] **Step 4: Update all `ctx.dialect!.xxx` references**

Find every `ctx.dialect!.sourceDetection`, `ctx.dialect!.initPollIterations`, and `ctx.dialect!.buildPara` in graph.ts (rough locations: lines 557, 599, 622).

- Replace `ctx.dialect!.sourceDetection` with `ctx.entry!.sourceDetection`.
- Replace `ctx.dialect!.initPollIterations` with `ctx.entry!.initPollIterations`.
- Leave the PARA-build call site for Task 9 (next).

- [ ] **Step 5: Compile-check via the test suite**

```
npx vitest run src/esci2/
```

Expected: tests may fail at PARA-build (still using `ctx.dialect!.buildPara`) — this is the next task. The INIT1 + init-poll changes should not break compilation.

If TypeScript compilation fails (likely because the PARA-build line still references `ctx.dialect`), temporarily leave the PARA-build site as `ctx.dialect!.buildPara(...)` and adjust Esci2Ctx to keep BOTH `dialect` and `entry` populated through this transition step. Then Task 9 cleans up.

Alternative cleaner approach (recommended): do steps 4 and the PARA-build swap (Task 9) in one commit so the build is never broken. Combine Tasks 8 and 9 into a single commit if so. The skill's guidance ("frequent commits") leaves this judgement open — pick whichever keeps `npx vitest run src/esci2/` green between commits.

- [ ] **Step 6: Commit (after Task 9 if combined)**

If splitting: commit after running the suite green.

```
git add src/esci2/graph.ts
git commit -m "refactor(esci2): rename ctx.dialect → ctx.entry and rewire INIT1_CAPA dispatch"
```

---

### Task 9: Rewire the PARA-build call site

**Files:**
- Modify: `src/esci2/graph.ts`

**Steps:**

- [ ] **Step 1: Replace the PARA-build call site**

Find `buildParaSend(ctx)` (around graph.ts:621). It currently calls:

```ts
const paraPayload = ctx.dialect!.buildPara({
  source: ctx.source,
  duplex: ctx.duplex,
  action: ctx.action,
});
```

Replace with:

```ts
const paraSource: ParaSpec["source"] =
  ctx.source === "flatbed"
    ? "flatbed"
    : ctx.duplex
      ? "adf-duplex"
      : "adf-simplex";
const spec = makeParaSpec(ctx.entry!, paraSource, ctx.action);
const paraPayload = composePara(spec);
```

Add imports at the top of graph.ts:

```ts
import { composePara, type ParaSpec } from "./para-composer.js";
import { makeParaSpec } from "./dialects/dispatch.js";
```

- [ ] **Step 2: Run the full esci2 suite — the moment of truth**

```
npx vitest run src/esci2/ --reporter=verbose
```

Expected: **all 252 + new tests pass**, including every replay test (`scanner.test.ts`, all four `dialects/*.test.ts`). If any replay test fails, the composer + registry are not byte-equivalent to the legacy builders for that fixture — investigate the diff and fix in the data files or composer logic. Do NOT modify the fixture.

Common causes of replay test failures at this point:
- Wrong byte offset when extracting gamma/CMX class hex from current builder.
- Off-by-one in segment order.
- Token spelling (e.g. accidentally typed `#QIT OFF ` with a space).
- Extents mismatch in a registry entry.

- [ ] **Step 3: Commit**

```
git add src/esci2/graph.ts
git commit -m "refactor(esci2): rewire PARA build to use composePara + makeParaSpec"
```

---

### Task 10: Update per-dialect test files to assert against the new pipeline

**Files:**
- Modify: `src/esci2/dialects/et-4950-family.test.ts`
- Modify: `src/esci2/dialects/et-2750.test.ts`
- Modify: `src/esci2/dialects/xp-7100.test.ts`
- Modify: `src/esci2/dialects/et-2950.test.ts`

These tests currently assert against the `Dialect` object's properties and call `buildPara` directly. After the refactor, they need to assert against the registry entry + use the composer.

The Tier 1 byte-equivalence guarantee is already covered by `scanner.test.ts` (the full replay suite) — these per-dialect tests are unit-level assertions of "the right shape per printer". Keep that contract; just change the API.

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

- [ ] **Step 3: Rewrite `xp-7100.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { REGISTRY } from "./registry.js";
import { composePara } from "../para-composer.js";
import { makeParaSpec } from "./dispatch.js";

const XP7100_FP = "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e";
const entry = REGISTRY.get(XP7100_FP)!;

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

describe("XP-7100 composed PARA size", () => {
  it("flatbed JPG is 944 bytes", () => {
    expect(composePara(makeParaSpec(entry, "flatbed", "jpg")).length).toBe(944);
  });
  it("adf-simplex JPG is 952 bytes", () => {
    expect(composePara(makeParaSpec(entry, "adf-simplex", "jpg")).length).toBe(952);
  });
  it("adf-duplex JPG is 956 bytes", () => {
    expect(composePara(makeParaSpec(entry, "adf-duplex", "jpg")).length).toBe(956);
  });
});

describe("XP-7100 action axis", () => {
  it("flatbed JPG and PDF produce DIFFERENT bytes (action-aware)", () => {
    const jpg = composePara(makeParaSpec(entry, "flatbed", "jpg"));
    const pdf = composePara(makeParaSpec(entry, "flatbed", "pdf"));
    expect(jpg.equals(pdf)).toBe(false);
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

### Task 11: Delete the old dialect files and legacy `buildPara*` helpers

**Files:**
- Delete: `src/esci2/dialects/et-4950-family.ts`
- Delete: `src/esci2/dialects/et-2750.ts`
- Delete: `src/esci2/dialects/xp-7100.ts`
- Delete: `src/esci2/dialects/et-2950.ts`
- Delete: `src/esci2/dialect-registry.ts`
- Modify: `src/esci2/commands.ts` (remove `buildParaAdf`, `buildParaFlatbedTls`, `buildParaFlatbedPlain`)
- Modify: `src/esci2/dialect.ts` (trim/remove the old `Dialect` interface if still present)

**Steps:**

- [ ] **Step 1: Delete the four dialect files and the legacy registry**

```
git rm src/esci2/dialects/et-4950-family.ts
git rm src/esci2/dialects/et-2750.ts
git rm src/esci2/dialects/xp-7100.ts
git rm src/esci2/dialects/et-2950.ts
git rm src/esci2/dialect-registry.ts
```

- [ ] **Step 2: Remove the legacy builders from `commands.ts`**

Open `src/esci2/commands.ts`. Find and delete:

- `export function buildParaAdf(duplex: boolean): Buffer { ... }`
- `export function buildParaFlatbedTls(): Buffer { ... }`
- `export function buildParaFlatbedPlain(): Buffer { ... }`

Plus their leading doc comments and any `// Blob transcribed from ...` headers.

Keep `buildEsci2Command`, `buildParaHeader`, `parseEsci2ReplyHeader`, and any other helpers — they're still used.

- [ ] **Step 3: Trim `dialect.ts`**

Open `src/esci2/dialect.ts`. If the file still exports `Dialect` or `ParaAxes` types, decide:

- If anything still imports them: keep, but trim to just what's used.
- If nothing imports them: delete the whole file via `git rm src/esci2/dialect.ts`.

`ParaAxes` is unlikely to survive — it was the legacy `(source, duplex, action)` tuple, replaced by the call-site derivation in graph.ts.

- [ ] **Step 4: Verify the build still compiles**

```
npx vitest run src/esci2/
```

Expected: all tests pass. If any import error: there's a stale reference to the deleted files somewhere; find with `grep -rn "buildParaFlatbedTls\|buildParaAdf\|buildParaFlatbedPlain\|et4950FamilyDialect\|et2750Dialect\|xp7100Dialect\|et2950Dialect\|lookupDialect" src/` and remove.

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

### Task 12: Update `docs/PROTOCOL-REFERENCE.md`

**Files:**
- Modify: `docs/PROTOCOL-REFERENCE.md`

**Steps:**

- [ ] **Step 1: Find the "How printer-model differences are handled" section**

```
grep -n "printer-model differences" docs/PROTOCOL-REFERENCE.md
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

### Task 13: Final-pass verification

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
grep -rn "lookupDialect\|et4950FamilyDialect\|et2750Dialect\|xp7100Dialect\|et2950Dialect\|buildParaAdf\|buildParaFlatbedTls\|buildParaFlatbedPlain" src/ docs/
```

Expected: no results (or only comments that explicitly reference the refactor history, e.g. release notes).

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

Spec: `docs/superpowers/specs/2026-05-27-broader-compatibility-design.md`

## Test plan

- [ ] `npm test` green locally
- [ ] `npm run lint` + `npm run format:check` green
- [ ] CI green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Spec coverage check (self-review)

Walking through each spec section to confirm a task implements it:

- **Section 1 (Architecture)** — `composePara` + `ParaSpec` types: Tasks 4–5. `makeParaSpec` + `lookupRegistryEntry` + `applyEntrySourceOverride`: Task 7.
- **Section 2 (Registry shape)** — Task 6.
- **Section 3 (Composer body assembly + validation)** — Task 5.
- **Section 4 (Dispatch flow)** — Tasks 8 + 9 cover the INIT1_CAPA swap and PARA-build call site.
- **Section 5 (Test strategy)** — Tier 1 covered by existing replay tests preserved through Tasks 8–9. Tier 2 composer/dispatch tests in Tasks 4, 6, 7. Per-dialect test retargeting in Task 10.
- **Section 6 (Error handling)** — `UnsupportedDialectError` preserved (Task 1 relocates; Task 7 throw site). Composer input validation (Task 5).
- **Section 7 (Files + Migration)** — Deletions in Task 11. Docs in Task 12.
- **Future work** — Out of scope for this plan, no tasks needed.

No spec gaps identified.

## Implementation notes for whichever engineer/agent picks this up

- **TDD throughout.** Each new module (Tasks 1–7) writes tests before implementation. Each refactor task (Tasks 8–11) leans on the existing replay tests as its definition of done.
- **Replay tests are the regression net.** If `scanner.test.ts` fails after Task 9, the composer is not byte-equivalent to the legacy builder — debug the data files and composer logic, not the fixture.
- **The `et4950-stock` LUT is not a strict `[0..255]` identity.** GRN is sequential but RED skips `0x14` / duplicates `0xc6`, BLU duplicates `0x24` / skips `0xa6`. Verify against `src/esci2/commands.ts:91-115` of the pre-refactor code (or `git show HEAD~10:src/esci2/commands.ts` after the deletion in Task 11). Tests in Task 2 pin these anomalies.
- **Token spellings have no spaces between key and value.** `#QITOFF ` (the trailing space is part of `OFF `), `#CCTCOL `, `#PAGd000`, `#GMMUG10`, `#BSZi1048576`. Test in Task 4 pins this.
- **Segment order**: `#CMX` before `#QIT` before `#CCT`. The composer test in Task 4 pins this.
- **Frequent commits** — every task ends with one commit. Don't batch multiple tasks into one commit.
