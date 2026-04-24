# epson2paperless

**Send scans from your Epson ET-4950 straight to a folder on your computer — no Windows app in the middle.**

`epson2paperless` is a small service that runs on a machine on your LAN. Press **Scan** on the printer panel, pick your destination, set the format to JPEG or PDF, and the file appears in the folder of your choice a few seconds later. Supports the ADF (1-Sided or 2-Sided, single or multi-page) and the flatbed glass. Pair the output folder with [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx)'s consume directory and you've got a paperless scanning setup end-to-end.

> **Not affiliated with Seiko Epson Corporation.** This project is an independent, clean-room re-implementation of the network behavior of an Epson "Scan to Computer" workflow, developed by analyzing the wire protocol of a device the author owns. No Epson source code, firmware, or binaries are included or distributed. "EPSON" and "ET-4950" are trademarks of Seiko Epson Corporation, used here descriptively to identify the hardware this software interoperates with.

## Requirements

- An **Epson ET-4950** printer on your LAN.
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
| `LANGUAGE`            |          | `en`             | 2-letter language code (affects the panel label).                                                                                                       |
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

## Troubleshooting

**Destination doesn't appear on the printer panel.**
The printer broadcasts a discovery beacon roughly once a minute; wait at least 60 seconds. If it still doesn't appear:

- Confirm the PC is on the same subnet as the printer. Try `ping <printer-ip>`.
- Check your firewall — UDP port `2968` needs to be allowed for multicast traffic from the printer.
- Make sure no other Epson software (e.g. Epson Event Manager) is running on the same PC — it can fight over the same port.

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
