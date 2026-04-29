# WF-3620 support — design

Date: 2026-04-29
Status: approved (brainstorm), pending spec self-review and user spec review.
Tracking issue: https://github.com/mtheuma/epson2paperless/issues/24

## 1. Background

`epson2paperless` was built against the **Epson ET-4950**, a 2024-era printer
that exposes its scan-to-computer flow as TLS 1.2 on port 1865 wrapping the
ESC/I-2 (extended) command set inside Epson's "IS" framing. The reverse-
engineering work (Frida hooks against the Windows driver's `ES2Command.dll`,
plus Wireshark captures) produced a state machine in `src/scanner.ts` that
replays the driver's behaviour byte-for-byte.

A user (maltris) reported that an **Epson WF-3620** (2014 model, USB PID
`08B8`, firmware 1.20) does not work with the current implementation.
Investigation via a Wireshark capture they provided shows the WF-3620 uses a
different protocol generation: **plain TCP on port 1865** with **legacy
ESC/I commands**, not ESC/I-2. The IS framing, multicast discovery, and
push-scan trigger layers are byte-identical to the ET-4950.

Full protocol decode lives at
`.reference/wireshark-captures/wf-3620/protocol-decode.md` (gitignored).

## 2. Scope

**In scope (v1):** support whatever the WF-3620 panel's "Scan to Computer"
button can trigger end-to-end, plus all the non-printer features the project
already has — Paperless-ngx upload, health endpoint, daemon and one-shot
modes, structured logging, graceful shutdown.

The Epson WF-3620 user manual confirms the panel "Scan to Computer" path
exposes the user to: target computer selection, output format choice (JPG
or PDF, to be confirmed by maltris), and a 2-sided toggle for ADF duplex.
The hardware has a 35-sheet DADF; flatbed is the alternative source. So
the v1 matrix is the same shape as the existing ET-4950 matrix:

- ADF + flatbed
- Simplex + duplex
- JPG + PDF
- Single page + multi-page

**Out of scope (v1):**

- Panel options that don't reach our service: "Memory Device", "Cloud", "Computer (WSD)".
- Resolution / colour-mode / DPI selection from any source other than the panel default.
- Other Epson models in the same protocol generation as the WF-3620 — the
  legacy code path will accept them if their command set matches, but we
  only commit to the WF-3620 in v1.

## 3. Architecture overview

```
                    Push-scan trigger (port 2968 SOAP)
                              │   ProductNameIn=PID xxxx
                              │   PushScanIDIn=<sides+action>
                              ▼
                       ┌──────────────┐
                       │  dispatcher  │  ← reads PRINTER_PROTOCOL env var
                       │              │  ← probes TLS:1865 if unset
                       └──────┬───────┘
                              │ variant: "esci2" | "legacy"
              ┌───────────────┴──────────────┐
              ▼                              ▼
   ┌─────────────────────┐      ┌─────────────────────────┐
   │ scanner.ts          │      │ scanner-legacy.ts (new) │
   │ (ET-4950, ESC/I-2,  │      │ (WF-3620, legacy ESC/I, │
   │  TLS, host-pull)    │      │  plain TCP, push stream)│
   └──────────┬──────────┘      └──────────┬──────────────┘
              │                            │
              │  per-page JPEG buffers in session temp dir
              │                            │
              └─────────────┬──────────────┘
                            ▼
              ┌──────────────────────────────┐
              │ output-tail.ts (extracted)   │
              │  EXIF inject → JPG promote   │
              │  or pdf-lib compose → write  │
              │  → Paperless upload          │
              │  → temp dir cleanup          │
              └──────────────────────────────┘
```

**Key shape decisions:**

- **Two parallel scanner files.** `scanner.ts` stays as-is. `scanner-legacy.ts`
  is a new sibling. The two state machines have fundamentally different
  shapes (host-pull JPEG loop vs printer-push raw stream); a strategy
  interface that fits both ends up either bloated or shallow. If a third
  protocol variant ever appears, we revisit and refactor at that point.

- **Shared post-scan tail.** The work after the IMG loop ends — page flush,
  EXIF orientation injection, JPG promote or PDF compose, Paperless upload,
  temp dir cleanup — is identical for both variants. Extracted from
  `scanner.ts`'s inline `finalizeScan` into a new `output-tail.ts` module
  that both scanners call.

- **Variant dispatcher.** A new `protocol-probe.ts` module decides which
  variant to use, called once per scan session before connecting. Result
  is cached per printer IP for the daemon's process lifetime; one-shot
  mode probes on every invocation (cheap).

## 4. Protocol layers — what stays, what changes

| Layer | ET-4950 (current) | WF-3620 (new) | Implementation |
|-------|-------------------|---------------|----------------|
| Multicast discovery `239.255.255.253:2968` | `keepalive.ts` + `network.ts` | byte-identical | shared, no change |
| Push-scan trigger TCP 2968 SOAP | `pushscan.ts` | byte-identical envelope, same `PushScanIDIn` semantics | shared, no change |
| Transport (port 1865) | TLS 1.2 | plain TCP | per-variant |
| IS framing (12-byte header, magic `IS`) | `protocol.ts` | byte-identical | shared, no change |
| Welcome packet | `49538000300c0000000500000102000000` | identical | shared |
| LOCK / UNLOCK | IS types `0x2100` / `0x2101` | identical | shared |
| Passthru envelope | `[cmd_size][reply_size][cmd]` | identical | shared |
| Init | `FS Y` (`1c 59`) → ESC/I-2 mode | `ESC @` (`1b 40`) → legacy | per-variant |
| Capability discovery | `INFO` / `CAPA` / `RESA` two-phase reads | `FS I` 80-byte fixed reply | per-variant |
| Source select | encoded in PARA tokens | `ESC e <0\|1>` separate command | per-variant |
| Gamma curves | none (handled by printer firmware) | 3× `ESC z` + 256-byte LUT per channel | per-variant |
| Scan parameters | PARA: ~936-byte ASCII `#KEY` token blob | `FS W` + 64-byte binary block | per-variant |
| Start scan | `TRDT` ESC/I-2 cmd | `FS G` (returns 14-byte image-spec) | per-variant |
| Image transport | host-pull `@IMG` loop, JPEG-encoded chunks | printer-push `IS 0xa200` chunks, raw pixels | per-variant |
| Per-page output | already JPEG, write to temp | sharp encode raw → JPEG, write to temp | per-variant; sharp wrapper inside `scanner-legacy.ts` |
| Post-scan drain | `FS Y / STAT / pure-read / FIN` × 2 | `FS F` once + `ESC )` × 2 | per-variant |
| EXIF orientation, PDF compose, Paperless upload, temp cleanup | inline in `scanner.ts`'s `finalizeScan` | same outputs needed | shared (extract to `output-tail.ts`) |
| Health check | `health.ts` | unchanged | shared |
| Lifecycle / shutdown | `lifecycle.ts` | unchanged | shared |
| Logging / config | `logger.ts` / `config.ts` | unchanged + 1 new env var + 1 optional | shared, additive |

## 5. Variant detection (`protocol-probe.ts`)

```ts
async function detectVariant(printerIp: string, port: number): Promise<"esci2" | "legacy"> {
  // 1. Explicit override from config.PRINTER_PROTOCOL.
  if (config.PRINTER_PROTOCOL === "esci2" || config.PRINTER_PROTOCOL === "legacy") {
    return config.PRINTER_PROTOCOL;
  }

  // 2. TLS probe with a 3000 ms timeout.
  //    - Successful TLS handshake → variant=esci2. Tear down the probe socket;
  //      the scanner opens its own connection.
  //    - ERR_SSL_WRONG_VERSION_NUMBER (or first byte not in 0x14-0x17 range,
  //      i.e. not a TLS record header) → variant=legacy.
  //    - Other TLS errors → propagate (genuine connection failure).
  //    - Timeout → propagate.
}
```

The probe always closes its socket and returns only the variant string;
the scanner opens its own connection. We don't reuse the probe socket as
the scan socket — the simpler API contract is worth more than the ~50 ms
saved on the first scan after daemon start.

Daemon caches the result per printer IP for the process lifetime so we don't
probe on every scan. Restart re-probes. One-shot mode probes per invocation.

## 6. Legacy scanner state machine

`scanner-legacy.ts` follows the same scaffolding as `scanner.ts` (closure-
captured state, IS packet parser loop, `transitionToError`, timeout reset,
async event dispatch on `0x9000`) but with a different state set:

```
CONNECTING → WELCOME → LOCKING
  → INIT          (ESC @ ack)
  → IDENTITY      (FS I 80-byte read)
  → STATUS_1      (FS F 16-byte)
  → SOURCE_SET    (ESC e + 1-byte param)
  → STATUS_2      (FS F)
  → GAMMA_R / GAMMA_G / GAMMA_B   (3× ESC z + 257-byte LUT)
  → WINDOW        (FS W + 64-byte block)
  → STATUS_3      (FS F)
  → START         (FS G 14-byte read → parse expected total bytes)
  → STREAM_CONFIG (IS-0x2200 30-byte send; verbatim from capture)
  → IMG_RECEIVING (accumulate IS-0xa200 chunks until expected total reached)
  → POST_STATUS   (FS F)
  → CLEANUP_1     (ESC ))
  → CLEANUP_2     (ESC ))
  → UNLOCKING → DONE
```

**Image accumulation:** `IMG_RECEIVING` doesn't send anything; it appends
`0xa200` payloads to an in-memory buffer until it reaches the byte count
declared by FS G's 14-byte reply. The handler exit condition is "expected
bytes received" (single page) plus a hook for "page boundary signalled"
(multi-page) once we know what that signal looks like.

**Multi-page boundary signalling: deferred pending capture.** Three plausible
shapes the wire might take:

1. Each page = its own START / chunks / drain cycle (printer goes back
   through `STATUS_3 → START → IMG_RECEIVING` per page).
2. All pages stream back-to-back with an in-band marker between them
   (analogous to ET-4950's `#pen` token).
3. FS G's 14-byte reply already encodes total-pages and the host treats the
   stream as one giant accumulator that it splits at known offsets.

The state machine has placeholders for all three and gets specialised once
captured.

**Source selection bypass.** Source byte values per the capture:
`ESC e 0x00` selects flatbed, `ESC e 0x01` selects ADF. The Windows driver
probes ADF first (sending `ESC e 01` then `ESC (`), receives a NAK (`0x80`)
when the ADF is empty, then re-initialises and switches to flatbed
(`ESC e 00`). We skip this probe — we know from `PushScanIDIn` whether
the user wants ADF or flatbed and send the matching `ESC e` directly. If
the printer firmware turns out to require the probe sequence, the captures
from maltris will reveal that and we mirror it.

## 7. Image format pipeline

```
IS-0xa200 chunks ──► page buffer (Buffer)
                          │
                          ▼ at page boundary (or scan end for single-page):
                   sharp(raw, {raw: {width, height, channels}})
                     .jpeg({quality: JPEG_QUALITY})
                     .toBuffer()
                          │
                          ▼
                   write page_NN.jpg to session temp dir
                          │
                          ▼
                   set pageSide ("front" | "back") for back-page EXIF
                          │
                          ▼
              (loop until last page)
                          │
                          ▼
              call output-tail.finalizeSession()
```

Pixel format inputs to sharp (`width`, `height`, `channels`) come from FS G's
14-byte reply. We treat unknowns conservatively: if dimensions × channels
don't match observed bytes, log a clear error and abort.

**Bit depth and channel count is a v1 blocker.** We need to know whether
the format is 8-bit grayscale, 8-bit RGB, 16-bit grayscale, or some packed
arrangement before we can encode a usable JPEG. Two paths to resolve:

1. **Deduce from existing captures.** The chunks from maltris's flatbed
   capture (~108 MB total, ~1816 chunks of 59473 bytes each) plus the
   FS G dimensions (1750 × 29736 implied by the 14-byte reply) should be
   enough to back into the channel count and bit depth arithmetically.
   Likely candidates: `1750 × 29736 × 2 = 104 MB` (16-bit gray, close
   match) or `1750 × 29736 × 3 = 156 MB` (24-bit RGB, too big).
2. **Controlled-content capture from maltris.** An all-white US Letter
   sheet at default settings produces a known-pattern byte stream from
   which channel layout and bit depth fall out trivially. Cheap to ask.

We try (1) first; if the arithmetic doesn't yield a clean answer we ask
for (2).

`JPEG_QUALITY` env var (default 90) controls sharp's encoder.

## 8. New and modified modules

### New

| Path | Purpose | Approx LOC |
|------|---------|------------|
| `src/protocol-probe.ts` | TLS probe + env override | ~60 |
| `src/scanner-legacy.ts` | Legacy state machine | ~500 |
| `src/esci-legacy.ts` | Command builders, FS W blob, FS G reply parser | ~150 |
| `src/output-tail.ts` | Extracted post-IMG-loop pipeline | ~80 |
| `tools/pcap-extract/` | One-shot CLI: `.pcapng` → JSONL fixture | ~80 |

### Modified

| Path | Change |
|------|--------|
| `src/scanner.ts` | Replace inline `finalizeScan` body with a call into `output-tail.ts`. No state machine changes. |
| `src/index.ts` / `src/one-shot.ts` / `src/startup.ts` | Call `protocol-probe` after PushScan trigger arrives, dispatch to `startScanSession` (esci2) or `startScanSessionLegacy`. |
| `src/config.ts` | Add `PRINTER_PROTOCOL` and `JPEG_QUALITY`, Zod-validated. |
| `package.json` | Add `sharp` dep. |

## 9. Configuration surface

| Var | Values | Default | Effect |
|-----|--------|---------|--------|
| `PRINTER_PROTOCOL` | `auto` / `esci2` / `legacy` | `auto` | `auto` probes TLS; explicit values bypass the probe |
| `JPEG_QUALITY` | `1`–`100` | `90` | sharp encoder quality (legacy variant only) |

**Compatibility constraints:**

- `PRINTER_CERT_FINGERPRINT` (existing) only applies to the esci2 variant.
  Setting it together with `PRINTER_PROTOCOL=legacy` is a config error
  reported at startup with a clear message rather than silently ignored.
- `PREVIEW_ACTION` and other existing scan-behaviour env vars apply
  uniformly to both variants.

## 10. Testing strategy

- **`scanner.test.ts`** — unchanged. Frida-driven JPG/PDF replay matrix for ET-4950.
- **`scanner-legacy.test.ts`** — new. Pcap-extracted JSONL replay matrix:
  - flatbed simplex JPG (the capture we already have, converted via the new tool)
  - ADF simplex JPG (from maltris)
  - ADF duplex JPG (from maltris)
  - ADF simplex PDF (from maltris) — only if format flag changes wire bytes
- **`esci-legacy.test.ts`** — unit tests for command builders, FS G reply parser, FS W blob byte-equivalence per mode.
- **`protocol-probe.test.ts`** — TLS-success → esci2, `ERR_SSL_WRONG_VERSION_NUMBER` → legacy, env override, cache.
- **`output-tail.test.ts`** — direct unit coverage on the extracted module.
- **`tools/pcap-extract/`** — its own test that round-trips a known fixture.
- Sharp wrapper — known raw bytes → JPEG bytes with expected dimensions and SOI; covered inline in `scanner-legacy.test.ts` or its own file.

`.reference/wireshark-captures/wf-3620/*.pcapng` stays gitignored. Extracted
JSONL fixtures are committed under `tests/fixtures/legacy/` (parallel to
`tools/frida-capture/captures/`).

## 11. Open items pending captures

| Item | What we'll learn |
|------|------------------|
| Multi-page ADF simplex capture | Page-boundary signalling shape (cycle restart vs in-band marker vs total-pages-in-FS-G-reply) |
| Multi-page ADF duplex capture | Whether back pages need rotation; whether front/back are interleaved or front-then-all-backs |
| PDF capture | Whether the format choice changes wire bytes or whether the host always gets raw pixels |
| Panel photo + format options confirmation | README compatibility-table labels |
| All-white-sheet test capture | Pixel format (channels, bit depth). Only requested if we can't deduce these arithmetically from the existing flatbed capture (see §7). |

The state machine ships with hooks for these items but their exact
behaviour is gated on the captures arriving.

## 12. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Multi-page wire shape differs from any of the three plausible options above | Ship single-page first behind a clear scope marker; multi-page is an additive change to `IMG_RECEIVING` exit logic |
| sharp native dep breaks Docker multi-arch build | sharp publishes prebuilt binaries for x64 / arm64 on Linux / macOS / Windows; CI catches install failures pre-merge |
| Pixel format guess is wrong, JPEG output is garbled | All-white test capture removes guesswork. If we can't get one, encode multiple guesses (gray-8, RGB-8) and pick the sensible one |
| `output-tail.ts` extraction breaks ET-4950 path | `scanner.test.ts` is the regression shield — full Frida replay matrix has to keep passing pre-merge |
| Probe latency on first connect | Result cached for daemon lifetime; reuse the probe socket as the scan socket on TLS success → zero overhead first scan |
| Maltris responds slowly or not at all | Captured scope is bounded: we can ship single-page flatbed JPG with just the existing capture, and gate ADF / duplex / PDF behind getting the additional captures |
| Probe spuriously classifies a slow ESC/I-2 printer as legacy | Tight timeout (~3s) plus explicit env-var override (`PRINTER_PROTOCOL=esci2`) when the user knows their model |
