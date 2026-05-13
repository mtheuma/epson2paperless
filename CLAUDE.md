# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

A gitignored `CLAUDE.local.md` may also be present — it holds machine-specific paths, private reverse-engineering artifact conventions, and harness quirks that don't belong in a public repo. Both files are loaded and merged when Claude Code runs locally; CI / GitHub Actions only see this one.

## What this project is

A Node.js/TypeScript service that emulates the Windows-side of Epson's "Scan to Computer" flow: multicast discovery + per-printer scan session + JPEG/PDF output landing in a folder that can be pointed at Paperless-ngx's consume directory. Three transport variants supported, all on port 1865: **ET-4950 / ET-3950 / ET-4956** (ESC/I-2 over TLS), **ET-2750** (ESC/I-2 over plain TCP — same command vocabulary, no TLS, flatbed-only hardware), and **WF-3620** plus structurally similar Workforce-class models (legacy ESC/I over plain TCP). Auto-detected at session start by a three-arm probe; `PRINTER_PROTOCOL` forces a specific one.

See:

- `README.md` — user-facing install / run / configure.
- `docs/HOW-IT-WORKS.md` — protocol layers, state machine, reverse-engineering methodology.

## Commands

- `npm test` — full Vitest suite (481 + 1 skipped across 25 files, ~6s). Two replay harnesses anchor the regression shield. `src/esci2/scanner.test.ts` asserts byte-for-byte equivalence of the ESC/I-2 path against eight fixtures: seven Frida-captured ET-4950 (TLS) traces (ADF 1p/3p simplex, ADF 1p/3p duplex, ADF 1p simplex PDF, flatbed 1p JPG/PDF — with EXIF APP1 `Orientation=3` and PDF `/Rotate=180` on duplex back pages) plus one pcap-extracted ET-2750 (plain-TCP) trace (`et-2750/flatbed-single-page-pdf.jsonl`). `src/esci/scanner.test.ts` does the same for the WF-3620 ESC/I path against ten pcap-extracted fixtures (ADF simplex / ADF duplex / flatbed × JPG / PDF, plus single- and multi-page variants). Protocol edits that change wire bytes must be mirrored in fixtures.
- `npm test -- <name>` — filter by file name (e.g. `npm test -- pushscan`).
- `npx vitest run <path> --reporter=verbose` — single file, verbose output.
- `npm run dev` — start the long-running service via `tsx` (no build step).
- `npm run scan` — one-shot CLI mode (`src/one-shot.ts`). Same wire behaviour as the daemon, but exits after the first scan completes — useful for ad-hoc captures and integration tests.
- `npm run printer-fingerprint` — print the printer's TLS certificate sha256 fingerprint, in the colon-hex form expected by `PRINTER_CERT_FINGERPRINT`. ESC/I-2 path only; WF-3620 has no TLS layer.
- `npm run pcap:extract` / `npm run pcap:render` — convert a Wireshark pcap of an ESC/I scan session into a JSONL replay fixture, or render a captured/extracted JSONL fixture to JPEG/PDF for eyeball validation. See `tools/pcap-extract/README.md` for invocation.
- `npm run test-page:generate` — regenerate the committed compatibility test PDF under `tools/test-page/`. Used by external compatibility reporters; rarely needed in dev.
- `npm run build` — TypeScript compile to `dist/`. Usually not needed in dev.
- `npm run lint` / `npm run lint:fix` — ESLint with typescript-eslint type-checked rules (`eslint.config.mjs`). Test files and `tools/` relax `no-unsafe-*` around fixture-heavy code.
- `npm run format` / `npm run format:check` — Prettier (`.prettierrc.json`).

## Configuration

Env-var driven, Zod-validated in `src/config.ts`. Required: `PRINTER_IP`. Full table in `README.md`.

Noteworthy for dev:

- `LOG_LEVEL=debug` — scanner state transitions + per-request detail only show at `debug`.
- `LOG_FORMAT` (`text` / `json`) — `json` emits structured one-line records; useful when running under a log shipper.
- `PREVIEW_ACTION` (`reject` / `jpg` / `pdf`) — what happens when the panel's Action is **Preview on Computer** (`PushScanIDIn[1]=4`). Default silently ignores the scan; `jpg` / `pdf` override to let it proceed as that format.
- `TEMP_DIR` — per-session JPEG spill dir. Empty → `os.tmpdir()`. Override in Docker if `/tmp` is tmpfs-backed.
- `PAPERLESS_URL` + `PAPERLESS_TOKEN` (or `PAPERLESS_TOKEN_FILE`) — when both are set, completed scans are POSTed to Paperless-ngx's `/api/documents/post_document/` endpoint. `PAPERLESS_DELETE_AFTER_UPLOAD` (default `true`) controls whether the local file is removed after a successful upload.
- `PRINTER_CERT_FINGERPRINT` — optional sha256 pin (32 colon-separated hex bytes) for the printer's TLS cert. When set, the scan session rejects any cert whose fingerprint doesn't match. Capture with `npm run printer-fingerprint`. ESC/I-2-over-TLS path only — Zod-rejected with `esci2-plain` and `esci` (no TLS to verify); also rejected with `auto`, since a probe failure could downgrade silently to a non-TLS path and bypass the pin.
- `PRINTER_PROTOCOL` (`auto` / `esci2` / `esci2-plain` / `esci`, default `auto`) — transport-variant selector. `auto` runs a three-arm probe: TLS handshake → plain-TCP ESC/I-2 handshake-open (`0x8000` packet) → plain-TCP ESC/I `ESC @` ACK. The three explicit values skip the probe and select the matching scanner directly.
- `ESCI_FORCE_SOURCE` (`adf-simplex` / `adf-duplex` / `flatbed`) — legacy ESC/I path only. Overrides the FS W source byte when probe-based detection isn't enough. Zod-rejected when paired with `PRINTER_PROTOCOL=esci2` or `esci2-plain`.
- `DIAGNOSE_PROTOCOL=true` — compatibility-report aid. When the legacy `ESC @` init returns a non-ACK, sends one extra `FS Y` probe (the ET-4950 ESC/I-2 path's first command) and aborts with `[diagnose]` log lines tagged with the IS packet type and payload. Off by default; only useful when triaging an unknown printer that gets past welcome+lock.
- `SHUTDOWN_TIMEOUT_MS` — how long graceful shutdown waits for in-flight scans before forcing exit (default 30000).

## Architecture (brief — full detail in `docs/HOW-IT-WORKS.md`)

Each protocol layer lives in its own module and can be reasoned about independently:

- **Discovery / multicast** (`src/keepalive.ts`, `src/network.ts`) — UDP `239.255.255.253:2968`. Echoes the printer's beacon seq byte back in a 3-burst keepalive to register as destination `Paperless`. `network.ts` resolves which local interface IP to advertise. Identical for both protocol generations.
- **Push-scan trigger** (`src/pushscan.ts`) — TCP port 2968, raw `net.createServer` because Epson uses non-standard header spacing (`Header : value`, whitespace before the colon). The `x-uid` response header **must** echo the request — mismatch shows "Scanning Error" on the panel even though data transfer completes. `PushScanIDIn` bytes carry the panel's Sides (byte 0: `0`=1-Sided, `1`=2-Sided) and Action bitmask (byte 1: `1`=jpg, `2`=pdf, `4`=preview). Source-agnostic; flatbed and ADF look identical here. Identical for both protocol generations.
- **Protocol probe + dispatch** (`src/protocol-probe.ts`, `dispatchScanSession` in `src/startup.ts`) — three-arm probe: TLS handshake → plain-TCP ESC/I-2 `0x8000` handshake-open with `0x300C` IS-header offset-4 → plain-TCP ESC/I `ESC @` ACK. Returns a `ScanProfile` discriminator (`{commandSet: "esci2", transport: "tls" | "plain"} | {commandSet: "esci", transport: "tcp"}`). Only the TLS arm caches its positive result; the two plain-TCP arms re-probe each session because plain-TCP responses (or ECONNRESET) can be transient. `dispatchScanSession` routes into `runEsci2Scan` (TLS), `runEsci2ScanOverPlain` (ET-2750), or `runEsciScan` (legacy), threading `ESCI_FORCE_SOURCE` for the legacy path.
- **Shared scan-session engine** (`src/scan-session.ts`) — `runScanSession<Ctx>` drives a generic `Graph<Ctx>` state machine over a `SessionTransport` interface (`write` / `end(data?)` / `destroy` plus `data`/`error`/`close` events). All three scanner shells build a graph and a transport-factory and hand them to this engine. Cross-cutting concerns live here: IS framing parse, `globalIgnoreFilter` with per-state `bypassIgnoreFilter` opt-out, `maxPayloadBytes` sanity-cap (32 MB default; framing-desync error instead of a delayed timeout), settlement lifecycle (always `transport.destroy()`; barrier `settled` re-checks; listener-replay tolerance), DONE-state finalize. Transport adapters under `src/esci2/transport.ts` (`withTlsErrorLabels` + `withEsci2UnlockOnDestroy` + `socketAsTransport`) compose around the raw socket; the plain-TCP factory composes only the unlock adapter.
- **ESC/I-2 scan sessions** (`src/esci2/scanner.ts` + `src/esci2/graph.ts` + `src/esci2/commands.ts` + `src/protocol.ts` + `src/commands-fs.ts` + `src/graph-helpers.ts`) — `runEsci2Scan` (TLS port 1865; cert verification off by default, sha256 pin via `PRINTER_CERT_FINGERPRINT`) and `runEsci2ScanOverPlain` (plain TCP on the same port; no SNI, no fingerprint) share `esci2Graph(profile)`, where `profile: "esci2-tls" | "esci2-plain"` selects a 4-state plain-TCP handshake prefix and the right `buildParaFlatbed*()` builder. Inside the transport, Epson's "IS" framing wraps ESC/I-2 commands; pages are pulled host-side via the `@IMG` loop and spill to a session temp dir.
- **ESC/I scan session** (`src/esci/scanner.ts` + `src/esci/graph.ts` + `src/esci/commands.ts` + `src/esci/luts.ts` + `src/esci/raw-to-jpeg.ts` + `src/commands-fs.ts` + `src/graph-helpers.ts`) — plain TCP on port 1865, no TLS. Same outer IS framing wraps the legacy ESC/I command set (`ESC @`, `ESC e`, `ESC z` × 3 with 256-byte gamma LUT per channel, `FS W` 64-byte binary parameter block, `FS G`, `FS F`). Pixels stream **unsolicited** as raw 24-bit RGB chunks in IS-0xa200 packets; `raw-to-jpeg.ts` (sharp) encodes each completed page. ADF pages terminate with a single `0x0c` eject byte; flatbed never sends one. Built on the same `runScanSession` engine as the ESC/I-2 path (v0.4.0 unification); shares `expectIsType`/`expectLength`/`awaitReply`/`ackByte` helpers from `src/graph-helpers.ts` and `buildFsY/X/Z` from `src/commands-fs.ts`.
- **Output finalize** (`src/output.ts`, `src/output-tail.ts`, `src/exif.ts`, `src/pdf.ts`) — at end-of-scan both scanners hand temp-dir JPEGs to `finalizeSession` in `output-tail.ts`. `action='jpg'` → promote to `scan_<ts>{,_NN}.jpg`; `action='pdf'` → compose `scan_<ts>.pdf` via pdf-lib (JPG-promote fallback on compose failure). Duplex back pages get either an EXIF APP1 `Orientation=3` (JPG path, `exif.ts`) or pdf-lib `/Rotate=180` (PDF path, `pdf.ts`) — no pixel re-encode.
- **Paperless upload** (`src/paperless-upload.ts`) — when `PAPERLESS_URL` + `PAPERLESS_TOKEN` are configured, finished scans are POSTed multipart to Paperless-ngx's `post_document` endpoint. Optional cleanup of the local file after a successful upload.
- **Process layer** (`src/index.ts`, `src/one-shot.ts`, `src/startup.ts`, `src/lifecycle.ts`, `src/logger.ts`) — `index.ts` is the long-running daemon; `one-shot.ts` is the `npm run scan` CLI variant. Both share startup boilerplate (banner, discovery, crash handlers, Paperless option assembly, the dispatcher) from `startup.ts`. `lifecycle.ts` provides an in-flight scan tracker and graceful shutdown driver bounded by `SHUTDOWN_TIMEOUT_MS`. `logger.ts` is a tiny structured logger with a `LOG_FORMAT=json` mode.
- **Health check** (`src/health.ts`) — plain HTTP on port 3000 (configurable). Note: binds to all interfaces, so it's LAN-reachable — see README.

The ESC/I-2 `PARA` payload is built per-dialect: at INIT1 the graph hashes the printer's CAPA reply (sha256 over canonicalised segments, `src/esci2/capa-fingerprint.ts`) and looks up a `Dialect` in `src/esci2/dialect-registry.ts`. Each dialect's `buildPara({source, duplex, action})` is hardcoded and byte-matched to its driver capture: ET-4950 family wraps `buildParaAdf` (`#ADF…` / `#ADFDPLX…`) and `buildParaFlatbedTls()` (928 bytes); ET-2750 wraps `buildParaFlatbedPlain()` (944 bytes — different gamma constant, CMX block, scan-area token + extents, missing quirk-token block; transcribed byte-for-byte from the pcap fixture, NOT derived); XP-7100 splices a per-action LUT triplet + 12-byte CMX into one of three captured per-source base bodies (944 / 952 / 956 bytes). The legacy `FS W` 64-byte block plays the equivalent role for WF-3620 — same constraint. Don't edit any of them without re-capturing fixtures — the replay tests will fail. Unrecognised CAPA fingerprints fail fast with a copy-pasteable diagnostic block (no synthesis fallback).

## Testing philosophy

- `src/esci2/scanner.test.ts` (ESC/I-2 — Frida ET-4950 fixtures + pcap-extracted ET-2750 fixture) and `src/esci/scanner.test.ts` (ESC/I — pcap-extracted WF-3620 fixtures) are the regression shields. `src/scan-session.test.ts` adds engine-level unit coverage (settlement lifecycle, listener-replay tolerance, payload sanity-cap, per-state `bypassIgnoreFilter`). All other tests are per-module unit coverage: keepalive parse/respond, SOAP shapes, IS-framing encode/decode, ESC/I-2 + ESC/I builders, protocol probe routing (three arms + `ProtocolOverride` → `ScanProfile`), startup dispatcher routing, raw-RGB → JPEG encoding, output file naming, PDF composition, config validation, health endpoint, transport adapter composition.
- Frida captures (ESC/I-2 over TLS, ET-4950) live under `tools/frida-capture/captures/`. See `tools/frida-capture/README.md` for the re-capture workflow.
- ESC/I-2 over plain TCP (ET-2750) and legacy ESC/I (WF-3620) fixtures live under `tools/pcap-extract/captures/et-2750/` and `tools/pcap-extract/captures/wf-3620/` respectively, generated from real-hardware Wireshark captures via `npm run pcap:extract`. Source pcaps stay local under `.reference/wireshark-captures/{et-2750,wf-3620}/` (gitignored).

## Development workflow

- `main` = deployable. `dev` = integration.
- Work on `dev` or short-lived branches off `dev`; PR to `main` via `gh pr create --base main --head dev`.
- CI (`.github/workflows/test.yml`) runs `npm install` and then the same lint + format:check + test trio that the local pre-push hook enforces, on every push to `dev`/`main` and every PR targeting `main`. Uses `npm install` (not `npm ci`) because the lockfile is generated on Windows and lacks Linux-only optional native deps — don't swap to `npm ci` without regenerating the lockfile on Linux.
- A separate `.github/workflows/docker.yml` builds and publishes a multi-arch image to GHCR on pushes to `main` and on `v*` tags. `Dockerfile` + `compose.yaml` at the repo root are the deploy artifacts.
- Server-side branch protection on `main`: PR required, CI status check required, linear history required.

### Local pre-push hook

`.githooks/pre-push` blocks `git push origin main` unless `npm run lint`, `npm run format:check`, and `npm test` all pass — mirrors CI's three-step gate so a push that passes here will also pass CI. **Activate once per clone:**

```
git config core.hooksPath .githooks
```

`.gitattributes` pins `.githooks/*` to LF so Git Bash on Windows can execute the shebang. One-off bypass: `git push --no-verify`.

## Frida on Windows

Windows' Frida doesn't support `device.enable_spawn_gating`. `tools/frida-capture/host.py` works around it by gating through `EEventManager.exe` child processes. See `tools/frida-capture/README.md` for the full capture workflow.
