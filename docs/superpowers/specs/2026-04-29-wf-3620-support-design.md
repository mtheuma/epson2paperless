# WF-3620 support — design

Date: 2026-04-29 (revised 2026-04-30 with full capture matrix)
Status: approved; pixel format, multi-page boundary, and PDF wire effect resolved by additional captures.
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
Investigation via six Wireshark captures they provided
(flatbed/ADF × single/2-page × JPEG/PDF) shows the WF-3620 uses a different
protocol generation: **plain TCP on port 1865** with **legacy ESC/I
commands**, not ESC/I-2. The IS framing, multicast discovery, and push-scan
trigger layers are byte-identical to the ET-4950.

Full protocol decode lives at
`.reference/wireshark-captures/wf-3620/protocol-decode.md` (gitignored).

## 2. Scope

**In scope (v1):** support whatever the WF-3620 panel's "Scan to Computer"
button can trigger end-to-end, plus all the non-printer features the project
already has — Paperless-ngx upload, health endpoint, daemon and one-shot
modes, structured logging, graceful shutdown.

Maltris reports the panel's Scan submenu (translated from German):
target computer selection (USB-Connection visible — likely also network
destinations), Format: **JPEG / PDF / Email**, and **2-paged: On / Off**.
The hardware has a 35-sheet DADF; flatbed is the alternative source. So
the v1 matrix is:

- ADF + flatbed
- Simplex + duplex ("2-paged: On" = duplex, confirmed)
- JPG + PDF (Email format excluded — see below)

**Out of scope (v1):**

- Panel options that don't reach our "Scan to Computer" path: Storage
  device, Cloud, Computer (WSD).
- Email format. Maltris's panel lists it as a third Format choice but we
  have no capture for it; the wire shape is unknown and it is plausibly a
  different protocol path entirely (the printer's own SMTP client, not a
  push-scan to host). Out of v1; revisit if a user requests it.
- Resolution / colour-mode override. The firmware locks scan resolution
  to the panel's Format choice (JPEG = 600 DPI, PDF = 300 DPI). We honour
  whatever the panel sent; we don't try to override.
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

| Layer                                                         | ET-4950 (current)                          | WF-3620 (new)                                                                   | Implementation                                        |
| ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Multicast discovery `239.255.255.253:2968`                    | `keepalive.ts` + `network.ts`              | byte-identical                                                                  | shared, no change                                     |
| Push-scan trigger TCP 2968 SOAP                               | `pushscan.ts`                              | byte-identical envelope, same `PushScanIDIn` semantics                          | shared, no change                                     |
| Transport (port 1865)                                         | TLS 1.2                                    | plain TCP                                                                       | per-variant                                           |
| IS framing (12-byte header, magic `IS`)                       | `protocol.ts`                              | byte-identical                                                                  | shared, no change                                     |
| Welcome packet                                                | `49538000300c0000000500000102000000`       | identical                                                                       | shared                                                |
| LOCK / UNLOCK                                                 | IS types `0x2100` / `0x2101`               | identical                                                                       | shared                                                |
| Passthru envelope                                             | `[cmd_size][reply_size][cmd]`              | identical                                                                       | shared                                                |
| Init                                                          | `FS Y` (`1c 59`) → ESC/I-2 mode            | `ESC @` (`1b 40`) → legacy                                                      | per-variant                                           |
| Capability discovery                                          | `INFO` / `CAPA` / `RESA` two-phase reads   | `FS I` 80-byte fixed reply                                                      | per-variant                                           |
| Source select                                                 | encoded in PARA tokens                     | `ESC e <0\|1\|2>` separate command, plus duplicated as a byte at FS W offset 26 | per-variant                                           |
| Gamma curves                                                  | none (handled by printer firmware)         | 3× `ESC z` + 256-byte LUT per channel                                           | per-variant                                           |
| Scan parameters                                               | PARA: ~936-byte ASCII `#KEY` token blob    | `FS W` + 64-byte binary block                                                   | per-variant                                           |
| Start scan                                                    | `TRDT` ESC/I-2 cmd                         | `FS G` (returns 14-byte image-spec)                                             | per-variant                                           |
| Image transport                                               | host-pull `@IMG` loop, JPEG-encoded chunks | printer-push `IS 0xa200` chunks of 59473-byte raw 24-bit RGB                    | per-variant                                           |
| Per-page output                                               | already JPEG, write to temp                | sharp encode raw RGB → JPEG, write to temp                                      | per-variant; sharp wrapper inside `scanner-legacy.ts` |
| Per-page eject (ADF)                                          | n/a                                        | host sends `0x0c 0x00` after each page's stream completes                       | per-variant                                           |
| Post-scan drain                                               | `FS Y / STAT / pure-read / FIN` × 2        | `FS F` once + `ESC )` × 2                                                       | per-variant                                           |
| EXIF orientation, PDF compose, Paperless upload, temp cleanup | inline in `scanner.ts`'s `finalizeScan`    | same outputs needed                                                             | shared (extract to `output-tail.ts`)                  |
| Health check                                                  | `health.ts`                                | unchanged                                                                       | shared                                                |
| Lifecycle / shutdown                                          | `lifecycle.ts`                             | unchanged                                                                       | shared                                                |
| Logging / config                                              | `logger.ts` / `config.ts`                  | unchanged + 1 new env var + 1 optional                                          | shared, additive                                      |

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
  → SOURCE_SET    (ESC e + 1-byte source param: 0=flatbed, 1=ADF, 2=ADF "2-paged")
  → STATUS_2      (FS F)
  ┌─ per page ─────────────────────────────────────────────┐
  │  → GAMMA_R / GAMMA_G / GAMMA_B   (3× ESC z + 257-byte  │
  │                                   LUT, identical bytes │
  │                                   for every page)      │
  │  → WINDOW        (FS W + 64-byte block; same bytes for │
  │                   every page within one scan)          │
  │  → STATUS_3      (FS F)                                │
  │  → START         (FS G → 14-byte image-spec reply)     │
  │  → STREAM_CONFIG (IS-0x2200 38-byte send, derived from │
  │                   FS G reply)                          │
  │  → IMG_RECEIVING (accumulate IS-0xa200 chunks until    │
  │                   expected total reached, then encode  │
  │                   to JPEG and emit page_NN.jpg)        │
  │  → PAGE_EJECT    (ADF only: send `0x0c 0x00`)          │
  └────────────────────── if more pages: loop ─────────────┘
  → POST_STATUS   (FS F)
  → CLEANUP_1     (ESC ))
  → CLEANUP_2     (ESC ))
  → UNLOCKING → DONE
```

**Per-page exit condition.** `IMG_RECEIVING` reads IS-0xa200 frames and
appends payload bytes until the count matches the total derived from FS G's
14-byte reply. Confirmed by the 2-page captures: each page goes through its
own complete GAMMA_R…IMG_RECEIVING cycle, with identical FS W bytes and
identical FS G replies; only the source byte (0x02) and the per-page eject
(`0x0c 0x00`) distinguish multi-page from single-page on the wire.

**Source byte semantics (confirmed):**

- `0x00` (flatbed) → 1 cycle, no eject.
- `0x01` (ADF simplex) → N cycles + N ejects, where N is the number of
  sheets in the tray. We have a 1-sheet capture.
- `0x02` (ADF duplex, panel's "2-paged: On") → 2N cycles + 2N ejects:
  each sheet produces front-then-back. We have a 1-sheet capture (2
  cycles = front + back).

The "2-paged" toggle is the duplex switch — interpreting it as a
multi-page hint would be redundant on an ADF that already handles
multiple sheets natively, and matches the WF-3620 spec sheet's "Auto
2-Sided Scanning" feature.

**Multi-sheet ADF capture is still missing.** Both captures we have are
single-sheet (1 sheet × simplex = 1 cycle, 1 sheet × duplex = 2 cycles).
We have not seen a 3+ sheet capture in either mode, so we are extrapolating
the inter-sheet path from the inter-side path (assumed to be the same:
gamma reload → window → start → stream → `0x0c 0x00` eject). If the
firmware emits an extra command between sheets that we haven't seen,
v1 may stall mid-run for users feeding multiple sheets. Mitigation: ship
v1, ask the first multi-sheet user to capture if they hit this.

**Duplex back-page orientation.** The U-turn ADF path produces a
180°-rotated back page. v1 emits the same EXIF Orientation=3 (JPG) and
`/Rotate=180` (PDF) on every even page in duplex mode that
`scanner.ts` already does for the ET-4950. We do this from day one
rather than waiting for a user complaint, since we already have the
rotation logic and the duplex semantics are now confirmed.

**Source selection bypass.** The Windows driver always sends an `ESC (`
capability probe after setting source — the printer always NAKs (`0x80`)
on this firmware regardless of source — then re-initialises and re-sends
`ESC e`. We skip the probe and the redundant re-init: we know from
`PushScanIDIn` whether the user wants ADF or flatbed and send `ESC e`
directly with the right byte for the chosen source and pages count.

**FS W parameters.** The 64-byte block is constructed dynamically from
six inputs (X DPI, Y DPI, top-Y offset, width, height, source byte,
format byte); the rest is constant. Source 0x00/0x01/0x02 and format
0x04/0x08 are looked up from the parsed `PushScanIDIn`; DPI and dimensions
are looked up from a small hardcoded table keyed on `(format, paper-size)`
that mirrors what we observed in the captures (600 DPI for JPEG, 300 DPI
for PDF, A4 dimensions). Only A4 is in the capture set; if a user sets a
different paper size on the panel we extend the table when we get a
capture.

**Gamma LUTs.** All six captures show byte-identical R/G/B LUTs — the
driver hardcodes them rather than computing per scan. We embed the same
byte literals in `esci-legacy.ts`.

## 7. Image format pipeline

```
IS-0xa200 chunks ──► page buffer (Buffer, ~108 MB JPEG / ~27 MB PDF)
                          │
                          ▼ at end of page (chunk total reached):
                   sharp(rawBuffer, {raw: {width, height, channels: 3}})
                     .jpeg({quality: JPEG_QUALITY})
                     .toBuffer()
                          │
                          ▼
                   write page_NN.jpg to session temp dir
                          │
                          ▼
                   set pageSide ("front" for odd pages, "back" for even
                   pages, in duplex mode) so output-tail can apply
                   EXIF Orientation=3 / PDF /Rotate=180
                          │
                          ▼
              (loop until last page; ADF emits 0x0c 0x00 after each)
                          │
                          ▼
              call output-tail.finalizeSession(action)
                  → action='jpg' → promote files
                  → action='pdf' → pdf-lib compose at 300 DPI
                  → optional Paperless upload
                  → temp dir cleanup
```

**Pixel format is confirmed 24-bit RGB (3 channels, 8 bits each)** at the
panel-selected DPI. The capture matrix verifies this:

- 600 DPI A4 (JPEG mode): 4956 × 7002 × 3 = 104.1 MB raw → matches measured
  108 MB IS-0xa200 stream with chunk overhead.
- 300 DPI A4 (PDF mode): 2478 × 3501 × 3 = 26.0 MB raw → matches measured
  27 MB stream.
- 2-page ADF: exactly 2× single-page byte count.

Width / height / DPI come from the FS W block we ourselves send (we know
exactly what we requested). `channels: 3` is a fixed input to sharp. The
total expected byte count for `IMG_RECEIVING`'s exit condition is
`width × height × 3` plus the small chunk-overhead margin.

**Memory:** at 600 DPI a single page is ~108 MB held in a Buffer before
sharp encodes it. A 35-page ADF run could peak at one page (~108 MB) plus
the encoded JPEG (~5–10 MB at quality 90) in memory at any time, since we
emit + free after each page. PDF mode at 300 DPI is ~27 MB per page.
Acceptable for the deployment shape (Node service, dedicated container).
If we ever support 1200 DPI we revisit and stream into sharp's
`pipeline()` API instead of buffering.

`JPEG_QUALITY` env var (default 90) controls sharp's encoder.

## 8. New and modified modules

### New

| Path                    | Purpose                                        | Approx LOC |
| ----------------------- | ---------------------------------------------- | ---------- |
| `src/protocol-probe.ts` | TLS probe + env override                       | ~60        |
| `src/scanner-legacy.ts` | Legacy state machine                           | ~500       |
| `src/esci-legacy.ts`    | Command builders, FS W blob, FS G reply parser | ~150       |
| `src/output-tail.ts`    | Extracted post-IMG-loop pipeline               | ~80        |
| `tools/pcap-extract/`   | One-shot CLI: `.pcapng` → JSONL fixture        | ~80        |

### Modified

| Path                                                  | Change                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/scanner.ts`                                      | Replace inline `finalizeScan` body with a call into `output-tail.ts`. No state machine changes.                           |
| `src/index.ts` / `src/one-shot.ts` / `src/startup.ts` | Call `protocol-probe` after PushScan trigger arrives, dispatch to `startScanSession` (esci2) or `startScanSessionLegacy`. |
| `src/config.ts`                                       | Add `PRINTER_PROTOCOL` and `JPEG_QUALITY`, Zod-validated.                                                                 |
| `package.json`                                        | Add `sharp` dep.                                                                                                          |

## 9. Configuration surface

| Var                | Values                      | Default | Effect                                              |
| ------------------ | --------------------------- | ------- | --------------------------------------------------- |
| `PRINTER_PROTOCOL` | `auto` / `esci2` / `legacy` | `auto`  | `auto` probes TLS; explicit values bypass the probe |
| `JPEG_QUALITY`     | `1`–`100`                   | `90`    | sharp encoder quality (legacy variant only)         |

**Compatibility constraints:**

- `PRINTER_CERT_FINGERPRINT` (existing) only applies to the esci2 variant.
  Setting it together with `PRINTER_PROTOCOL=legacy` is a config error
  reported at startup with a clear message rather than silently ignored.
- `PREVIEW_ACTION` and other existing scan-behaviour env vars apply
  uniformly to both variants.

## 10. Testing strategy

- **`scanner.test.ts`** — unchanged. Frida-driven JPG/PDF replay matrix for ET-4950.
- **`scanner-legacy.test.ts`** — new. Pcap-extracted JSONL replay matrix
  covering all six maltris captures (flatbed/ADF × single/2-page × JPEG/PDF).
  PDF wire bytes do differ from JPEG (different DPI, different format byte),
  so all four are kept as distinct test entries.
- **`esci-legacy.test.ts`** — unit tests for command builders, FS G reply parser, FS W blob byte-equivalence per mode.
- **`protocol-probe.test.ts`** — TLS-success → esci2, `ERR_SSL_WRONG_VERSION_NUMBER` → legacy, env override, cache.
- **`output-tail.test.ts`** — direct unit coverage on the extracted module.
- **`tools/pcap-extract/`** — its own test that round-trips a known fixture.
- Sharp wrapper — known raw bytes → JPEG bytes with expected dimensions and SOI; covered inline in `scanner-legacy.test.ts` or its own file.

`.reference/wireshark-captures/wf-3620/*.pcapng` stays gitignored. Extracted
JSONL fixtures are committed under `tests/fixtures/legacy/` (parallel to
`tools/frida-capture/captures/`).

## 11. Open items

Resolved by the 2026-04-30 capture matrix:

| Item                           | Resolution                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-page boundary signalling | Each page = its own GAMMA → WINDOW → START → STREAM cycle, separated by host-sent `0x0c 0x00` page-eject (ADF only)                                                         |
| PDF wire effect                | Format choice changes the FS W block's format byte (0x04 → 0x08) **and** the scan resolution (600 → 300 DPI). Cannot post-process between formats; must honour panel choice |
| Pixel format                   | Confirmed 24-bit RGB at panel-selected DPI; channel count and bit depth determined arithmetically from stream byte counts in all six captures                               |
| ADF source path                | Confirmed `ESC e 0x01` = ADF simplex, `ESC e 0x02` = ADF duplex (matches FS W byte 26)                                                                                      |
| "2-paged" semantics            | Confirmed duplex (single-sided / double-sided toggle), not a multi-page hint. WF-3620 spec sheet calls it "Auto 2-Sided Scanning"                                           |

Still open:

| Item                                                   | Effect                                                                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-sheet ADF capture (3+ sheets, simplex or duplex) | Confirms the inter-sheet command path matches the inter-side command path we've seen. v1 assumes they match; first multi-sheet user gets asked to capture if they hit a stall |
| Panel photo of the destination/format/2-paged screen   | README compatibility-table labels                                                                                                                                             |
| Email format                                           | Out of v1 scope; would need a capture                                                                                                                                         |
| Paper sizes other than A4                              | Hardcoded table covers A4 only; first user to scan US Letter or anything else triggers a capture request                                                                      |

## 12. Risks and mitigations

| Risk                                                                                           | Mitigation                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| sharp native dep breaks Docker multi-arch build                                                | sharp publishes prebuilt binaries for x64 / arm64 on Linux / macOS / Windows; CI catches install failures pre-merge           |
| `output-tail.ts` extraction breaks ET-4950 path                                                | `scanner.test.ts` is the regression shield — full Frida replay matrix has to keep passing pre-merge                           |
| Probe latency on first connect                                                                 | Result cached for daemon lifetime. Probe socket is closed and the scanner reconnects — adds ~50 ms on first scan, simpler API |
| Probe spuriously classifies a slow ESC/I-2 printer as legacy                                   | 3 s probe timeout plus explicit env-var override (`PRINTER_PROTOCOL=esci2`) when the user knows their model                   |
| Multi-sheet ADF run stalls because the inter-sheet command differs from the inter-side command | First user reports it, capture, fix; v1's failure mode is "first sheet succeeds, second times out" rather than data loss      |
| Memory pressure at 600 DPI A4 (~108 MB per page in Buffer)                                     | Acceptable for the dedicated-container deployment shape; revisit with `sharp.pipeline()` streaming if 1200 DPI ever lands     |
