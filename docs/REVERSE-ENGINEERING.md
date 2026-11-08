# Reverse engineering

How the supported Epson scan protocols were decoded, and how to produce new captures and replay fixtures. [HOW-IT-WORKS.md](HOW-IT-WORKS.md) has the architecture overview and [PROTOCOL-REFERENCE.md](PROTOCOL-REFERENCE.md) the byte-level reference.

## Toolchain

Each printer family was decoded with the lightest toolchain that could read it. The ET-4950 family wraps its scan session in TLS, so it needed Wireshark, Frida and Ghidra (steps 1–3): Frida hooked the Windows driver's pre-encryption send and post-decryption receive paths to dump the plaintext IS payload, and Ghidra decompiled the same DLL to find the hook offsets and decode the IS type codes. A printer whose scan session runs over plain TCP, ESC/I-2 and legacy ESC/I alike, needs only Wireshark, because a single capture shows every byte (step 4). That is the method to reach for first with a new printer.

### Step 1: Wireshark

Wireshark captures revealed the discovery and panel-trigger layers in full, since both are plaintext (UDP multicast, and HTTP over TCP). They established:

- the multicast address, port and announcement format (`02 06` / `02 07`);
- the sequence echo in keepalives, and that getting it wrong keeps the destination off the list ([The sequence-echo investigation](#the-sequence-echo-investigation));
- the panel-trigger HTTP format, including the non-standard header spacing and the `x-uid` counter;
- the `PushScanIDIn` encoding of Sides and Action;
- which side opens which port. The printer opens the panel trigger to the host's event port 2968, but the host opens the scan session to the printer's port 1865 (TLS on the `esci2` models such as the ET-4950 family, plain TCP on the others). That decides the firewall rules in `README.md` and the listener and connector roles of `pushscan.ts` and the scanner shells.

Capturing UDP multicast and the non-standard HTTP needs a promiscuous-mode capture on the Ethernet interface rather than a loopback filter. On Windows, `dumpcap` (bundled with Wireshark) works well from the command line. Pick the interface from `dumpcap -D` by its GUID rather than its number, since the numbers change when USB network adapters are connected or disconnected.

Without the session keys, the TLS session on port 1865 is opaque. The captures confirmed that a TLS handshake happens and that the printer accepts TLS connections from the service, but not what they carry.

### Step 2: Frida on the Epson driver (Windows build)

The TLS payload was captured by hooking `CISProtocolStream::SendISPacket` and `CISProtocolStream::ReceiveISPacket` in `ES2Command.dll`, the two functions that build outgoing IS packets and parse incoming ones (found with Ghidra, step 3). They work on plaintext, before encryption on the send path and after decryption on the receive path, so the hooks see the full IS payload, every ESC/I-2 command byte included. Windows was the target because Ghidra gave clean access to the hook offsets there; the macOS and Linux builds should behave the same, modulo symbol differences.

On Windows the target process, `es2projectrunner.exe`, is spawned on demand by `EEventManager.exe` when a scan starts, and Frida's `device.enable_spawn_gating` (which intercepts child processes before they run) isn't supported. `tools/frida-capture/host.py` and `tools/frida-capture/agent.js` work around this by instrumenting `EEventManager.exe` to watch for child spawns and attaching to `es2projectrunner.exe` as it is spawned.

Each session is written to a JSONL file in `tools/frida-capture/captures/`. Wire records have the shape `{"hook": "send"|"recv", "type_hex": "0xNNNN", "payload_hex": "<hex>", "payload_size": N, "ts": "<iso8601>"}`, and lifecycle records (`hook: "startup"`, `hook: "waiting"`) at the head of each file carry agent metadata. The captures cover:

| File                                           | Scenario                          |
| ---------------------------------------------- | --------------------------------- |
| `2026-04-24T08-56-07-adf-1p-simplex.jsonl`     | 1-page ADF simplex JPG (baseline) |
| `2026-04-24T08-58-29-adf-1p-duplex.jsonl`      | 1-page ADF duplex JPG             |
| `2026-04-24T08-59-52-adf-3p-simplex.jsonl`     | 3-page ADF simplex JPG            |
| `2026-04-24T09-01-34-adf-3p-duplex.jsonl`      | 3-page ADF duplex JPG             |
| `2026-04-24T09-03-58-adf-1p-simplex-pdf.jsonl` | 1-page ADF simplex PDF            |
| `2026-04-24T09-05-08-flatbed-1p-jpg.jsonl`     | 1-page flatbed JPG                |
| `2026-04-24T09-06-37-flatbed-1p-pdf.jsonl`     | 1-page flatbed PDF                |

The PDF capture was particularly diagnostic. The printer streams JPEG whatever the panel's Action, so JPG and PDF runs exchange the same protocol flow, and the PDF replay test reuses the JPG capture (`pdfFixtures` in `src/esci2/scanner.test.ts`). Byte equality between the capture files themselves isn't guaranteed, because the polling cadence varies from one capture to the next.

### Step 3: Ghidra on ES2Command.dll

Static analysis of the 32-bit x86 `ES2Command.dll` supplied what the Frida captures alone could not: function names, the IS type-code map, the async-event dispatch table, the lock-packet format, and the two command stacks (legacy ESC/I and ESC/I-2) sharing the same IS framing. The key findings:

- **The IS type codes** (`0x8000` welcome, `0x9000` async event, `0xa000` passthru reply, `0xa100` / `0xa101` lock and unlock acks, `0x2000` passthru request, `0x2100` / `0x2101` lock and unlock), which are documented nowhere publicly. The decompiled `CISProtocolStream::CheckEvent` and its dispatcher made them explicit.
- **The async-event table** in `CISProtocolStream::DidReceiveAsyncEvent`, in particular that `0xa0` is `ServerError`, an unrecoverable error that ends the session. Early attempts received `IS 0x9000` + `0xa0` on every session and read it as a "write acknowledge" needing a follow-up read. Ghidra settled it: the printer has rejected the session and will close the connection, and there is no recovery.
- **The lock packet:** 7 bytes, `01 a0 04 <timeout_BE_u32>`, exactly as `buildLockPacket` in `src/protocol.ts` builds it.
- **Two parallel command stacks:** `CESCI2Command` for ESC/I-2 text commands and `CESCICommand` for legacy binary ESC/I, both multiplexed through `CISProtocolStream` in the same IS `0x2000` envelope. That explained why a session has to speak both command languages.
- **The hook addresses** for the Frida agent (`FUN_100a5a40` for `SendISPacket`, `FUN_100a5bf0` for `ReceiveISPacket`), found by following the call chain from the DLL entry point `ESCreateScanner` through the IS protocol layer.

Ghidra alone could not show the exact bytes of a session, which the driver assembles at run time from device state and query replies. Ghidra established the structure and the semantics, Frida captured the runtime content, and the TLS family needed both.

### Step 4: pcap-only decoding for plain-TCP variants

A plain-TCP printer, ESC/I-2 or legacy ESC/I, exposes its whole scan session on port 1865 to one Wireshark capture, so Frida and Ghidra aren't needed. If a `tcp.port == 1865` capture instead shows a TLS handshake, then ciphertext and no readable IS frames, fall back to steps 2 and 3.

#### Capture

1. Run a Windows VM, or another machine with the vendor driver installed, on the printer's LAN.
2. Start `dumpcap` (or Wireshark) on the LAN-side interface, filtering on `tcp port 1865 || udp port 2968`.
3. Trigger a scan from the printer panel and let it complete.
4. Save the resulting `.pcapng` (or `.pcap`). Capture sources stay outside the repo.

#### Extract a fixture

```sh
npm run pcap:extract -- <pcap> <hostIp> <printerIp> <port> <out.jsonl>
```

Add `--stream N` when the pcap holds more than one TCP conversation on port 1865. Most plain-TCP ESC/I-2 captures do: the vendor software opens a throwaway connection before the real session (an aborted SYN/RST on the ET-2750, a rejected TLS probe on the XP-7100, ET-4800, FF-680W and DS-575W), and `pcap:extract` refuses a capture holding more than one conversation that carries payload, naming the streams to choose from. It reads only segments that carry payload, so a conversation with none, such as an aborted SYN/RST, is simply ignored ([tools/pcap-extract/README.md](../tools/pcap-extract/README.md)). The ET-7700 captures are single-stream. List the stream indices with

```sh
tshark -r <pcap> -Y "tcp.port==1865" -T fields -e tcp.stream -e ip.src -e ip.dst -e ipv6.src -e ipv6.dst | sort -u
```

or read the `tcp.stream` field of a packet in Wireshark. Pass the endpoints in the address family the session actually used: a Bonjour-discovered scanner can pick IPv6 with no user control over the choice (the ET-2550, issue #166), and then the `ip.*` columns above come back blank and `<hostIp>` / `<printerIp>` take the IPv6 literals.

Commit the result under `tools/pcap-extract/captures/<model>/`, where it drives that model's replay test ([Replay tests](#replay-tests)).

#### Fixture format

One JSON object per line. Ordinary events are `{"dir":"h>p"|"p>h","ts":<seconds>,"hex":"<hex>"}`. In legacy ESC/I fixtures, runs of IS-`0xa200` image chunks fold into one summary record, `{"dir":"p>h","ts":<seconds>,"summary":"image-stream","chunkCount":N,"totalBytes":N,"chunkSize":N}`, where `chunkCount` counts `0xa200` chunks, not TCP frames. The summaries keep legacy ESC/I fixtures under 30 KB. ESC/I-2 carries its pixels inside `0xa000` IMG replies, which have no summary form, so its fixtures stay full size: about 3.9 MB for one ET-2750 flatbed page.

The pcap shape differs from the Frida one (`{hook, type_hex, payload_hex, payload_size, ts}`). `src/esci/test-support/replay.ts` and `src/esci2/test-support/replay.ts` read the pcap shape; `src/esci2/test-support/frida-replay.ts` reads the Frida shape.

#### Validate a legacy ESC/I fixture

`npm run pcap:render -- <pcap> <source> <format> <outputDir>` rebuilds the scanned page from the raw 24-bit GBR pixels in the `0xa200` chunks, where `source` is `flatbed`, `adf-simplex` or `adf-duplex` and `format` is `jpg` or `pdf`. It reads the original pcap rather than the JSONL, and takes `HOST_IP` / `PRINTER_IP` / `SCAN_PORT` from the environment (with defaults built in) for the same tshark filter `pcap:extract` uses. Add `--stream N` for a dual-stream capture, and `--width <px> --height <px>` to override the geometry lookup for a fixed-geometry model like the XP-620.

#### Validate an ESC/I-2 plain-TCP fixture

`pcap:render` doesn't apply here: the image data is already-encoded JPEG inside the `0xa000` IMG replies, not a GBR pixel stream. Validate through the replay test instead. Wire the new JSONL into the model's fixture block in `src/esci2/scanner.test.ts`, including the PARA byte-equivalence check (`extractScannerParaWrite` against `extractCapturedParaBody`). Each model's harness asserts its expected on-disk output (a composed PDF for PDF fixtures, per-page JPEGs for JPG fixtures) and then cleans `outputDir` and the session temp directory in `afterEach`. To look at the rendered scan, temporarily skip that cleanup and open the asserted PDF, or call `runEsci2ScanOverPlain` directly against a non-temp output directory, with `action: "jpg"` for per-page JPEGs rather than a composed PDF.

## Investigations

### The sequence-echo investigation

The keepalive's byte 11 looks like a static "number of key-value pairs" field. An early implementation hardcoded `0x03` there, and the printer silently ignored it: the service never appeared in the destination list. Capturing several consecutive announcement cycles showed byte 11 changing while the number of key-value pairs in the keepalive stayed the same, which identified it as an echo of the announcement's sequence counter. Echoing it fixed discovery.

### The panel-error investigation

After every other protocol layer worked, the panel showed "Scanning Error" after every scan through the service, even though the scan data transferred end-to-end and a valid output file was written.

Paired Wireshark captures, one of the Epson driver and one of the service, found the cause. The printer sends an `x-uid` counter in each panel-trigger POST and expects that exact value echoed in the 200 OK, but the service had hardcoded `x-uid : 1`. The printer resets the counter to `1` at power-on, so the first scan after a reboot succeeded and every later one failed as the counter advanced. `buildPushScanResponse` in `src/pushscan.ts` now parses the request's `x-uid` and echoes it.

### Why the gamma table is pinned per dialect rather than queried

Each ESC/I-2 model override carries a `gammaClass`, the 804-byte RGB tone-curve triplet (`#GMTRED` / `#GMTGRN` / `#GMTBLU`) that `composePara` puts in the PARA body. Those bytes are transcribed from a capture of that model, which raises an obvious question when adding a printer nobody has captured: can the printer just be asked what curve it wants?

No observed or documented query returns one. The ESC/I-2 request vocabulary has nothing that reports recommended or default scan parameters. `RESA`, the one command whose name suggests it ("read parameter confirmation"), returns maintenance counters (page counts, jam counts, buffer size) in the mode the drivers actually use it in, and `esci2Graph` already sends it during INIT2 and discards the body. Gamma is host→printer data in every observed exchange; CAPA advertises only the mode-name list (`#GMM`, e.g. `UG10UG18`), never a curve.

One gap is worth recording so nobody re-derives it: `RESA` in inquiry/control mode, issued _before_ any `PARA`, has never been tried on any model. The vendor drivers never do it, so no capture shows what comes back, and in principle a printer's power-on defaults could populate the reply. The rest of this section holds either way, because the curve not being model-specific is established independently, but that probe remains untested.

That is less of a limitation than it sounds, because the curve is not a per-model constant. Measured against a strict identity ramp, four of the six committed gamma classes are identity to within ±1 (that ±1 is rounding noise, which the replay tests pin and which must not be "fixed"). The two exceptions are a contrast stretch that clips shadows and saturates highlights, and one of them is the XP-7100, which also has an identity class from a different capture of the same printer. A value that takes two forms on one model isn't a property of the model.

So a new dialect with no capture of its own should inherit the near-identity `et4950-stock` class. That is the pass-through choice: it asks the printer for no tone shaping and leaves its default rendering alone, rather than approximating some unknown model-specific value.

The ET-8500 and ET-7700 both took that inheritance when they were added from a diagnostic alone, and both were later validated on real hardware. The ET-7700's compatibility-page scan puts numbers on it: nominal-64 grey returned 72/69/69 with no shadow crush, grey-patch channel spreads of 3–11, and no cast. That is what a correctly inherited pass-through curve looks like, and it answers the question this section opens with. (That scan measured the ET-7700's earlier pair. It now sends the near-identity `xp7100-pdf` curve with the identity colour matrix, a pass-through pair inherited from the XP-7100 and ET-2750 captures, expected to match but not yet confirmed by a scan.)

## Replay tests

The replay harnesses are the regression shield for protocol work. Each feeds a fixture's printer-side records to a fake socket and checks what the service does in reply:

| Harness                                | Fixtures                                                                                  | Asserts                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/esci2/scanner.test.ts`, TLS       | ET-4950 Frida captures                                                                    | Every host write, byte for byte, against the capture's host records (`FakeTlsSocket`) |
| `src/esci2/scanner.test.ts`, plain TCP | ET-2750, XP-7100, ET-4800, ET-7700, FF-680W, DS-575W pcaps                                | On-disk output and end state, plus the PARA body byte for byte (`FakePlainSocket`)    |
| `src/esci/scanner.test.ts`             | WF-3620 (single-page, duplex, multi-page and flatbed, JPG and PDF), XP-620, ET-2550 pcaps | The full host transcript byte for byte, plus on-disk output and the detected source   |

On the TLS path, any edit that changes the outgoing byte sequence fails a test. Its scenarios cover ADF simplex, ADF duplex, multi-page ADF and flatbed scans in both JPG and PDF output. The ADF entries reuse one capture per scenario for `action='jpg'` and `action='pdf'`; the flatbed entries use a separate capture per format, because the Frida session captured them as distinct runs. This byte-for-byte check, shared with the legacy ESC/I harness, is the strongest shield in the suite: the state machine is correct, by construction, if and only if it produces the bytes the Windows driver produced on the same printer. (The Frida fixtures' init poll is first trimmed to three STAT cycles, the session's own poll count.)

The ESC/I-2 plain-TCP harness, in `src/esci2/test-support/replay.ts`, drives `runEsci2ScanOverPlain` from the printer-side events alone and doesn't compare every host write. It does pin the one host write that encodes the dialect: the PARA body the scanner composes must equal the PARA bytes on the wire (`extractScannerParaWrite` against `extractCapturedParaBody`), so a composer, override or class-data regression fails the test. The ET-7700's fixtures are own captures that record an earlier colour pair, so its PARA is held to them everywhere except the `#GMT` / `#CMX` segments.

JPG entries assert JPEG files on disk with the right EXIF Orientation byte on back pages, and PDF entries assert one composed PDF with the right page count and `/Rotate = 180` on back pages.

Run the focused replay test when changing a protocol path, then the full gate ([HOW-IT-WORKS.md](HOW-IT-WORKS.md#testing)) before publishing.

## References

- [node-hp-scan-to](https://github.com/manuc66/node-hp-scan-to): a comparable project that reverse-engineered HP's equivalent "Scan to Computer" protocol.
- [Frida](https://frida.re): the dynamic instrumentation toolkit used to hook `ES2Command.dll` and extract plaintext TLS payloads at run time.
- [Ghidra](https://ghidra-sre.org): the static analysis suite used for `ES2Command.dll`'s function names, type-code maps and hook addresses.
- [Wireshark / tshark](https://www.wireshark.org): the packet capture and decode tooling used for discovery, the panel trigger and plain-TCP scan sessions.
