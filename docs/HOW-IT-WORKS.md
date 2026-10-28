# How it works

`epson2paperless` emulates the Windows side of Epson's "Scan to Computer" workflow. It presents a headless service as a scan destination named "Paperless", receives the scan selected from the printer panel, writes JPEG or PDF output to disk, and can optionally upload the completed file to Paperless-ngx.

At a high level, every supported printer follows the same three-channel flow:

```text
Printer (multicast)  ->  Service (multicast listener)     Discovery / keepalive
Printer (unicast)    ->  Service (TCP port 2968)          Panel trigger
Service              ->  Printer (TCP port 1865)          Scan session
Any host (unicast)   ->  Service (HEALTH_PORT, /scan)     Webhook trigger (optional, bearer token)
```

The first two channels are shared across supported models. The scan-session channel differs by protocol generation.

| Variant       | Transport    | Command set          | Hardware                                        |
| ------------- | ------------ | -------------------- | ----------------------------------------------- |
| `esci2`       | TLS over TCP | ESC/I-2 over IS      | ET-4950 / ET-3950 / ET-4956 / ET-2950           |
| `esci2-plain` | Plain TCP    | ESC/I-2 over IS      | ET-2750 / XP-7100 / ET-4800 / FF-680W / DS-575W |
| `esci`        | Plain TCP    | Legacy ESC/I over IS | WF-3620 family / XP-620 / ET-2550               |

Each variant is named by the `PRINTER_PROTOCOL` value that forces it: `esci2` is ESC/I-2 over TLS, `esci2-plain` is ESC/I-2 over plain TCP, and `esci` is legacy ESC/I.

This document is the front door: it explains how the pieces fit together. The byte-level protocol reference lives in [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md), and the capture / reverse-engineering workflow lives in [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md).

---

## Discovery and keepalive

Epson printers announce themselves over UDP multicast at `239.255.255.253:2968` whenever the panel needs a destination list — at power-on, on a manual refresh, and each time Scan > Computer is opened — not on a timer. The service joins that multicast group, listens for `02 06` announcement packets, and responds with a short burst of `02 07` keepalive packets sent directly back to the printer.

The important detail is that the keepalive must echo the announcement sequence byte. If the service sends the wrong sequence value, or sends keepalives outside the printer's announcement window, the printer ignores it and the destination never appears on the panel.

Implemented in `src/keepalive.ts`, with local-interface selection in `src/network.ts`.

---

## Panel trigger

When the user selects the Paperless destination and presses Scan, the printer opens a TCP connection to the service on port `2968` and sends an HTTP-shaped SOAP request. Epson's headers are not valid HTTP/1.1 because they include whitespace before the colon (`Header : value`), so the project uses a raw `net.createServer` rather than Node's HTTP server.

Only the configured printer's address is accepted on this port (`PRINTER_IP`, or whatever `PRINTER_HOSTNAME` currently resolves to); any other peer is dropped at connect time before a byte is read. A trigger that arrives while another scan is already running is answered with the protocol `ERROR` response and the panel shows an error, so the printer is never asked to serve two sessions at once. An admitted trigger holds the scan slot from that moment (`src/scan-admission.ts`), so a webhook request arriving during the response, or during the job-control read that precedes it for a v3 request, is refused rather than started alongside.

The SOAP body's `PushScanIDIn` value carries the panel choices:

- Byte 0: sides (`0` = simplex, `1` = duplex).
- Byte 1: action code (`1` = JPG, `2` = PDF, `3` = Attach as email, `4` = Preview on Computer). Email is not supported and is refused like any unrecognised value.

The response must echo the request's `x-uid` header exactly. If it does not, the data transfer can still succeed but the printer panel reports "Scanning Error" afterwards.

Implemented in `src/pushscan.ts`. Action decoding is split between `computeActionFromId` and `resolveEffectiveAction`, so `PREVIEW_ACTION=jpg` or `PREVIEW_ACTION=pdf` can turn Preview on Computer into a real scan.

---

## Scan-session dispatch

After the push-scan response is written, the service connects outbound to the printer on TCP port `1865`. In `PRINTER_PROTOCOL=auto`, `src/protocol-probe.ts` classifies the printer for each scan:

1. Try a TLS handshake. Success selects ESC/I-2 over TLS (`esci2`).
2. If TLS fails, connect over plain TCP and inspect the unsolicited IS welcome packet's discriminator byte: the WF-3620-shaped `0x02` selects `esci`, anything else selects `esci2-plain`. Known ESC/I-2 models whose welcome carries the legacy `0x02` (currently the ET-7700) skip this step — the push-scan PID selects `esci2-plain` directly.
3. If neither step classifies, fall back to `esci` so the scanner's connect path surfaces the underlying error.

The dispatcher in `src/startup.ts` then calls the matching scanner shell:

| Variant       | Scanner shell           | Protocol graph       |
| ------------- | ----------------------- | -------------------- |
| `esci2`       | `runEsci2Scan`          | `src/esci2/graph.ts` |
| `esci2-plain` | `runEsci2ScanOverPlain` | `src/esci2/graph.ts` |
| `esci`        | `runEsciScan`           | `src/esci/graph.ts`  |

The ESC/I-2 TLS result is cached for the daemon lifetime. Plain-TCP variants are re-probed because the probe is cheap and avoids pinning a transient misclassification.

---

## Scanner state machines

The scan-session engine is shared. `src/scan-session.ts` walks a protocol graph one IS packet at a time, carrying a typed context object through each transition. The graph decides what bytes to send next, whether to update context, when to flush a completed page, and when the session is done.

The ESC/I-2 graph covers both TLS and plain-TCP ESC/I-2 printers. Its broad flow is:

```text
connect -> welcome -> lock
  -> init poll / capability cycles (legacy ESC/I)
  -> mode switch
  -> PARA scan parameters
  -> TRDT data-transfer transition
  -> IMG metadata/data loop for each page
  -> post-scan ADF drain when needed
  -> unlock -> finalize output
```

The legacy ESC/I graph follows the same engine contract but uses a different command vocabulary: `ESC @`, `ESC e`, `FS W`, `FS G`, `FS F`, plus unsolicited `0xa200` image-stream chunks. Per-model differences (WF-3620 vs. the flatbed-only XP-620 and ET-2550) are resolved through the legacy dialects in `src/esci/dialects/`, keyed on the push-scan PID (`PID 08C8` → XP-620, `PID 1106` → ET-2550, `PID 08B8` and anything else → WF-3620), picked by `resolveLegacyEntry` — the legacy-path counterpart to the ESC/I-2 side's model overrides, matched by model identity. An ESC/I-2 printer no model override matches runs the generic dialect, built from its own INFO and CAPA replies, and the log says the model is untested. The printer's own PID, read from its `FS I` identity reply, is checked against the chosen dialect: the log says when an unrecognised model is trying the WF-3620 settings, and a PID-less `scan:now` on an ET-2550 switches to the ET-2550 dialect there, since both open the session the same way.

The protocol graphs intentionally stay separate. They share the engine and output pipeline, but not command construction or state names; that keeps the ESC/I-2 and WF-3620 behaviors easy to reason about independently.

---

## Source, sides, and action

The push-scan SOAP request tells the service the panel's Sides and Action choices, but it does not explicitly say whether the physical source is ADF or flatbed. Source is inferred from protocol responses:

Some scanners report no panel selection at all. The button-only, ADF-only models — the FF-680W (photo scanner) and DS-575W (document scanner) — send a bare `JobNumberIn` trigger with no Sides or Action, so the service takes sides, output format, and resolution from `SCAN_SIDES`, `SCAN_FORMAT`, and `SCAN_RESOLUTION` rather than from the panel (the DS-575W additionally reads its colour mode from `SCAN_COLOR_MODE`). These printers send NetScanMonitor v3 requests (`x-protocol-version : 3.00`), and a v3 request is answered after a job-control step over TCP/1865: a `JOBW` dummy-job commit for a `JobList` and a `JOBR` read for a `PushScan` with no `PushScanIDIn`. v1 and v2 requests use no job control, except from the FF-680W and DS-575W, which keep it whatever version they send. Any v3 trigger without a `PushScanIDIn` takes its sides and format from `SCAN_SIDES` / `SCAN_FORMAT`, so a scanner outside the supported list that sends v3 requests works the same way; for such a scanner a job-control failure is logged as a warning and the scan carries on, where on the FF-680W and DS-575W it is answered with an error.

- ESC/I-2 printers read the last `STAT` reply before PARA (after the mode switch) for both the source and the errors: it is the scanner's state at scan time. A printer with both a flatbed and an ADF takes its source from it: "ADF paper empty" → flatbed, anything else → ADF. Then, on every ESC/I-2 printer, an error there on the unit being scanned stops the scan before PARA with a message naming it; an error on another unit is logged as a warning and the scan carries on.
- ET-2750 and ET-2950 are fixed flatbed.
- Legacy ESC/I printers learn whether an ADF is fitted from the first `FS F` status reply. One with an ADF (WF-3620 class) probes with `ESC e` and inspects the following `FS F` status byte.
- One without (the ET-2550) scans from the flatbed and gets no `ESC e` probe: it has no source to select, and probing gets the parameter byte NAKed. It runs the WF-3620 flatbed path with both `ESC e` pairs skipped at `STATUS_1B`, `STATUS_2` and `RESET_INIT`. The XP-620 is fixed flatbed, like ET-2750 and ET-2950, and reaches the gamma phase through its own state group.

For duplex ADF scans on reversing-ADF hardware, back pages arrive physically rotated 180 degrees because of the feeder path. The scanner records back-page indices as pages complete. JPEG output receives a minimal EXIF Orientation=3 segment; PDF output sets `/Rotate = 180` on the affected pages. Neither path re-encodes pixels just to rotate them. On ESC/I-2 printers the choice comes from the printer's own INFO reply: a two-pass ADF (`#ADFDPLX2SCN`) gets the compensation, a single-pass one (`1SCN`, such as the FF-680W and DS-575W) reads both sides in one pass and its back pages are left as delivered. A duplex scan on a model whose orientation no capture or hardware report has confirmed logs a warning once per process, inviting a report.

For ESC/I-2 printers, the panel's JPG/PDF choice does not change the image stream: the printer sends JPEG data either way, and PDF composition happens on the host. For the WF-3620's legacy ESC/I path, the panel's Action sets the wire resolution, so JPG and PDF captures differ on the wire.

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
| Panel trigger         | `src/pushscan.ts`                                                                                                                       |
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
npm run typecheck
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
