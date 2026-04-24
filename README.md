# epson2paperless

**Send scans from compatible Epson EcoTank printers straight to a folder on your computer — no Epson app in the middle.**

`epson2paperless` is a small service that runs on a machine on your LAN. Press **Scan** on the printer panel, pick your destination, and the file appears in the folder of your choice a few seconds later.

What you get:

- **Printer panel → file in a folder.** No desktop app, no Windows-only driver.
- **JPG or PDF, 1-Sided or 2-Sided, ADF or flatbed.** The panel chooses the format; the service honours it.
- **Standalone or Paperless-ngx feeder.** Drop scans into a consume folder, or POST them directly to the Paperless-ngx API.

## Requirements

- A compatible **Epson EcoTank** printer on your LAN. Developed and tested on the **ET-4950**; other EcoTank models likely work but haven't been verified — reports welcome via Issues.
- **Node.js 24.15.0 LTS** or newer (or Docker).
- The PC running `epson2paperless` on the **same local network** as the printer — same Wi-Fi or Ethernet, not across a router. See [HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md#discovery-and-keepalive-udp-multicast) for why multicast matters.

## Quick start

### Docker (recommended)

A multi-arch image (`linux/amd64`, `linux/arm64`) is published to GitHub Container Registry on every `main` push (`:main`) and every `v*` git tag (`:vX.Y.Z` + `:latest`).

1. Edit `compose.yaml` — set `PRINTER_IP` to your printer's IPv4 address and `./output` to wherever you want scans written.
2. `docker compose up -d`.
3. Follow the logs: `docker compose logs -f epson2paperless`.

Notes:

- Uses host networking — the printer's multicast beacon can't reach a bridged container. [Why](docs/HOW-IT-WORKS.md#discovery-and-keepalive-udp-multicast).
- Container runs as UID 1000 (`node`). If your mount has a different owner, `chown` it to match.
- Docker Desktop on macOS / Windows has caveats around host networking; the primary deployment target is a Linux server.

### Run from source

```bash
git clone https://github.com/mtheuma/epson2paperless.git
cd epson2paperless
npm install
PRINTER_IP=192.0.2.58 OUTPUT_DIR=./scans npm run dev
```

When the service is up you'll see:

```
[INFO] [main] epson2paperless ready — waiting for scan from printer panel
```

Within about 60 seconds, your destination (default `Paperless`) appears in the printer's **Scan to Computer** list. If it doesn't, see [Troubleshooting](#troubleshooting).

**Windows:** copy `command.bat.example` to `command.bat` (gitignored, so your local `PRINTER_IP` / paths stay private), edit the values, then double-click. The script tees output to `scan.log`.

**One-shot mode** — `npm run scan` runs a single scan and exits, handy for cron jobs or end-to-end tests. Exit codes: `0` success, `1` scan failure, `130` SIGINT (Ctrl-C), `143` SIGTERM. No health endpoint is opened, and any push-scan that arrives after the first is ignored with a warning.

## Use it

1. Load pages in the ADF — or leave the ADF empty and place a single sheet on the flatbed glass. The printer detects which source is loaded.
2. At the printer panel, press **Scan** → select your destination (default `Paperless`).
3. Choose **Action** (Save as JPEG / Save as PDF) and **Sides** (1-Sided / 2-Sided) on the panel.
4. Wait for the panel to show **"Scan complete"**.
5. A timestamped file appears in `OUTPUT_DIR`:
   - JPG, single page → `scan_2026-04-20_081438.jpg`
   - JPG, multi-page → `scan_2026-04-20_081438_01.jpg`, `_02.jpg`, …
   - PDF, any page count → one multi-page `scan_2026-04-20_081438.pdf`

## Configure

Configuration is via environment variables. Only `PRINTER_IP` is required.

| Variable         | Required | Default          | What it does                                                                                                                                            |
| ---------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRINTER_IP`     | ✅       | —                | The printer's IPv4 address.                                                                                                                             |
| `SCAN_DEST_NAME` |          | `Paperless`      | The label the printer shows on its panel.                                                                                                               |
| `OUTPUT_DIR`     |          | `/output`        | Where scans are written (JPG or PDF, depending on panel). Created automatically.                                                                        |
| `LOG_LEVEL`      |          | `info`           | `debug` / `info` / `warn` / `error`.                                                                                                                    |
| `LOG_FORMAT`     |          | `text`           | `text` (human-readable) or `json` (ndjson, one record per line — for `docker logs` + Loki / `jq`).                                                      |
| `PREVIEW_ACTION` |          | `reject`         | What to do when the panel's Action is "Preview on Computer": `reject` silently ignores the scan; `jpg` or `pdf` treats it as if that format was chosen. |
| `TEMP_DIR`       |          | (system default) | Where per-scan temp files go. Leave empty for the OS default (`os.tmpdir()`). Override for Docker if `/tmp` is in memory.                               |
| `HEALTH_PORT`    |          | `3000`           | HTTP port for the `/health` endpoint.                                                                                                                   |

<details>
<summary>Advanced (leave as default unless you know why)</summary>

| Variable              | Default | What it does                                                                              |
| --------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `SCAN_DEST_ID`        | `0x02`  | Destination ID byte sent in keepalive packets.                                            |
| `LANGUAGE`            | `en`    | 2-letter locale sent to the printer; no observed user-visible effect.                     |
| `KEEPALIVE_INTERVAL`  | `500`   | ms between keepalive responses.                                                           |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | ms to wait for an in-flight scan to finish on `SIGINT`/`SIGTERM` before forcing shutdown. |

</details>

## Pair with Paperless-ngx

Point `OUTPUT_DIR` at Paperless-ngx's consume directory (typically `./consume` or `/usr/src/paperless/consume` inside the container). Paperless picks up new files automatically.

```bash
PRINTER_IP=192.0.2.58 OUTPUT_DIR=/srv/paperless/consume npm run dev
```

### Direct upload (alternative to consume folder)

If you'd rather POST scans straight into Paperless-ngx's API than drop them into its consume folder, set:

| Var                             | Required for direct upload | Default | What it does                                                                                                                               |
| ------------------------------- | -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAPERLESS_URL`                 | yes                        | —       | Base URL of your Paperless-ngx, e.g. `http://paperless:8000`. The service appends `/api/documents/post_document/` — just give it the host. |
| `PAPERLESS_TOKEN`               | yes                        | —       | API token. Create via Paperless-ngx admin → Users → your user → API token.                                                                 |
| `PAPERLESS_TOKEN_FILE`          |                            | —       | Alternative to `PAPERLESS_TOKEN` — read the token from a file. For Docker secrets / Kubernetes. Takes precedence if both are set.          |
| `PAPERLESS_DELETE_AFTER_UPLOAD` |                            | `true`  | Delete the local file after a successful upload. Set to `false` to keep a local copy.                                                      |

When both URL and token are set, every scan is uploaded **after** the local file is written. The local file stays by default — the upload is additive. If the upload fails (network blip, Paperless-ngx down), the scan is still safe in `OUTPUT_DIR` and you can re-upload manually or fall back to the consume-folder path.

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
Normal. If two scans land in the same second, the service appends `_1`, `_2` to avoid overwriting.

## Further reading

- **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** — full technical walkthrough: the wire protocol, the scanner state machine, and the reverse-engineering methodology used to derive them.

## License & trademarks

MIT. See [`LICENSE`](LICENSE) for the full text.

**Not affiliated with Seiko Epson Corporation.** This project is an independent, clean-room re-implementation of the network behavior of an Epson "Scan to Computer" workflow, developed by analyzing the wire protocol of a device the author owns. No Epson source code, firmware, or binaries are included or distributed. "EPSON", "EcoTank", and "ET-4950" are trademarks of Seiko Epson Corporation, used here descriptively to identify the hardware this software interoperates with.

---

_Current scope: ADF or flatbed scans, 1-Sided or 2-Sided (ADF), single or multi-page, JPG or PDF output._
