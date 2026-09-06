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

| Model                 | Status               | Notes                                                                                                                         |
| --------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **DS-575W**           | 🟡&nbsp;Experimental | Requires [pairing](docs/BUTTON-ONLY-SCANNERS.md); ADF-only; only duplex colour PDF @ 200 DPI hardware-verified                |
| **ET-2550**           | ✅&nbsp;Verified     | Flatbed-only hardware                                                                                                         |
| **ET-2750**           | ✅&nbsp;Verified     | Flatbed-only hardware; ESC/I-2 over plain TCP, no TLS                                                                         |
| **ET-2810**           | ✅&nbsp;Verified     | Flatbed-only hardware; no panel trigger — needs `scan:now`                                                                    |
| **ET-2950**           | 🟡&nbsp;Experimental | Flatbed-only hardware; inferred dialect, no reporter retest yet ([#92](https://github.com/mtheuma/epson2paperless/issues/92)) |
| **ET-3950**           | ✅&nbsp;Verified     |                                                                                                                               |
| **ET-4800**           | ✅&nbsp;Verified     | ADF simplex; ESC/I-2 over plain TCP, no TLS                                                                                   |
| **ET-4950 / ET-4956** | ✅&nbsp;Verified     |                                                                                                                               |
| **ET-7700**           | ✅&nbsp;Verified     | Flatbed-only hardware                                                                                                         |
| **ET-8500**           | ✅&nbsp;Verified     | Flatbed-only hardware                                                                                                         |
| **ET-15000**          | 🟡&nbsp;Experimental | Flatbed verified; ADF simplex untested                                                                                        |
| **FF-680W**           | 🟡&nbsp;Experimental | Requires [pairing](docs/BUTTON-ONLY-SCANNERS.md); ADF-only; 200/300 DPI verified                                              |
| **WF-2845**           | ✅&nbsp;Verified     | ADF simplex ([#178](https://github.com/mtheuma/epson2paperless/issues/178))                                                   |
| **WF-3620**           | ✅&nbsp;Verified     | Plain TCP scanner, no TLS pinning                                                                                             |
| **WF-3835**           | 🟡&nbsp;Experimental | ADF simplex; inferred dialect, no reporter retest yet ([#174](https://github.com/mtheuma/epson2paperless/issues/174))         |
| **XP-620**            | 🟡&nbsp;Experimental | Flatbed-only hardware                                                                                                         |
| **XP-3200**           | ✅&nbsp;Verified     | Flatbed-only hardware; shares the ET-2810 dialect over TLS; panel lists the destination but errors "Invalid" — use `scan:now` |
| **XP-4100**           | ✅&nbsp;Verified     | Flatbed-only hardware; shares the ET-2750 dialect ([#139](https://github.com/mtheuma/epson2paperless/issues/139))             |
| **XP-7100**           | ✅&nbsp;Verified     |                                                                                                                               |

✅ **Verified**: every capability the hardware has is confirmed working on real hardware by someone.

🟡 **Experimental**: something is still untested; the Notes say what.

Compatibility reports are welcome whether your model works or doesn't. [Open an issue](https://github.com/mtheuma/epson2paperless/issues/new?template=compatibility.yml) using the compatibility template.

## Quick start

### Docker (recommended)

Image: **`ghcr.io/mtheuma/epson2paperless`**. Multi-arch (`linux/amd64`, `linux/arm64`). Published to GHCR on every `main` push (`:main`) and every `v*` git tag (`:vX.Y.Z` + `:latest`).

1. In `compose.yaml`, set exactly one of `PRINTER_IP` (fixed IPv4) or `PRINTER_HOSTNAME` (IPv4-resolvable DNS name), and `./output` to wherever you want scans written.
2. `docker compose up -d`.
3. Follow the logs: `docker compose logs -f epson2paperless`.

Notes:

- Uses host networking. The printer's multicast beacon can't reach a bridged container. [Why](docs/PROTOCOL-REFERENCE.md#discovery-and-keepalive-udp-multicast).
- Listens on all interfaces: TCP `2968` for the scan trigger, plus `HEALTH_PORT` (default `3000`). The trigger carries no credential — the printer has no way to log in — so since v0.9.0 the service only accepts connections on `2968` from the configured printer address (`PRINTER_IP`, or whatever `PRINTER_HOSTNAME` currently resolves to); any other LAN host is dropped at connect. That is source filtering, not authentication. Keep the service on a network you trust.
- Several destinations on the panel (e.g. a greyscale-PDF preset and a colour-JPG preset): one container per entry, each with its own MAC on a `macvlan` network. Compose example and caveats in [MULTIPLE-DESTINATIONS.md](docs/MULTIPLE-DESTINATIONS.md).
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

**One-shot mode.** `npm run scan` runs a single scan and exits, handy for cron jobs or end-to-end tests. Exit codes: `0` success, `1` scan failure. On `SIGINT`/`SIGTERM` an in-flight scan is allowed to finish first (bounded by `SHUTDOWN_TIMEOUT_MS`) and its result is reported; `130`/`143` only when no scan had started or the drain timed out. A signal arriving while a panel press is still being answered waits for its scan to start, and the scan then gets what is left of the same budget. No health endpoint is opened, and a second panel press while the scan runs is refused immediately.

**Host-triggered scan.** `npm run scan:now` scans immediately and exits, without waiting
for a panel button. It skips discovery and the push-scan listener entirely and pulls the
scan directly. Use it for cron, Home Assistant, smart buttons, or printers that don't
offer "Scan to Computer" as a network destination at all (the ET-2810). It exits `0` on
success and `1` on failure, and on `SIGINT`/`SIGTERM` it lets an in-flight scan finish
first, bounded by `SHUTDOWN_TIMEOUT_MS`.

There's no panel to pick the format, so `SCAN_FORMAT` (`jpg`/`pdf`, default `pdf`) and
`SCAN_SIDES` (`simplex`/`duplex`, default `duplex`) decide. `scan:now` reads these and
the printer target (`PRINTER_IP` or `PRINTER_HOSTNAME`) from the environment like the daemon and takes no command-line arguments, so
set them however you set any env var. From source:

    PRINTER_HOSTNAME=printer.lan npm run scan:now                              # defaults: pdf, duplex
    PRINTER_IP=192.0.2.58 SCAN_FORMAT=jpg SCAN_SIDES=simplex npm run scan:now

In Docker `PRINTER_IP` already lives in your compose file / env-file, and you override per
invocation with `-e` (handy for two smart buttons on different settings):

    docker compose run --rm epson2paperless dist/scan-now.js
    docker compose run --rm -e SCAN_SIDES=simplex epson2paperless dist/scan-now.js

Use `docker compose run`, not bare `docker run`: compose reuses the output volume and host
networking, whereas a bare `docker run --rm` needs `-v ./output:/output --network host` or
the scan is written inside the container and lost on exit.

The printer serves one scan at a time, so don't trigger `scan:now` while a panel scan (or
another `scan:now`) is already running.

<a id="webhook-trigger"></a>
**Webhook trigger.** For callers that can't spawn a container, such as a Home Assistant
install without Docker access or an ESP32 on the LAN, the running daemon can accept the
same host-triggered scan over HTTP. Set `SCAN_TRIGGER_TOKEN` to a long random secret and
the daemon opens `POST /scan` on `HEALTH_PORT` (default `3000`). Without the token the path
is a plain 404. Every request must carry the token as a bearer
header; `format` (`jpg`/`pdf`) and `sides` (`simplex`/`duplex`) are optional query
parameters that default to `SCAN_FORMAT` / `SCAN_SIDES`, exactly like `scan:now`:

    curl -X POST -H "Authorization: Bearer $SCAN_TRIGGER_TOKEN" \
      "http://<host>:3000/scan?format=pdf&sides=simplex"

Responses: `202` accepted (the scan starts after the response; watch the logs for the
result), `401` bad or missing token, `400` bad parameter, `409` a scan is already running,
`405` anything other than POST. `/health` keeps reporting `lastScan`, which is the time the
last scan was _triggered_ (panel or webhook), not whether it succeeded.

One scan at a time is enforced both ways: the webhook answers `409` while a panel scan runs,
and the printer panel shows an error if Scan is pressed while a webhook scan runs. The panel
side of this applies whether or not the webhook is enabled: pressing Scan while a previous
scan is still running is now refused at the trigger (panel error, nothing sent to the printer)
where earlier versions opened a second session that the printer then rejected.

A Home Assistant `rest_command`, with the whole header value kept in `secrets.yaml`
(Home Assistant's `!secret` must replace the entire value, not part of it):

```yaml
# configuration.yaml
rest_command:
  scan_to_paperless:
    url: "http://<host>:3000/scan?sides=simplex"
    method: POST
    headers:
      Authorization: !secret scan_trigger_authorization

# secrets.yaml
scan_trigger_authorization: "Bearer YOUR_LONG_RANDOM_TOKEN"
```

The webhook takes the same path as `scan:now`, so the model caveats below apply to it too.
`HEALTH_PORT` listens on every interface; if the LAN is not trusted, firewall it.

The host trigger is validated end-to-end on the ET-2810, XP-3200 and ET-4956. Other models are
untested over this path: it may work, and reports are welcome either way. The FF-680W is
expected to fail, because its panel flow does job preparation that a host-triggered scan
skips. On ADF models without duplex hardware (ET-4800, ET-15000), set `SCAN_SIDES=simplex`
— a duplex request is refused rather than sent to the printer.

## Use it

1. Load pages in the ADF, or leave the ADF empty and place a single sheet on the flatbed glass. The printer detects which source is loaded.
2. At the printer panel, press **Scan** → select your destination (default `Paperless`).
3. Choose **Action** (Save as JPEG / Save as PDF) and **Sides** (1-Sided / 2-Sided) on the panel.
4. Wait for the panel to show **"Scan complete"**.
5. A timestamped file appears in `OUTPUT_DIR`, stamped in the timezone `TZ` names (the container/system zone if unset — UTC in the published image):
   - JPG, single page → `scan_2026-04-20_081438.jpg`
   - JPG, multi-page → `scan_2026-04-20_081438_01.jpg`, `_02.jpg`, …
   - PDF, any page count → one multi-page `scan_2026-04-20_081438.pdf`

## Configure

Configuration is via environment variables. Exactly one of `PRINTER_IP` and `PRINTER_HOSTNAME` is required.

Each setting's **Scope** column shows which printers it affects: `All`, `Panel` (panel-driven models), `FF-680W`, `DS-575W`, `Legacy ESC/I` (WF-3620 family, XP-620, ET-2550), or `ESC/I-2 TLS` (ET-4950 family). A setting outside a printer's path is simply ignored.

| Variable              | Scope                        | Default          | What it does                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRINTER_IP`          | All                          | —                | Fixed printer IPv4 address. Mutually exclusive with `PRINTER_HOSTNAME`; retained for compatibility.                                                                                                                                                      |
| `PRINTER_HOSTNAME`    | All                          | —                | DNS hostname for the printer. IPv4 results are loaded at startup, refreshed every 30 seconds, and refreshed on demand for an unknown peer; the last known-good set is retained after transient DNS failure. Mutually exclusive with `PRINTER_IP`.        |
| `SCAN_DEST_NAME`      | All                          | `Paperless`      | The label the printer shows on its panel. Give each instance a distinct name. On button-only scanners (FF-680W, DS-575W) it must also match the scanner's stored paired name; see [Button-only scanners](docs/BUTTON-ONLY-SCANNERS.md).                  |
| `OUTPUT_DIR`          | All                          | `/output`        | Where scans are written (JPG or PDF, depending on panel). Created automatically.                                                                                                                                                                         |
| `TZ`                  | All                          | system           | Timezone for scan filename timestamps. The standard Docker variable, read by Node directly — no app-side validation. Unset uses the container/system zone, which is UTC in the published image.                                                          |
| `LOG_LEVEL`           | All                          | `info`           | `debug` / `info` / `warn` / `error`.                                                                                                                                                                                                                     |
| `LOG_FORMAT`          | All                          | `text`           | `text` (human-readable) or `json` (ndjson, one record per line, for `docker logs` + Loki / `jq`).                                                                                                                                                        |
| `PREVIEW_ACTION`      | Panel                        | `reject`         | What to do when the panel's Action is "Preview on Computer": `reject` silently ignores the scan; `jpg` or `pdf` treats it as if that format was chosen.                                                                                                  |
| `SCAN_FORMAT`         | FF-680W, DS-575W, `scan:now` | `pdf`            | Output format (`jpg` / `pdf`) when no panel choice reaches us: button-only scanners, and every host-triggered scan.                                                                                                                                      |
| `SCAN_SIDES`          | FF-680W, DS-575W, `scan:now` | `duplex`         | `simplex` or `duplex` when no panel choice reaches us. Button-only scanners have no panel Sides selector. Set `simplex` for host-triggered scans on ADF models without duplex hardware.                                                                  |
| `SCAN_RESOLUTION`     | All                          | unset            | Target scan DPI (50-1200). Honoured on the wire where the printer advertises it; otherwise scans at the model's fixed DPI and downsamples. Unset = model default.                                                                                        |
| `SCAN_COLOR_MODE`     | All                          | `color`          | `color`, `grayscale`, or `auto`. `grayscale` always yields greyscale: requested on the wire where supported (DS-575W), converted host-side elsewhere. `auto` works on any model: scans in colour, then saves colourless pages as greyscale.              |
| `PRINTER_WHITE_POINT` | All                          | unset            | How this scanner renders white paper, `R:G:B` (e.g. `227:232:255`). Only affects `SCAN_COLOR_MODE=auto`, correcting the device's colour cast before deciding colour vs greyscale. Measure once with `npm run scan:calibrate`; unset means no correction. |
| `PRINTER_PROTOCOL`    | All                          | `auto`           | `auto` (probe each session), `esci2` (force ESC/I-2 over TLS), `esci2-plain` (force ESC/I-2 over plain TCP), `esci` (force plain-TCP ESC/I).                                                                                                             |
| `JPEG_QUALITY`        | All                          | `90`             | JPEG encoder quality 1–100 (host-encoded raw pixels), and the ESC/I-2 wire request (clamped to what the printer advertises). Also sets the re-encode quality when `POST_PROCESS=document`.                                                               |
| `POST_PROCESS`        | All                          | `none`           | `document` neutralizes the paper white-point (removes blue cast, show-through, ADF sensor lines) and re-encodes at `JPEG_QUALITY`; `none` leaves the printer's raw JPEG untouched.                                                                       |
| `TEMP_DIR`            | All                          | (system default) | Where per-scan temp files go. Leave empty for the OS default (`os.tmpdir()`). Override for Docker if `/tmp` is in memory.                                                                                                                                |
| `HEALTH_PORT`         | All                          | `3000`           | HTTP port for the `/health` endpoint and, when enabled, `POST /scan`.                                                                                                                                                                                    |
| `SCAN_TRIGGER_TOKEN`  | All                          | unset            | Enables the `POST /scan` webhook on `HEALTH_PORT`. Requests must send `Authorization: Bearer <token>`. Unset = endpoint off (404). See [Webhook trigger](#webhook-trigger).                                                                              |

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
| `SHUTDOWN_TIMEOUT_MS`      | All          | `30000` | ms to wait for an in-flight scan to finish on `SIGINT`/`SIGTERM` before forcing shutdown. One-shot also spends it on a panel press still being answered.                                                               |

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

**Pressing Start shows "Scanning error" instantly, and no `[pushscan]` line appears in the log.**
Discovery is working (keepalive lines in the log) but the printer's scan trigger isn't reaching the service. Two known causes:

- A firewall on the host is blocking inbound **TCP** port `2968`. Discovery only needs UDP; the scan trigger arrives on TCP. Allow both.
- "Scan to Computer" was declined during the printer's initial network setup. It can't be re-enabled from the settings menus afterwards. Reset the printer's network settings and accept the Scan to Computer prompt when setting it up again.

**`PRINTER_HOSTNAME=EPSONXXXX.local` doesn't resolve.**
The image ships no mDNS resolver, so `.local` works only where the host's own resolver bridges mDNS (systemd-resolved can, with `MulticastDNS=` enabled globally and on the link, which most distros leave off). That varies by host, so prefer:

- A unicast DNS name. Many routers publish DHCP client names, e.g. `epsonxxxx.lan`.
- A DHCP reservation plus `PRINTER_IP`, if your router doesn't publish names.
- An `/etc/hosts` entry or compose `extra_hosts`. Works, but pins the name to one address, giving up the address tracking `PRINTER_HOSTNAME` is for.

**Service hangs after a scan.**
Rare edge case. Restart the service with `Ctrl-C` and relaunch.

**Output folder fills with duplicates named `scan_..._1.jpg`.**
Normal. If two scans land in the same second, the service appends `_1`, `_2` to avoid overwriting.

## Further reading

- **[docs/BUTTON-ONLY-SCANNERS.md](docs/BUTTON-ONLY-SCANNERS.md)** — pairing the FF-680W and DS-575W over SNMP so their Start button reaches the service.
- **[docs/MULTIPLE-DESTINATIONS.md](docs/MULTIPLE-DESTINATIONS.md)** — running several presets as separate panel entries (one container per MAC on `macvlan`).
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
