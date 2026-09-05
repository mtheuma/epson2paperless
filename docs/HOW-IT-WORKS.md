# How it works

`epson2paperless` emulates the Windows side of Epson's "Scan to Computer" workflow. It presents a headless service as a scan destination named "Paperless", receives the scan selected from the printer panel, writes JPEG or PDF output to disk, and can optionally upload the completed file to Paperless-ngx.

At a high level, every supported printer follows the same three-channel flow:

```text
Printer (broadcast)  ->  Service (multicast listener)     Discovery / keepalive
Printer (unicast)    ->  Service (TCP port 2968)          Push-scan trigger
Service              ->  Printer (TCP port 1865)          Scan session
Any host (unicast)   ->  Service (HEALTH_PORT, /scan)     Webhook trigger (optional, bearer token)
```

The first two channels are shared across supported models. The scan-session channel differs by protocol generation.

| Variant       | Transport    | Command set          | Hardware                                        |
| ------------- | ------------ | -------------------- | ----------------------------------------------- |
| `esci2-tls`   | TLS over TCP | ESC/I-2 over IS      | ET-4950 / ET-3950 / ET-4956 / ET-2950           |
| `esci2-plain` | Plain TCP    | ESC/I-2 over IS      | ET-2750 / XP-7100 / ET-4800 / FF-680W / DS-575W |
| `esci`        | Plain TCP    | Legacy ESC/I over IS | WF-3620 family / XP-620 / ET-2550               |

`esci2-tls` is internal shorthand for the TLS ESC/I-2 path. In configuration, this is selected with `PRINTER_PROTOCOL=esci2`.

This document is the front door: it explains how the pieces fit together. The byte-level protocol reference lives in [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md), and the capture / reverse-engineering workflow lives in [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md).

---

## Discovery and keepalive

Epson printers periodically announce themselves over UDP multicast at `239.255.255.253:2968`. The service joins that multicast group, listens for `02 06` announcement packets, and responds with a short burst of `02 07` keepalive packets sent directly back to the printer.

The important detail is that the keepalive must echo the announcement sequence byte. If the service sends the wrong sequence value, or sends keepalives outside the printer's announcement window, the printer ignores it and the destination never appears on the panel.

Implemented in `src/keepalive.ts`, with local-interface selection in `src/network.ts`.

---

## Push-scan trigger

When the user selects the Paperless destination and presses Scan, the printer opens a TCP connection to the service on port `2968` and sends an HTTP-shaped SOAP request. Epson's headers are not valid HTTP/1.1 because they include whitespace before the colon (`Header : value`), so the project uses a raw `net.createServer` rather than Node's HTTP server.

Only the configured printer's address is accepted on this port (`PRINTER_IP`, or whatever `PRINTER_HOSTNAME` currently resolves to); any other peer is dropped at connect time before a byte is read. A trigger that arrives while another scan is already running is answered with the protocol `ERROR` response and the panel shows an error, so the printer is never asked to serve two sessions at once. An admitted trigger holds the scan slot from that moment (`src/scan-admission.ts`), so a webhook request arriving during the response, or during the FF-680W / DS-575W job-control read that precedes it, is refused rather than started alongside.

The SOAP body's `PushScanIDIn` value carries the panel choices:

- Byte 0: sides (`0` = 1-sided, `1` = 2-sided).
- Byte 1: action bitmask (`1` = JPG, `2` = PDF, `4` = Preview on Computer).

The response must echo the request's `x-uid` header exactly. If it does not, the data transfer can still succeed but the printer panel reports "Scanning Error" afterwards.

Implemented in `src/pushscan.ts`. Action decoding is split between `computeActionFromId` and `resolveEffectiveAction`, so `PREVIEW_ACTION=jpg` or `PREVIEW_ACTION=pdf` can turn Preview on Computer into a real scan.

---

## Scan-session dispatch

After the push-scan response is written, the service connects outbound to the printer on TCP port `1865`. In `PRINTER_PROTOCOL=auto`, `src/protocol-probe.ts` classifies the printer for each scan:

1. Try a TLS handshake. Success selects `esci2-tls`.
2. If TLS fails, connect over plain TCP and inspect the unsolicited IS welcome packet's discriminator byte: the WF-3620-shaped `0x02` selects `esci`, anything else selects `esci2-plain`. Known ESC/I-2 models whose welcome carries the legacy `0x02` (currently the ET-7700) skip this step — the push-scan PID selects `esci2-plain` directly.
3. If neither arm classifies, fall back to `esci` so the scanner's connect path surfaces the underlying error.

The dispatcher in `src/startup.ts` then calls the matching scanner shell:

| Variant       | Scanner shell           | Protocol graph       |
| ------------- | ----------------------- | -------------------- |
| `esci2-tls`   | `runEsci2Scan`          | `src/esci2/graph.ts` |
| `esci2-plain` | `runEsci2ScanOverPlain` | `src/esci2/graph.ts` |
| `esci`        | `runEsciScan`           | `src/esci/graph.ts`  |

The ESC/I-2 TLS result is cached for the daemon lifetime. Plain-TCP variants are re-probed because the probe is cheap and avoids pinning a transient misclassification.

---

## Scanner state machines

The scan-session engine is shared. `src/scan-session.ts` walks a protocol graph one IS packet at a time, carrying a typed context object through each transition. The graph decides what bytes to send next, whether to update context, when to flush a completed page, and when the session is done.

The ESC/I-2 graph covers both TLS and plain-TCP ESC/I-2 printers. Its broad flow is:

```text
connect -> welcome -> lock
  -> legacy init / capability cycles
  -> mode switch
  -> PARA scan parameters
  -> TRDT data-transfer transition
  -> IMG metadata/data loop for each page
  -> post-scan ADF drain when needed
  -> unlock -> finalize output
```

The legacy ESC/I graph follows the same engine contract but uses a different command vocabulary: `ESC @`, `ESC e`, `FS W`, `FS G`, `FS F`, plus unsolicited `0xa200` image-stream chunks. Per-model differences (WF-3620 vs. the flatbed-only XP-620 and ET-2550) are resolved through a small dialect registry (`src/esci/dialects/`) keyed on the push-scan PID (`PID 08C8` → XP-620, `PID 1106` → ET-2550, anything else → WF-3620), picked by `resolveLegacyEntry` — the legacy-path counterpart to the ESC/I-2 side's CAPA-fingerprint registry.

The protocol graphs intentionally stay separate. They share the engine and output pipeline, but not command construction or state names; that keeps the ESC/I-2 and WF-3620 behaviors easy to reason about independently.

---

## Source, sides, and action

The push-scan SOAP request tells the service the panel's Sides and Action choices, but it does not explicitly say whether the physical source is ADF or flatbed. Source is inferred from protocol responses:

Some scanners report no panel selection at all. The button-only, ADF-only models — the FF-680W (photo scanner) and DS-575W (document scanner) — send a bare `JobNumberIn` trigger with no Sides or Action, so the service takes sides, output format, and resolution from `SCAN_SIDES`, `SCAN_FORMAT`, and `SCAN_RESOLUTION` rather than from the panel (the DS-575W additionally reads its colour mode from `SCAN_COLOR_MODE`). Answering that trigger also requires a job-control handshake over TCP/1865 — a `JOBW` dummy-job commit at `JobList` time and a `JOBR` read at `JobNumberIn` time — before the scan session proper starts.

- ESC/I-2 ADF-capable printers use an INIT_POLL `STAT` length heuristic.
- ET-2750 and ET-2950 are fixed flatbed.
- WF-3620-class ESC/I printers probe with `ESC e` and inspect the following `FS F` status byte.
- XP-620 and ET-2550 are fixed flatbed, like ET-2750 and ET-2950, but on the legacy ESC/I side. A `fixed-flatbed` entry skips the `ESC e` probe entirely: those printers have no source to select and their drivers never send one, so probing gets the parameter byte NAKed. The XP-620 reaches the gamma phase through its own state group; the ET-2550 runs the WF-3620 flatbed path with both `ESC e` pairs skipped at `STATUS_1B`, `STATUS_2` and `RESET_INIT`.

For duplex ADF scans on reversing-ADF hardware, back sides arrive physically rotated 180 degrees because of the feeder path. The scanner records back-page indices as pages complete. JPEG output receives a minimal EXIF Orientation=3 segment; PDF output sets `/Rotate = 180` on the affected pages. Neither path re-encodes pixels just to rotate them. Single-pass dual-sensor scanners (the DS-575W) deliver back sides upright, so their registry entry opts out of the compensation (`duplexBackRotated: false`).

For ESC/I-2 printers, the panel's JPG/PDF choice does not change the image stream: the printer sends JPEG data either way, and PDF composition happens on the host. For the WF-3620 legacy path, the panel format affects scan resolution, so JPG and PDF captures differ on the wire.

---

## Output and Paperless upload

Both scanners write per-page JPEGs into a session temp directory and then hand off to `finalizeSession` in `src/output-tail.ts`.

- `action='jpg'`: promote page JPEGs to `scan_<timestamp>{,_NN}.jpg` in the output directory.
- `action='pdf'`: compose `scan_<timestamp>.pdf` with pdf-lib; if composition fails, fall back to JPEG promotion.

When `PAPERLESS_URL` and `PAPERLESS_TOKEN` are configured, completed output files are uploaded to Paperless-ngx's `/api/documents/post_document/` endpoint. `PAPERLESS_DELETE_AFTER_UPLOAD` controls whether the local file is deleted after a successful upload.

---

## Code layout

| Area                  | Files                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Process entry points  | `src/index.ts`, `src/one-shot.ts`, `src/startup.ts`, `src/lifecycle.ts`                                                                 |
| Discovery             | `src/keepalive.ts`, `src/network.ts`                                                                                                    |
| Push-scan trigger     | `src/pushscan.ts`                                                                                                                       |
| Webhook trigger       | `src/scan-trigger.ts`, `src/health.ts`, `src/scan-admission.ts`                                                                         |
| Protocol selection    | `src/protocol-probe.ts`                                                                                                                 |
| Shared session engine | `src/scan-session.ts`, `src/protocol.ts`, `src/graph-helpers.ts`                                                                        |
| ESC/I-2 path          | `src/esci2/scanner.ts`, `src/esci2/graph.ts`, `src/esci2/commands.ts`, `src/esci2/transport.ts`, `src/esci2/dialects/`                  |
| Legacy ESC/I path     | `src/esci/scanner.ts`, `src/esci/graph.ts`, `src/esci/commands.ts`, `src/esci/luts.ts`, `src/esci/raw-to-jpeg.ts`, `src/esci/dialects/` |
| Shared FS commands    | `src/commands-fs.ts`                                                                                                                    |
| Output pipeline       | `src/output.ts`, `src/output-tail.ts`, `src/exif.ts`, `src/pdf.ts`, `src/paperless-upload.ts`                                           |
| Health and logging    | `src/health.ts`, `src/logger.ts`                                                                                                        |

Test files mirror the modules they cover. The replay harnesses in `src/esci2/scanner.test.ts` and `src/esci/scanner.test.ts` are the most important protocol regression protection.

---

## Testing philosophy

Protocol edits should be treated as replay-fixture-sensitive changes. The ESC/I-2 TLS path is protected by byte-for-byte replay against Frida captures from the Windows driver. The plain-TCP variants are protected by pcap-derived behavioral replays that assert completed output and session behavior.

For routine changes, run the focused Vitest file first, then the full gate before publishing:

```sh
npm run lint
npm run format:check
npm test
```

Use [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md) when changing scanner bytes or state transitions. Use [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) when adding support for a new printer or creating new capture fixtures.

---

## References

- [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md) — byte-level protocol details and model differences.
- [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) — capture workflow, Frida/Ghidra notes, pcap fixture workflow, and replay strategy.
- [README.md](../README.md) — install, run, and configuration guide.
