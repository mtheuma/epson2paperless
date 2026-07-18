# Reverse engineering

This document explains how the supported Epson scan protocols were decoded and how to produce new captures or replay fixtures. For the architecture overview, see [HOW-IT-WORKS.md](HOW-IT-WORKS.md). For the byte-level protocol reference, see [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md).

## Overview

The implementation grew in two distinct waves, each using the lightest reverse-engineering toolchain that could decode the printer family at hand.

The **first wave** (ET-4950) needed all three of Wireshark, Frida, and Ghidra because the scan session is wrapped in TLS. Frida hooked the Windows driver's pre-encryption send and post-decryption receive paths to dump the plaintext IS payload; Ghidra decompiled the same DLL to identify the hook offsets and decode the IS type-code map. Three steps, in order.

The **second wave** (ET-2750, XP-7100, ET-4800, and WF-3620) needed only Wireshark. They all speak plain TCP — the ESC/I-2 dialects (ET-2750 / XP-7100 / ET-4800) and the legacy ESC/I WF-3620 alike — so the wire bytes are directly readable from a single capture. `tools/pcap-extract/` converts those captures into JSONL replay fixtures. This is "Step 4" below: the same methodology with one fewer tool, applicable to any future plain-TCP Epson printer family.

### Step 1: Wireshark

Wireshark packet captures revealed the discovery and push-scan layers in full. Both operate in plaintext (UDP multicast and HTTP over TCP), so all fields are directly readable. The captures established:

- The multicast address, port, and beacon format (`02 06`/`02 07` packet structure).
- The sequence echo requirement in keepalives — and the consequence of getting it wrong (no entry in the destination list).
- The push-scan HTTP request format, including the non-standard header spacing and the `x-uid` counter.
- The `PushScanIDIn` encoding for Sides and Action.
- That the printer initiates the push-scan trigger (a plain-TCP connection from the printer to the host's event port 2968), but the _host_ initiates the scan-session connection on port 1865 (TLS for the ET-4950 family + ET-2950, plain TCP for the other ESC/I-2 dialects — ET-2750 / XP-7100 / ET-4800 — and for WF-3620). Knowing which side opens which port turned out to matter for both the firewall rules in `README.md` and the listener / connector roles in `pushscan.ts` vs the scanner shells.

Capturing UDP multicast and non-standard HTTP required binding a promiscuous-mode capture on the Ethernet interface rather than using a loopback filter. On Windows, `dumpcap` (bundled with Wireshark) works well from the command line — identify the target interface via `dumpcap -D` (using the interface GUID rather than a numerical index, since numerical indexes change when USB network adapters are connected or disconnected).

The TLS session on port 1865 is opaque to Wireshark without the session keys. The captures confirmed that a TLS handshake occurs and that the printer accepts TLS connections from the service, but they could not reveal the plaintext payload.

### Step 2: Frida on the Epson driver (Windows build)

The TLS payload was captured by hooking `CISProtocolStream::SendISPacket` and `CISProtocolStream::ReceiveISPacket` inside `ES2Command.dll` — the two functions, identified by Ghidra analysis (see Step 3), that construct outgoing IS packets and parse incoming IS packets respectively. Windows was chosen as the capture target because Ghidra decompilation of `ES2Command.dll` gave clean access to the hook offsets; the same observations should hold on the macOS or Linux builds modulo symbol differences. Because these functions operate on plaintext before TLS encryption (send path) and after TLS decryption (receive path), the hooks capture the full unencrypted IS payload including all ESC/I-2 command bytes.

The Frida setup has a Windows-specific complication: the target process (`es2projectrunner.exe`) is spawned on demand by `EEventManager.exe` when a scan is triggered, and Windows does not support `device.enable_spawn_gating` (the Frida API for intercepting child processes before they execute). The solution is to hook `EEventManager.exe` directly and instrument it to watch for child-process spawns, then attach to `es2projectrunner.exe` at spawn time via a custom hook in the parent. This is implemented in `tools/frida-capture/host.py` and `tools/frida-capture/agent.js`.

Each captured session is written to a JSONL file in `tools/frida-capture/captures/`. The wire records have shape `{"hook": "send"|"recv", "type_hex": "0xNNNN", "payload_hex": "<hex>", "payload_size": N, "ts": "<iso8601>"}`; lifecycle records (`hook: "startup"`, `hook: "waiting"`) appear at the head of each file with agent-specific metadata. The captures cover:

| File                                           | Scenario                          |
| ---------------------------------------------- | --------------------------------- |
| `2026-04-24T08-56-07-adf-1p-simplex.jsonl`     | 1-page ADF simplex JPG (baseline) |
| `2026-04-24T08-58-29-adf-1p-duplex.jsonl`      | 1-page ADF duplex JPG             |
| `2026-04-24T08-59-52-adf-3p-simplex.jsonl`     | 3-page ADF simplex JPG            |
| `2026-04-24T09-01-34-adf-3p-duplex.jsonl`      | 3-page ADF duplex JPG             |
| `2026-04-24T09-03-58-adf-1p-simplex-pdf.jsonl` | 1-page ADF simplex PDF            |
| `2026-04-24T09-05-08-flatbed-1p-jpg.jsonl`     | 1-page flatbed JPG                |
| `2026-04-24T09-06-37-flatbed-1p-pdf.jsonl`     | 1-page flatbed PDF                |

The PDF capture was particularly diagnostic. The printer streams JPEG image data regardless of the panel's format choice, so the protocol-level traffic is the same on JPG and PDF runs — confirmed by reusing the JPG capture file as the fixture for the PDF replay test (see `pdfFixtures` in `src/esci2/scanner.test.ts`). Capture-to-capture byte equality holds at the protocol-flow level; literal byte-equality between JPG and PDF capture _files_ depends on capture-time polling cadence and is not guaranteed.

### Step 3: Ghidra on ES2Command.dll

Ghidra static analysis of `ES2Command.dll` (32-bit x86) provided the semantic layer that the Frida captures alone could not: function names, the IS type-code map, the async-event dispatch table, the lock-packet payload format, and the dual command-stack architecture (legacy ESC/I and ESC/I-2 co-existing over the same IS framing). The key findings were:

- The complete IS type-code table (`0x8000` welcome, `0x9000` async event, `0xa000` passthru reply, `0xa100` lock ack, `0xa101` unlock ack, `0x2000` passthru request, `0x2100`/`0x2101` lock/unlock). These are not documented anywhere publicly; Ghidra's decompilation of `CISProtocolStream::CheckEvent` and its dispatcher made them explicit.
- The async-event dispatch byte table in `CISProtocolStream::DidReceiveAsyncEvent` — specifically that `0xa0` is `ServerError`, which the driver treats as an unrecoverable error requiring session teardown. Early implementation attempts received `IS 0x9000` + `0xa0` on every session and interpreted it as a "write acknowledge" needing a follow-up read, which was incorrect. Ghidra definitively resolved this: `0x9000`/`0xa0` means the printer has rejected the session and will close the connection; there is no recovery.
- The lock-packet payload format: 7 bytes, `01 a0 04 <timeout_BE_u32>`. This exact payload is in `buildLockPacket` in `src/protocol.ts`.
- The existence of two parallel command stacks: `CESCI2Command` for ESC/I-2 text commands and `CESCICommand` for legacy binary ESC/I — both multiplexed through `CISProtocolStream` over the same IS type `0x2000` envelope. This explained why the scanner needs to speak both command languages in a single session.
- Hook addresses used by the Frida agent (`FUN_100a5a40` for `SendISPacket`, `FUN_100a5bf0` for `ReceiveISPacket`), which were identified by following the call chain from the decompiled DLL entry point `ESCreateScanner` through the IS protocol layer.

Ghidra alone could not reveal the exact byte sequences the driver sends during a scan session, since that information is assembled at runtime from device state and query results. Ghidra established the structure and the semantics; Frida captured the runtime content. The combination of both tools was necessary for the TLS-tunnel family.

### Step 4: pcap-only decoding for plain-TCP variants

The plain-TCP ESC/I-2 dialects (ET-2750 / XP-7100 / ET-4800) and the legacy ESC/I WF-3620 family all speak plain TCP on port 1865 (no TLS layer), so a Wireshark capture of one scan session shows every byte the driver and printer exchanged. Frida and Ghidra are not needed.

The workflow:

1. Run a Windows VM (or another machine with the vendor driver installed) on the same LAN as the printer.
2. Start `dumpcap` (or Wireshark) on the LAN-side interface, filtering on `tcp port 1865 || udp port 2968`.
3. Trigger a scan from the printer panel and let it complete.
4. Save the resulting `.pcapng` (or `.pcap`).
5. Convert the capture into a JSONL replay fixture: `npm run pcap:extract -- <pcap> <hostIp> <printerIp> <port> <out.jsonl>` (add `--stream N` if the pcap contains multiple TCP conversations on port 1865 and you need to isolate one; list the available stream indices with `tshark -r <pcap> -Y "tcp.port==1865" -T fields -e tcp.stream -e ip.src -e ip.dst | sort -u`, or open the pcap in Wireshark and read the `tcp.stream` field on a packet). The fixture's shape is one JSON object per line: regular events look like `{"dir":"h>p"|"p>h","ts":<seconds>,"hex":"<hex>"}`, and runs of `IS-0xa200` image chunks (WF-3620 family and XP-620) are folded up into single summary records of the form `{"dir":"p>h","ts":<seconds>,"summary":"image-stream","chunkCount":N,"totalBytes":N,"chunkSize":N}` — `chunkCount` counts `0xa200` IS chunks, not TCP frames. The summary collapse is what keeps WF-3620/XP-620 fixtures in the 8–30 KB range; ET-2750 carries pixels inside `0xa000` ESC/I-2 frames so its fixture stays uncompressed (about 3.9 MB for one flatbed page).
6. Eyeball-validate the result. **For WF-3620-family and XP-620 captures:** `npm run pcap:render -- <pcap> <source> <format> <outputDir>` reconstructs the scanned page from the raw 24-bit GBR pixels carried in `IS-0xa200` chunks, where `source` is `flatbed`/`adf-simplex`/`adf-duplex` and `format` is `jpg`/`pdf`. It operates on the original `.pcap` (not the JSONL) and reads `HOST_IP`/`PRINTER_IP`/`SCAN_PORT` env vars (defaults baked in) for the same tshark filter `pcap:extract` uses. Add `--stream N` for dual-stream captures (same isolation as step 5), and `--width <px> --height <px>` to override the geometry lookup for fixed-geometry models like the XP-620. **For ESC/I-2 plain-TCP captures (ET-2750 / XP-7100 / ET-4800)**, `pcap:render` does not apply: their image data lives inside ESC/I-2 `0xa000` IMG replies as already-encoded JPEG bytes, not in the WF-3620's GBR-pixel `0xa200` stream. Validation goes through the replay test instead. Drop the new JSONL into the matching `tools/pcap-extract/captures/<model>/` directory (`et-2750/`, `xp-7100/`, or `et-4800/`) and wire it into that model's fixture block in `src/esci2/scanner.test.ts`, including the PARA byte-equivalence shield (`extractScannerParaWrite` vs `extractCapturedParaBody`). Remember these plain-TCP pcaps usually hold more than one `tcp.port==1865` conversation — an aborted SYN/RST (ET-2750) or a rejected TLS probe (XP-7100, ET-4800) ahead of the real plain-TCP session — so isolate the real stream with `--stream` (step 5). Each model's harness asserts its expected on-disk output — a composed PDF for the PDF fixtures, per-page JPEGs for the JPG fixtures — then cleans `outputDir` and the session temp dir in `afterEach`. To eyeball the rendered scan, either temporarily skip the `afterEach` cleanup and open the asserted PDF, or run a one-off replay outside the harness (call `runEsci2ScanOverPlain` directly against a non-temp output directory, with `action: "jpg"` if you want per-page JPEGs to inspect rather than a composed PDF).

Capture sources (gitignored) live under `.reference/wireshark-captures/{wf-3620,xp-620,et-2750,xp-7100,et-4800}/`. The extracted JSONL replay fixtures are committed to `tools/pcap-extract/captures/{wf-3620,xp-620,et-2750,xp-7100,et-4800}/` and drive the per-variant replay tests; see [The byte-for-byte replay test](#the-byte-for-byte-replay-test) below. Note that the pcap fixture shape (`{dir, ts, hex}` plus optional image-stream summaries) is **different** from the Frida fixture shape (`{hook, type_hex, payload_hex, payload_size, ts}`) used for the ET-4950 captures; `src/esci/test-support/replay.ts` and `src/esci2/test-support/replay.ts` consume the pcap shape, while `src/esci2/scanner.test.ts` consumes the Frida shape directly.

This is the methodology to reach for first when adding a new printer family. If TLS turns out to be in play (a `tcp.port == 1865` capture shows a TLS handshake, opaque ciphertext after, no readable IS frames), fall back to the Step 2 + 3 toolchain.

### The panel-error investigation

One significant debugging episode is worth understanding because its resolution shaped the push-scan implementation. After all other protocol layers were working correctly, the printer's panel displayed "Scanning Error" after every scan via the service, even though a valid output file was produced. The scan data transferred correctly end-to-end.

Investigation via paired Wireshark captures (one from the Epson driver, one from the service) identified the cause: the printer includes an `x-uid` counter in each push-scan POST request and expects to see that exact value echoed in the 200 OK response. The service had hardcoded `x-uid : 1` in its response. The printer resets its counter to `1` at power-on, so the first scan after a reboot succeeded (the counter happened to be `1`), but every subsequent scan failed as the counter advanced. The fix — parsing the `x-uid` from the incoming request and echoing it in the response — is in `buildPushScanResponse` in `src/pushscan.ts`.

### The byte-for-byte replay test

`src/esci2/scanner.test.ts` is the regression shield for the ESC/I-2 path. It runs in two modes:

- **TLS replay (byte-for-byte).** For the ET-4950 Frida captures, the test feeds the captured printer-side records to a `FakeTlsSocket` one-by-one and asserts that every byte the state machine writes matches the corresponding host-side record from the capture. Any edit that changes the outgoing byte sequence will fail. The covered scenarios include ADF simplex, ADF duplex, multi-page ADF, and flatbed scans in JPG/PDF output modes. The ADF entries reuse a single capture per scenario across `action='jpg'` and `action='pdf'`; the flatbed entries use separate captures for each format because the original Frida session captured them as distinct runs.
- **Plain-TCP replay (behavioural + PARA byte-equivalence).** For the `esci2-plain` dialects (ET-2750, XP-7100, ET-4800) driven through `runEsci2ScanOverPlain`, the helper in `src/esci2/test-support/replay.ts` feeds only the printer-side events from a pcap-extracted fixture to a `FakePlainSocket` and asserts the session's on-disk output and end-state. It does not assert full per-host-byte equality the way the TLS replay does, but each replay pins the one host write that encodes the dialect: a byte-equivalence shield asserts the PARA body the scanner composes equals the PARA bytes captured on the wire (`extractScannerParaWrite` vs `extractCapturedParaBody`), so a composer / registry / class-data regression fails the test. These fixtures are large (the ET-2750 one is ~3.9 MB) — a couple of orders of magnitude bigger than the WF-3620 fixtures (8–30 KB each) — because the ESC/I-2 IMG cycles wrap pixel data in `0xa000` frames; there's no `0xa200` image-stream summary path to fold the per-chunk records into a single summary line like the WF-3620 extractor uses.

JPG replay entries assert JPEG files on disk with the correct EXIF Orientation byte on back-side pages; PDF replay entries assert a single composed PDF with correct page count and `/Rotate = 180` on back pages.

`src/esci/scanner.test.ts` applies the same behavioural replay approach to the WF-3620 ESC/I path, using pcap-derived JSONL fixtures in `tools/pcap-extract/captures/wf-3620/` that cover single-page, duplex, multi-page, and flatbed cases in JPG/PDF output modes. It also feeds only printer-side events; host bytes are not asserted equal to the fixture.

The TLS replay's byte-for-byte guarantee is the strongest regression shield in the suite: that state machine is, by construction, correct if and only if it produces the exact byte sequence that the Windows driver produced on the same printer. The pcap-based replays don't assert full per-host-byte equality, but the PARA byte-equivalence shield pins the one host write that encodes the dialect, so a composer regression can't slip through; they cover the variants for which Frida captures aren't available.

---

## Ongoing validation

The replay harnesses are the regression shield for protocol work:

- `src/esci2/scanner.test.ts` replays ESC/I-2 sessions. TLS captures from the ET-4950 family assert byte-for-byte host output against Frida records. Plain-TCP fixtures (ET-2750, XP-7100, ET-4800) assert completed output and session behavior from pcap-derived records, plus PARA byte-equivalence against the captured wire.
- `src/esci/scanner.test.ts` replays the WF-3620 ESC/I path from pcap-derived fixtures and asserts completed output and session behavior.

Run the focused replay test when changing a protocol path, then run the full project gate before publishing:

```sh
npm run lint
npm run format:check
npm test
```

## References

- **node-hp-scan-to** — a comparable project for HP printers that reverse-engineered HP's equivalent "Scan to Computer" protocol.
- **Frida** (`frida.re`) — dynamic instrumentation toolkit used to hook `ES2Command.dll` and extract plaintext TLS payloads at runtime.
- **Ghidra** (`ghidra.re`) — static analysis suite used for `ES2Command.dll` function names, type-code maps, and hook addresses.
- **Wireshark / tshark** — packet capture and decode tooling used for discovery, push-scan, and plain-TCP scan sessions.
