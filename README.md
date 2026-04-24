# epson2paperless

**Send scans from compatible Epson EcoTank printers straight to a folder on your computer — no Epson app in the middle.**

`epson2paperless` is a small service that runs on a machine on your LAN. Press **Scan** on the printer panel, pick your destination, set the format to JPEG or PDF, and the file appears in the folder of your choice a few seconds later. Supports the ADF (1-Sided or 2-Sided, single or multi-page) and the flatbed glass. Pair the output folder with [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx)'s consume directory and you've got a paperless scanning setup end-to-end.

> **Not affiliated with Seiko Epson Corporation.** This project is an independent, clean-room re-implementation of the network behavior of an Epson "Scan to Computer" workflow, developed by analyzing the wire protocol of a device the author owns. No Epson source code, firmware, or binaries are included or distributed. "EPSON", "EcoTank", and "ET-4950" are trademarks of Seiko Epson Corporation, used here descriptively to identify the hardware this software interoperates with.

## Requirements

- A compatible **Epson EcoTank** printer on your LAN. Developed and tested on the **ET-4950**; other EcoTank models likely work but haven't been verified yet — reports welcome via Issues.
- **Node.js 24.15.0 LTS** or newer.
- The PC running `epson2paperless` on the **same broadcast domain** as the printer (same switch / VLAN). Multicast discovery doesn't cross most routers by default.

## Install

```bash
git clone https://github.com/mtheuma/epson2paperless.git
cd epson2paperless
npm install
```

## Configure

Configuration is via environment variables. Only `PRINTER_IP` is required.

| Variable              | Required | Default          | What it does                                                                                                                                            |
| --------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRINTER_IP`          | ✅       | —                | The printer's IPv4 address.                                                                                                                             |
| `SCAN_DEST_NAME`      |          | `Paperless`      | The label the printer shows on its panel.                                                                                                               |
| `OUTPUT_DIR`          |          | `/output`        | Where scans are written (JPG or PDF, depending on panel). Created automatically.                                                                        |
| `LOG_LEVEL`           |          | `info`           | `debug` / `info` / `warn` / `error`.                                                                                                                    |
| `LOG_FORMAT`          |          | `text`           | `text` (human-readable) or `json` (ndjson, one record per line — for `docker logs` + Loki / `jq`).                                                      |
| `LANGUAGE`            |          | `en`             | 2-letter locale we send to the printer; no observed user-visible effect, kept for future testing.                                                       |
| `PREVIEW_ACTION`      |          | `reject`         | What to do when the panel's Action is "Preview on Computer": `reject` silently ignores the scan; `jpg` or `pdf` treats it as if that format was chosen. |
| `TEMP_DIR`            |          | (system default) | Per-session temp directory for in-progress pages. Leave empty to use the OS default (`os.tmpdir()`). Override for Docker if `/tmp` is tmpfs-backed.     |
| `SCAN_DEST_ID`        |          | `0x02`           | Advanced — destination ID. Leave as default unless you know why.                                                                                        |
| `HEALTH_PORT`         |          | `3000`           | HTTP port for the `/health` endpoint.                                                                                                                   |
| `KEEPALIVE_INTERVAL`  |          | `500`            | ms between keepalive responses. Leave as default.                                                                                                       |
| `SHUTDOWN_TIMEOUT_MS` |          | `30000`          | ms to wait for an in-flight scan to finish on `SIGINT`/`SIGTERM` before forcing shutdown.                                                               |

## Run

**Windows:**

The repo ships with `command.bat.example`. Copy it to `command.bat` (which is gitignored so your local `PRINTER_IP` / paths stay private), edit the values, then double-click to run. The script sets sensible env vars for local development and tees output to `scan.log`.

**Linux / macOS:**

```bash
PRINTER_IP=192.0.2.58 OUTPUT_DIR=./scans npm run dev
```

When the service is up you'll see:

```
[INFO] [main] epson2paperless ready — waiting for scan from printer panel
```

Within about 60 seconds, the destination name (default `Paperless`) should appear on the printer's **Scan to Computer** list. If it doesn't, see [Troubleshooting](#troubleshooting) below.

### One-shot mode

If you'd rather run a single scan and exit instead of keeping a daemon alive (handy for cron jobs, automation scripts, or end-to-end testing), use `npm run scan`:

```bash
PRINTER_IP=192.0.2.58 OUTPUT_DIR=./scans npm run scan
```

The one-shot entry point starts the same multicast-discovery and push-scan listener as `npm run dev`, waits for one panel press, saves the scan, and exits 0. Notes:

- No health endpoint is opened — the process lives only long enough to handle the one scan.
- Exit codes: `0` on success, `1` on scan failure, `130` on SIGINT (Ctrl-C), `143` on SIGTERM.
- Push-scans that arrive after the first are ignored with a warning (belt-and-braces against an accidental double-press while the first scan is still running).

## Run via Docker

An image is published to GitHub Container Registry on every `main` push (`:main`) and every `v*` git tag (`:vX.Y.Z` + `:latest`). Available architectures: `linux/amd64` and `linux/arm64`.

Point the service at your printer and run one command:

1. Edit `compose.yaml` — set `PRINTER_IP` to your printer's IPv4 address and `./output` to wherever you want scans written.
2. Run `docker compose up -d`.
3. Follow the logs: `docker compose logs -f epson2paperless`.

Notes:

- **`network_mode: host` is required** — the printer announces itself over UDP multicast on port 2968, which doesn't traverse Docker's default bridge network. Pre-baked into the shipped `compose.yaml`.
- The container runs as UID 1000 (`node` user). If your host mount's owner is different, `chown` it to match or the container can't write scans. For a NAS user with a non-default UID, you'll need to adjust ownership on the mounted volume path.
- Docker Desktop on macOS / Windows has caveats around host networking — the primary deployment target is a Linux server. Desktop users can work around via `extra_hosts` or by exposing the printer IP directly, but it's not officially supported.
- For Paperless-ngx direct upload, uncomment `PAPERLESS_URL` and either `PAPERLESS_TOKEN` or `PAPERLESS_TOKEN_FILE` in `compose.yaml`. See [Pair with Paperless-ngx](#pair-with-paperless-ngx) below for the full option set.

## Use it

1. Load one or more pages in the ADF — or leave the ADF empty and place a single sheet on the flatbed glass. The printer detects which source is loaded.
2. At the printer panel, press **Scan** → select your destination (default `Paperless`).
3. Choose **Action** (Save as JPEG / Save as PDF) and **Sides** (1-Sided / 2-Sided) on the panel.
4. Wait for the panel to show **"Scan complete"**.
5. A timestamped file appears in `OUTPUT_DIR`:
   - JPG + single page → `scan_2026-04-20_081438.jpg`
   - JPG + multi-page → `scan_2026-04-20_081438_01.jpg`, `_02.jpg`, …
   - PDF (any page count) → one multi-page `scan_2026-04-20_081438.pdf`

## Pair with Paperless-ngx

Point `OUTPUT_DIR` at Paperless-ngx's consume directory (typically `./consume` or `/usr/src/paperless/consume` inside the container). Paperless picks up new files automatically.

```bash
PRINTER_IP=192.0.2.58 OUTPUT_DIR=/srv/paperless/consume npm run dev
```

### Direct upload (alternative to consume folder)

If you'd rather have scans POSTed straight into Paperless-ngx's API than dropped into its consume folder, set:

| Var                             | Required for direct upload | Default | What it does                                                                                                                               |
| ------------------------------- | -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAPERLESS_URL`                 | yes                        | —       | Base URL of your Paperless-ngx, e.g. `http://paperless:8000`. The service appends `/api/documents/post_document/` — just give it the host. |
| `PAPERLESS_TOKEN`               | yes                        | —       | API token. Create via Paperless-ngx admin → Users → your user → API token.                                                                 |
| `PAPERLESS_TOKEN_FILE`          |                            | —       | Alternative to `PAPERLESS_TOKEN` — read the token from a file. For Docker secrets / Kubernetes. Takes precedence if both are set.          |
| `PAPERLESS_DELETE_AFTER_UPLOAD` |                            | `true`  | Delete the local file after a successful upload. Set to `false` to keep a local copy.                                                      |

When both URL and token are set, every scan is uploaded to Paperless-ngx **after** the local file is written. The local file stays by default — the upload is additive. If the upload fails (network blip, Paperless-ngx down), the scan is still safe in `OUTPUT_DIR` and you can re-upload manually or fall back to the consume-folder path.

Multi-page ADF scans in JPG mode upload one document per page. Pick **PDF** on the printer panel if you'd rather have them grouped into a single Paperless-ngx document.

## Troubleshooting

**Destination doesn't appear on the printer panel.**
The printer broadcasts a discovery beacon roughly once a minute; wait at least 60 seconds. If it still doesn't appear:

- Confirm the PC is on the same subnet as the printer. Try `ping <printer-ip>`.
- Check your firewall — UDP port `2968` needs to be allowed for multicast traffic from the printer.
- Make sure Epson Event Manager isn't running on the same PC — it binds the same port. Other Epson software (drivers, ScanSmart) is fine.

**Service hangs after a scan.**
Rare edge case. Restart the service with `Ctrl-C` and relaunch.

**Output folder fills with duplicates named `scan_..._1.jpg`.**
Normal. If two scans land in the same second (rare but possible), the service appends `_1`, `_2` to avoid overwriting.

## Further reading

- **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** — technical walkthrough of the protocol and the service's architecture. The wire format, the scanner state machine, and the reverse-engineering methodology used to derive them.

## License

MIT. See [`LICENSE`](LICENSE) for the full text.

---

_Current scope: ADF or flatbed scans, 1-Sided or 2-Sided (ADF), single or multi-page, JPG or PDF output._
