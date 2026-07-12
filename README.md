# epson2paperless

**Send scans from compatible Epson printers straight to a folder on your computer. No Epson app in the middle.**

`epson2paperless` is a small service that runs on a machine on your LAN. Press **Scan** on the printer panel, pick your destination, and the file appears in the folder of your choice a few seconds later.

What you get:

- **Printer panel → file in a folder.** No Epson app required.
- **JPG or PDF, 1-Sided or 2-Sided, ADF or flatbed.** The panel chooses the format; the service honours it.
- **Standalone or Paperless-ngx feeder.** Drop scans into a consume folder, or POST them directly to the Paperless-ngx API.

## Requirements

- A compatible **Epson** printer on your LAN. See [Compatible printers](#compatible-printers) below.
- **Node.js 24.15.0 LTS** or newer (or Docker).
- The PC running `epson2paperless` on the **same local network** as the printer (same Wi-Fi or Ethernet, not across a router). See [PROTOCOL-REFERENCE.md](docs/PROTOCOL-REFERENCE.md#discovery-and-keepalive-udp-multicast) for why multicast matters.

## Compatible printers

| Model                 | Status          | Notes                                                 |
| --------------------- | --------------- | ----------------------------------------------------- |
| **ET-3950**           | ✅ Verified     |                                                       |
| **ET-4950 / ET-4956** | ✅ Verified     |                                                       |
| **WF-3620**           | ✅ Verified     | Plain TCP scanner, no TLS pinning                     |
| **ET-2750**           | ✅ Verified     | Flatbed-only hardware; ESC/I-2 over plain TCP, no TLS |
| **ET-2950**           | 🟡 Experimental | Flatbed-only hardware                                 |
| **ET-8500**           | 🟡 Experimental | Flatbed-only hardware                                 |
| **ET-4800**           | ✅ Verified     | ADF simplex; ESC/I-2 over plain TCP, no TLS           |
| **ET-15000**          | 🟡 Experimental | Flatbed verified; ADF simplex untested                |
| **XP-7100**           | ✅ Verified     |                                                       |
| **FF-680W**           | 🟡 Experimental | ADF-only; 200/300 DPI verified, other DPIs untested   |
| **DS-575W**           | 🟡 Experimental | ADF-only sheet-fed; colour + greyscale                |

Compatibility reports are welcome whether your model works or doesn't. [Open an issue](https://github.com/mtheuma/epson2paperless/issues/new?template=compatibility.yml) using the compatibility template.

## Quick start

### Docker (recommended)

Image: **`ghcr.io/mtheuma/epson2paperless`**. Multi-arch (`linux/amd64`, `linux/arm64`). Published to GHCR on every `main` push (`:main`) and every `v*` git tag (`:vX.Y.Z` + `:latest`).

1. In `compose.yaml`, set `PRINTER_IP` to your printer's IPv4 address and `./output` to wherever you want scans written.
2. `docker compose up -d`.
3. Follow the logs: `docker compose logs -f epson2paperless`.

Notes:

- Uses host networking. The printer's multicast beacon can't reach a bridged container. [Why](docs/PROTOCOL-REFERENCE.md#discovery-and-keepalive-udp-multicast).
- Running several instances against one printer: each container needs its own MAC address. Use a `macvlan` network, not `ipvlan` or a shared bridge.
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

**One-shot mode.** `npm run scan` runs a single scan and exits, handy for cron jobs or end-to-end tests. Exit codes: `0` success, `1` scan failure, `130` SIGINT (Ctrl-C), `143` SIGTERM. No health endpoint is opened, and any push-scan that arrives after the first is ignored with a warning.

## Use it

1. Load pages in the ADF, or leave the ADF empty and place a single sheet on the flatbed glass. The printer detects which source is loaded.
2. At the printer panel, press **Scan** → select your destination (default `Paperless`).
3. Choose **Action** (Save as JPEG / Save as PDF) and **Sides** (1-Sided / 2-Sided) on the panel.
4. Wait for the panel to show **"Scan complete"**.
5. A timestamped file appears in `OUTPUT_DIR`:
   - JPG, single page → `scan_2026-04-20_081438.jpg`
   - JPG, multi-page → `scan_2026-04-20_081438_01.jpg`, `_02.jpg`, …
   - PDF, any page count → one multi-page `scan_2026-04-20_081438.pdf`

## Configure

Configuration is via environment variables. Only `PRINTER_IP` is required.

Each setting's **Scope** column shows which printers it affects: `All`, `Panel` (panel-driven models), `FF-680W`, `DS-575W`, `Legacy ESC/I` (WF-3620 family), or `ESC/I-2 TLS` (ET-4950 family). A setting outside a printer's path is simply ignored.

| Variable                    | Scope            | Default          | What it does                                                                                                                                                                                                                                   |
| --------------------------- | ---------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRINTER_IP`<br>✅ required | All              | —                | The printer's IPv4 address.                                                                                                                                                                                                                    |
| `SCAN_DEST_NAME`            | All              | `Paperless`      | The label the printer shows on its panel. Give each instance a distinct name. On button-only scanners (FF-680W, DS-575W) it must also match the scanner's stored paired name; see [Button-only scanner pairing](#button-only-scanner-pairing). |
| `OUTPUT_DIR`                | All              | `/output`        | Where scans are written (JPG or PDF, depending on panel). Created automatically.                                                                                                                                                               |
| `LOG_LEVEL`                 | All              | `info`           | `debug` / `info` / `warn` / `error`.                                                                                                                                                                                                           |
| `LOG_FORMAT`                | All              | `text`           | `text` (human-readable) or `json` (ndjson, one record per line, for `docker logs` + Loki / `jq`).                                                                                                                                              |
| `PREVIEW_ACTION`            | Panel            | `reject`         | What to do when the panel's Action is "Preview on Computer": `reject` silently ignores the scan; `jpg` or `pdf` treats it as if that format was chosen.                                                                                        |
| `SCAN_FORMAT`               | FF-680W, DS-575W | `pdf`            | Output format (`jpg` / `pdf`) when the scanner reports no panel choice. On button-only scanners a panel format selection is ignored in favour of this.                                                                                         |
| `SCAN_SIDES`                | FF-680W, DS-575W | `duplex`         | `simplex` or `duplex` for button-only scanners, which have no panel Sides selector.                                                                                                                                                            |
| `SCAN_RESOLUTION`           | FF-680W          | `200`            | Scan DPI. One of `50,75,100,150,200,240,300,360,400,600`; `200`/`300` verified.                                                                                                                                                                |
| `SCAN_COLOR_MODE`           | DS-575W          | `color`          | `color` or `grayscale` (the DS-575W has no panel colour selector). Other models ignore it and scan in colour.                                                                                                                                  |
| `PRINTER_PROTOCOL`          | All              | `auto`           | `auto` (probe each session), `esci2` (force ESC/I-2 over TLS), `esci2-plain` (force ESC/I-2 over plain TCP), `esci` (force plain-TCP ESC/I).                                                                                                   |
| `JPEG_QUALITY`              | Legacy ESC/I     | `90`             | JPEG encoder quality 1–100 (host-encoded raw pixels).                                                                                                                                                                                          |
| `TEMP_DIR`                  | All              | (system default) | Where per-scan temp files go. Leave empty for the OS default (`os.tmpdir()`). Override for Docker if `/tmp` is in memory.                                                                                                                      |
| `HEALTH_PORT`               | All              | `3000`           | HTTP port for the `/health` endpoint.                                                                                                                                                                                                          |

<details>
<summary>Advanced (leave as default unless you know why)</summary>

| Variable                   | Scope        | Default | What it does                                                                                                                                                                                                           |
| -------------------------- | ------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCAN_DEST_ID`             | All          | `0x02`  | Keepalive "Scan to Computer" selector. `0x02` is the only working value; others stop the destination appearing. For multiple instances, vary `SCAN_DEST_NAME` instead.                                                 |
| `LANGUAGE`                 | All          | `en`    | 2-letter locale sent to the printer; no observed user-visible effect.                                                                                                                                                  |
| `ESCI_FORCE_SOURCE`        | Legacy ESC/I | —       | Diagnostic override when FS F source autodetection misfires. Set to `flatbed`, `adf-simplex`, or `adf-duplex` to bypass the wire-byte detection.                                                                       |
| `PRINTER_CERT_FINGERPRINT` | ESC/I-2 TLS  | —       | SHA-256 fingerprint of the printer's TLS cert (e.g. `AB:CD:…`); scans abort on mismatch. **Requires `PRINTER_PROTOCOL=esci2`** — `auto` can't pin reliably and the non-TLS variants have no cert.                      |
| `DIAGNOSE_PROTOCOL`        | Legacy ESC/I | `false` | Compatibility-report aid. On a legacy `ESC @` non-ACK, sends one extra `FS Y` probe and aborts with annotated `[diagnose]` log lines. Leave off in normal use.                                                         |
| `NETSCAN_VERSION`          | All          | `auto`  | Compatibility-triage aid. Forces the discovery keepalive wire format (`2.0` / `3.0`); `auto` picks it from the scanner's announced PID (`3.0` for the FF-680W and DS-575W, else `2.0`). Leave on `auto` in normal use. |
| `SHUTDOWN_TIMEOUT_MS`      | All          | `30000` | ms to wait for an in-flight scan to finish on `SIGINT`/`SIGTERM` before forcing shutdown.                                                                                                                              |

</details>

### Verifying the printer's TLS certificate

By default, the service connects to the printer with TLS verification disabled. The printer ships a self-signed certificate with no published fingerprint, so standard validation can't apply. See [`SECURITY.md`](SECURITY.md) for the full rationale.

If you run the service on a network you don't fully trust, you can pin the printer's certificate. Capture its current fingerprint:

```bash
npm run printer-fingerprint -- 192.0.2.58
# AB:CD:EF:01:23:45:67:89:0A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78
```

Set `PRINTER_CERT_FINGERPRINT` to that value (env var or `compose.yaml`), and **also set `PRINTER_PROTOCOL=esci2`** so the auto-protocol probe can't downgrade silently to plain-TCP ESC/I and bypass the pin. The scanner will refuse any TLS peer whose cert doesn't match. If you ever swap the printer for another unit (warranty, upgrade), re-run the helper and update the env var.

## Pair with Paperless-ngx

Point `OUTPUT_DIR` at Paperless-ngx's consume directory (typically `./consume` or `/usr/src/paperless/consume` inside the container). Paperless picks up new files automatically.

```bash
PRINTER_IP=192.0.2.58 OUTPUT_DIR=/srv/paperless/consume npm run dev
```

### Direct upload (alternative to consume folder)

If you'd rather POST scans straight into Paperless-ngx's API than drop them into its consume folder, set:

| Var                             | Required for direct upload | Default | What it does                                                                                                                                 |
| ------------------------------- | -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAPERLESS_URL`                 | yes                        | —       | Base URL of your Paperless-ngx, e.g. `http://paperless:8000`. The service appends `/api/documents/post_document/`, so give it just the host. |
| `PAPERLESS_TOKEN`               | yes                        | —       | API token. Create via Paperless-ngx admin → Users → your user → API token.                                                                   |
| `PAPERLESS_TOKEN_FILE`          |                            | —       | Alternative to `PAPERLESS_TOKEN`; reads the token from a file. For Docker secrets / Kubernetes. Takes precedence if both are set.            |
| `PAPERLESS_DELETE_AFTER_UPLOAD` |                            | `true`  | Delete the local file after a successful upload. Set to `false` to keep a local copy.                                                        |

When both URL and token are set, every scan is uploaded **after** the local file is written. By default the local file is removed once the upload succeeds; set `PAPERLESS_DELETE_AFTER_UPLOAD=false` to keep a copy alongside the upload. If the upload fails (network blip, Paperless-ngx down), the local file is preserved. The scan is safe in `OUTPUT_DIR` and you can re-upload manually or fall back to the consume-folder path.

Multi-page ADF scans in JPG mode upload one document per page. Pick **PDF** on the printer panel if you'd rather have them grouped into a single Paperless-ngx document.

## Troubleshooting

**Destination doesn't appear on the printer panel.**
The printer broadcasts a discovery beacon roughly once a minute; wait at least 60 seconds. If it still doesn't appear:

- Confirm the PC is on the same subnet as the printer. Try `ping <printer-ip>`.
- Check your firewall. UDP port `2968` needs to be allowed for multicast traffic from the printer.
- Make sure Epson Event Manager isn't running on the same PC. It binds the same port. Other Epson software (drivers, ScanSmart) is fine.

**Service hangs after a scan.**
Rare edge case. Restart the service with `Ctrl-C` and relaunch.

**Output folder fills with duplicates named `scan_..._1.jpg`.**
Normal. If two scans land in the same second, the service appends `_1`, `_2` to avoid overwriting.

### Button-only scanner pairing

Button-only scanners — the **FF-680W** and **DS-575W** — have no panel to pick a destination from. The scanner stores a single paired host name and routes every button press to it, so the `ClientName` advertised by `epson2paperless` (i.e. `SCAN_DEST_NAME`) must match that stored name exactly. If it doesn't, the button press never reaches the service — you'll see healthy keepalives in the log but no scan.

Read the current paired name with SNMP:

```bash
snmpget -v1 -c epson <printer-ip> \
  1.3.6.1.4.1.1248.1.1.3.1.10.2.5.0
```

- **A name comes back** — common on the FF-680W if you've run Epson's software, which stores the PC's hostname. Either set `SCAN_DEST_NAME` to that value, or overwrite the stored name (below). Note the current value first if you may want to restore it.
- **An empty string comes back** — common on the DS-575W, whose button is not paired to a network destination out of the box. You must set it before any button press will reach the service.

Set the stored name to match `SCAN_DEST_NAME`:

```bash
snmpset -v1 -c epson <printer-ip> \
  1.3.6.1.4.1.1248.1.1.3.1.10.2.5.0 \
  s 'Paperless'
```

For example, with `SCAN_DEST_NAME=Paperless`, set the SNMP value to `Paperless` too. To undo, `snmpset` the original value back (or an empty string if it started empty).

## Further reading

- **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** — architecture overview and map of the main service flow.
- **[docs/PROTOCOL-REFERENCE.md](docs/PROTOCOL-REFERENCE.md)** — byte-level protocol details, scanner state machines, and printer-family differences.
- **[docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md)** — capture methodology, Frida/Ghidra notes, pcap fixture workflow, and replay strategy.

## Support

If `epson2paperless` saved you an afternoon of fighting with a printer and you'd like to say thanks, you can:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/A0A41CAGWG)

Equally valuable: reporting your printer's compatibility so the [Compatible printers](#compatible-printers) table grows.

## License & trademarks

MIT. See [`LICENSE`](LICENSE) for the full text.

**Not affiliated with Seiko Epson Corporation.** This project is an independent interoperability re-implementation of an Epson "Scan to Computer" workflow, based on observed protocol behavior of a device the author owns and limited functional analysis of related software. No Epson source code, firmware, binaries, or source-derived implementation code is included or distributed. "EPSON", "EcoTank", "Expression", and "WorkForce" are trademarks of Seiko Epson Corporation, used here descriptively to identify the hardware this software interoperates with.

---

_Current scope: ADF or flatbed scans, 1-Sided or 2-Sided (ADF), single or multi-page, JPG or PDF output._
