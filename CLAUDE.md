# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

A gitignored `CLAUDE.local.md` may also be present — it holds machine-specific paths, private reverse-engineering artifact conventions, and harness quirks that don't belong in a public repo. Both files are loaded and merged when Claude Code runs locally; CI / GitHub Actions only see this one.

## What this project is

A Node.js/TypeScript service that emulates the Windows-side of Epson's "Scan to Computer" flow for an **ET-4950** printer: multicast discovery + TLS scan session + JPEG/PDF output landing in a folder that can be pointed at Paperless-ngx's consume directory.

See:

- `README.md` — user-facing install / run / configure.
- `docs/HOW-IT-WORKS.md` — protocol layers, state machine, reverse-engineering methodology.

## Commands

- `npm test` — full Vitest suite (216 tests across 14 files, ~1s). Includes `src/scanner.test.ts`, a replay harness that asserts byte-for-byte equivalence against recorded Frida captures. Six parametrised entries: three JPG (1p-simplex, 3p-simplex, 1p-duplex — asserting JPEGs on disk + EXIF APP1 orientation, `Orientation=3` on duplex back pages only) and three PDF reusing the same captures with `action='pdf'` (asserting one composed `scan_<ts>.pdf` with correct page count and `/Rotate=180` on back pages). Treat this as a regression shield — protocol edits that change wire bytes must be mirrored in fixtures.
- `npm test -- <name>` — filter by file name (e.g. `npm test -- pushscan`).
- `npx vitest run <path> --reporter=verbose` — single file, verbose output.
- `npm run dev` — start the long-running service via `tsx` (no build step).
- `npm run scan` — one-shot CLI mode (`src/one-shot.ts`). Same wire behaviour as the daemon, but exits after the first scan completes — useful for ad-hoc captures and integration tests.
- `npm run printer-fingerprint` — print the printer's TLS certificate sha256 fingerprint, in the colon-hex form expected by `PRINTER_CERT_FINGERPRINT`.
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
- `PRINTER_CERT_FINGERPRINT` — optional sha256 pin (32 colon-separated hex bytes) for the printer's TLS cert. When set, the scan session rejects any cert whose fingerprint doesn't match. Capture with `npm run printer-fingerprint`.
- `SHUTDOWN_TIMEOUT_MS` — how long graceful shutdown waits for in-flight scans before forcing exit (default 30000).

## Architecture (brief — full detail in `docs/HOW-IT-WORKS.md`)

Each protocol layer lives in its own module and can be reasoned about independently:

- **Discovery / multicast** (`src/keepalive.ts`, `src/network.ts`) — UDP `239.255.255.253:2968`. Echoes the printer's beacon seq byte back in a 3-burst keepalive to register as destination `Paperless`. `network.ts` resolves which local interface IP to advertise.
- **Push-scan trigger** (`src/pushscan.ts`) — TCP port 2968, raw `net.createServer` because Epson uses non-standard header spacing (`Header : value`, whitespace before the colon). The `x-uid` response header **must** echo the request — mismatch shows "Scanning Error" on the panel even though data transfer completes. `PushScanIDIn` bytes carry the panel's Sides (byte 0: `0`=1-Sided, `1`=2-Sided) and Action bitmask (byte 1: `1`=jpg, `2`=pdf, `4`=preview).
- **Scan session** (`src/scanner.ts` + `src/esci.ts` + `src/protocol.ts`) — TLS port 1865. Cert verification is off by default; setting `PRINTER_CERT_FINGERPRINT` switches on sha256 pinning. Inside TLS, Epson's "IS" framing wraps ESC/I-2 commands. The scanner runs a deterministic state machine per scan; see `docs/HOW-IT-WORKS.md` for the diagram. Per-page JPEGs spill to a session temp dir; at end-of-scan, `src/output.ts` promotes/composes the result — `action='jpg'` → `scan_<ts>{,_NN}.jpg`, `action='pdf'` → one composed `scan_<ts>.pdf` via `src/pdf.ts` (JPG-promote fallback on compose failure).
- **EXIF / PDF helpers** (`src/exif.ts`, `src/pdf.ts`) — minimal 36-byte APP1 insertion for JPG back-page orientation; pdf-lib composition with per-page sizing and `/Rotate=180` on back pages.
- **Paperless upload** (`src/paperless-upload.ts`) — when `PAPERLESS_URL` + `PAPERLESS_TOKEN` are configured, finished scans are POSTed multipart to Paperless-ngx's `post_document` endpoint. Optional cleanup of the local file after a successful upload.
- **Process layer** (`src/index.ts`, `src/one-shot.ts`, `src/startup.ts`, `src/lifecycle.ts`, `src/logger.ts`) — `index.ts` is the long-running daemon; `one-shot.ts` is the `npm run scan` CLI variant. Both share startup boilerplate (banner, discovery, crash handlers, Paperless option assembly) from `startup.ts`. `lifecycle.ts` provides an in-flight scan tracker and graceful shutdown driver bounded by `SHUTDOWN_TIMEOUT_MS`. `logger.ts` is a tiny structured logger with a `LOG_FORMAT=json` mode.
- **Health check** (`src/health.ts`) — plain HTTP on port 3000 (configurable). Note: binds to all interfaces, so it's LAN-reachable — see README.

The `PARA` payload from `buildParaPayload(duplex)` is hardcoded and byte-matched to the driver capture: 936 bytes simplex (`#ADF…`, announced `0x3A8`) / 940 bytes duplex (`#ADFDPLX…`, `0x3AC`). Don't edit without re-capturing fixtures — the replay test will fail.

## Testing philosophy

- `src/scanner.test.ts` is the regression shield. All other tests are per-module unit coverage: keepalive parse/respond, SOAP shapes, IS-framing encode/decode, ESC/I-2 builders, output file naming, PDF composition, config validation, health endpoint.
- Frida captures live under `tools/frida-capture/captures/`. See `tools/frida-capture/README.md` for re-capture workflow.

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
