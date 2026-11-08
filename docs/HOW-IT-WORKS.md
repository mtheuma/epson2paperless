# How it works

`epson2paperless` emulates the Windows side of Epson's "Scan to Computer" workflow. It presents a headless service as a scan destination named "Paperless", receives the scan chosen on the printer panel, writes JPEG or PDF output to disk, and can upload the finished file to Paperless-ngx.

Every supported printer uses the same channels:

```text
Printer (multicast)  ->  Service (multicast listener)     Discovery / keepalive
Printer (unicast)    ->  Service (TCP port 2968)          Panel trigger
Service              ->  Printer (TCP port 1865)          Scan session
Any host (unicast)   ->  Service (HEALTH_PORT, /scan)     Webhook trigger (optional, bearer token)
```

Discovery and the panel trigger are shared across supported models, with small per-model variations. The scan session comes in three variants, each named by the `PRINTER_PROTOCOL` value that forces it: `esci2` is ESC/I-2 over TLS, `esci2-plain` is ESC/I-2 over plain TCP, and `esci` is legacy ESC/I over plain TCP, all inside Epson's IS framing. [Scan session variants](PROTOCOL-REFERENCE.md#scan-session-variants-on-port-1865) gives example models for each.

This document is the front door: it explains how the pieces fit together. [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md) has the byte-level protocol, [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) the capture and fixture workflow, and the [README](../README.md) installation, configuration and the [full list of compatible printers](../README.md#compatible-printers).

---

## Discovery and keepalive

Epson printers announce themselves over UDP multicast at `239.255.255.253:2968` whenever the panel needs a destination list (at power-on, on a manual refresh, and each time Scan > Computer is opened), not on a timer. The service joins that multicast group, listens for `02 06` announcement packets, and answers each with a short burst of `02 07` keepalive packets sent straight back to the printer.

The keepalive must echo the announcement's sequence byte. With the wrong value, or sent outside the printer's announcement window, it is ignored and the destination never appears on the panel.

Implemented in `src/keepalive.ts`, with local-interface selection in `src/network.ts`.

---

## Panel trigger

When someone selects the Paperless destination and presses Scan, the printer opens a TCP connection to the service on port `2968` and sends an HTTP-shaped SOAP request. Epson's headers aren't valid HTTP/1.1 (they put whitespace before the colon, `Header : value`), so the service uses a raw `net.createServer` rather than Node's HTTP server. Only the configured printer's address is accepted (`PRINTER_IP`, or whatever `PRINTER_HOSTNAME` currently resolves to); any other peer is dropped at connect time, before a byte is read.

The SOAP body's `PushScanIDIn` value carries the panel's choices: byte 0 is Sides (`0` simplex, `1` duplex) and byte 1 is Action (`1` JPG, `2` PDF, `3` Attach as email, `4` Preview on Computer). Email isn't supported and is refused like any unrecognised value, and `PREVIEW_ACTION=jpg` or `pdf` turns Preview into a real scan. The response must echo the request's `x-uid` header exactly; if it doesn't, the data transfer can still succeed but the panel reports "Scanning Error" afterwards.

Button-only scanners (the FF-680W and DS-575W) send no `PushScanIDIn`, so their sides and format come from `SCAN_SIDES` and `SCAN_FORMAT`. A `JobList`, or a `PushScan` with no `PushScanIDIn`, gets a short job-control exchange over TCP/1865 before the service answers it, when it is a NetScanMonitor v3 request or comes from one of these two scanners. [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md#panel-trigger-tcp-soap-ish) covers both.

The printer serves one scan session at a time, so the panel trigger and the webhook share one scan slot (`src/scan-admission.ts`). A panel trigger that arrives while the slot is taken is answered with the protocol `ERROR` response and the panel shows an error; a webhook request gets `409`. An admitted trigger holds the slot from that moment, so a webhook request can't start a second scan while the response, or the job-control read that precedes it for a v3 request, is still in progress. A scan gives the slot up when its scan session ends: its output file and Paperless upload finish in the background while the next trigger is admitted.

Implemented in `src/pushscan.ts`, with job control in `src/job-control.ts`.

---

## Scan-session dispatch

After the panel trigger's response is written, the service connects to the printer on TCP port `1865`. Under `PRINTER_PROTOCOL=auto`, `src/protocol-probe.ts` picks the variant for each scan:

1. Try a TLS handshake. Success selects `esci2`.
2. If TLS fails, connect over plain TCP and read the discriminator byte of the printer's unsolicited IS welcome packet: the WF-3620-shaped `0x02` selects `esci`, anything else `esci2-plain`. Known ESC/I-2 models whose welcome carries the legacy ESC/I `0x02` (currently the ET-7700) skip this step, and the panel trigger's PID selects `esci2-plain` directly.
3. If neither step classifies, fall back to `esci`, so the scanner's connect path reports the underlying error.

The TLS result is cached for the daemon's lifetime. Plain-TCP printers are re-probed each time, because the probe is cheap and re-probing avoids pinning a transient misclassification. The dispatcher in `src/startup.ts` then calls the matching scanner shell:

| Variant       | Scanner shell           | Protocol graph       |
| ------------- | ----------------------- | -------------------- |
| `esci2`       | `runEsci2Scan`          | `src/esci2/graph.ts` |
| `esci2-plain` | `runEsci2ScanOverPlain` | `src/esci2/graph.ts` |
| `esci`        | `runEsciScan`           | `src/esci/graph.ts`  |

---

## Scanner state machines

One engine, `src/scan-session.ts`, runs every scan session. It walks a protocol graph one IS packet at a time, carrying a typed context object through each transition. The graph decides what bytes to send next, when to flush a completed page, and when the session is done.

The ESC/I-2 graph serves both TLS and plain-TCP ESC/I-2 printers. Its broad flow is:

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

The legacy ESC/I graph follows the same engine contract with a different command vocabulary: `ESC @`, `ESC e`, `FS W`, `FS G`, `FS F`, plus unsolicited `0xa200` image-stream chunks. The two graphs share the engine and the output pipeline but not command construction or state names, so each protocol generation can be reasoned about on its own.

Per-model differences are data, not branches in the graph:

- **ESC/I-2:** a model override, matched by model identity from the printer's INFO reply (or by its CAPA fingerprint as a fallback), supplies only what the printer's own replies can't (a captured colour pair, a scan window, quirks); everything else is derived from those replies. A printer no model override matches runs the generic dialect, and the log says the model is untested. See [How printer-model differences are handled](PROTOCOL-REFERENCE.md#how-printer-model-differences-are-handled).
- **Legacy ESC/I:** one legacy dialect per model, chosen by the panel trigger's PID and checked against the printer's own `FS I` identity reply. See [Legacy dialects](PROTOCOL-REFERENCE.md#legacy-dialects).

---

## Source, sides, and action

The panel trigger carries the panel's Sides and Action choices, but not whether the scan is from the ADF or the flatbed. The source comes from the scan session instead:

- **ESC/I-2:** a printer with both a flatbed and an ADF reads the status reply just before PARA, the scanner's state at scan time: "ADF paper empty" means flatbed, anything else means ADF. A printer with one source is fixed to it. On every ESC/I-2 printer, an error in that reply for the source being scanned stops the scan before PARA with a message naming it; an error elsewhere on the printer is logged as a warning and the scan carries on.
- **Legacy ESC/I:** the first `FS F` status reply says whether an ADF is fitted. With one (the WF-3620 class), the session probes with `ESC e` and reads the next `FS F` status byte. Without one (the ET-2550), it scans the flatbed with no `ESC e` probe. The flatbed-only XP-620 is fixed to the flatbed from the start.

On ESC/I-2 printers the panel's JPG/PDF choice doesn't change the image stream: the printer sends JPEG either way, and PDF composition happens on the host. On the WF-3620's legacy ESC/I path the Action sets the wire resolution, so JPG and PDF sessions differ on the wire.

On a two-pass ADF, duplex back pages arrive physically rotated 180° by the feeder path. The service marks them rather than re-encoding pixels: JPG output gets a minimal EXIF `Orientation=3` segment, and PDF output sets `/Rotate = 180` on those pages. ESC/I-2 printers say in their INFO reply whether the ADF is two-pass (`#ADFDPLX2SCN`); a single-pass one (`1SCN`, such as the FF-680W and DS-575W) reads both sides at once, and its back pages are left as they arrive. A duplex scan on a model whose orientation no capture or hardware report has confirmed logs a warning once per process, inviting a report.

---

## Output and Paperless upload

Both scanners write per-page JPEGs into a session temp directory, then hand off to `finalizeSession` in `src/output-tail.ts`:

- `action='jpg'`: promote the page JPEGs to `scan_<timestamp>{,_NN}.jpg` in the output directory.
- `action='pdf'`: compose `scan_<timestamp>.pdf` with pdf-lib, falling back to JPEG promotion if composition fails.

When `PAPERLESS_URL` and `PAPERLESS_TOKEN` are configured, completed output files are uploaded to Paperless-ngx's `/api/documents/post_document/` endpoint. `PAPERLESS_DELETE_AFTER_UPLOAD` controls whether the local file is deleted after a successful upload.

---

## Code layout

| Area                  | Files                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process entry points  | `src/index.ts`, `src/one-shot.ts`, `src/scan-now.ts`, `src/startup.ts`, `src/lifecycle.ts`                                                                |
| Discovery             | `src/keepalive.ts`, `src/network.ts`                                                                                                                      |
| Panel trigger         | `src/pushscan.ts`, `src/job-control.ts`                                                                                                                   |
| Webhook trigger       | `src/scan-trigger.ts`, `src/health.ts`, `src/scan-admission.ts`                                                                                           |
| Protocol selection    | `src/protocol-probe.ts`                                                                                                                                   |
| Shared session engine | `src/scan-session.ts`, `src/protocol.ts`, `src/graph-helpers.ts`                                                                                          |
| ESC/I-2 path          | `src/esci2/scanner.ts`, `src/esci2/graph.ts`, `src/esci2/commands.ts`, `src/esci2/transport.ts`                                                           |
| ESC/I-2 dialects      | `src/esci2/dialects/`, `src/esci2/data/`, `src/esci2/para-composer.ts`, `src/esci2/derivation.ts`, `src/esci2/capabilities.ts`, `src/esci2/resolution.ts` |
| Legacy ESC/I path     | `src/esci/scanner.ts`, `src/esci/graph.ts`, `src/esci/commands.ts`, `src/esci/luts.ts`, `src/esci/raw-to-jpeg.ts`, `src/esci/dialects/`                   |
| Shared FS commands    | `src/commands-fs.ts`                                                                                                                                      |
| Output pipeline       | `src/output.ts`, `src/output-tail.ts`, `src/exif.ts`, `src/pdf.ts`, `src/postprocess/`, `src/paperless-upload.ts`                                         |
| Health and logging    | `src/health.ts`, `src/logger.ts`                                                                                                                          |

Test files mirror the modules they cover.

---

## Testing

Treat protocol edits as replay-fixture-sensitive. The replay harnesses in `src/esci2/scanner.test.ts` and `src/esci/scanner.test.ts` are the main protocol regression protection: they check host writes byte-for-byte against the ESC/I-2-over-TLS Frida captures and the legacy ESC/I pcap fixtures, and check the PARA body byte-for-byte, alongside the completed output, on the ESC/I-2 plain-TCP fixtures (except the ET-7700's `#GMT` / `#CMX` segments, since its own-capture fixtures record an earlier colour pair). An edit that changes wire bytes must be mirrored in the fixtures. [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md#replay-tests) describes each harness.

For routine changes, run the focused Vitest file first, then the full gate before publishing:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

Use [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md) when changing scanner bytes or state transitions, and [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) when adding support for a new printer or creating capture fixtures.
