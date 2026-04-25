# How it works

Epson's "Scan to Computer" feature for the ET-4950 is a proprietary, closed-source protocol implemented by a vendor driver stack. The vendor software is available for Windows, macOS, and Linux; the reverse-engineering work for this project was done against the Windows build, where the driver chain is `EEventManager.exe` / `es2projectrunner.exe` / `ES2Command.dll`. On the wire, the printer speaks a layered protocol: a UDP multicast beacon for destination registration, a SOAP-ish HTTP push notification to announce a scan trigger, and a TLS session on port 1865 that carries the actual image data via a command framing system called "IS" with an embedded command language called ESC/I-2.

This project reverse-engineers that stack and re-implements it as a Node.js/TypeScript service. Instead of requiring a desktop machine running Epson's driver GUI, the service runs headless on Linux or in Docker and presents itself to the printer as a named scan destination called "Paperless." When the user presses Scan on the panel, the service captures the image and writes a JPEG or composed PDF to disk. The primary motivation is headless ingestion into a Paperless-ngx document management system, but the service's scope ends at file output.

The implementation is derived from three complementary sources: Wireshark packet captures of the discovery and push-scan phases, Frida dynamic instrumentation of `ES2Command.dll` to extract the plaintext TLS payload byte-for-byte, and Ghidra static analysis of the same DLL to understand the IS type-code map, the async-event dispatch table, and the lock/unlock framing. This document explains the protocol, the code structure, and the reverse-engineering methodology so that someone working on a related device could follow the same approach.

---

## The wire protocol

The ET-4950 uses three distinct network channels in sequence:

```
Printer (broadcast)  →  Service (multicast listener)     Discovery / keepalive
Printer (unicast)    →  Service (TCP port 2968)          Push-scan trigger
Service              →  Printer (TLS port 1865)          Scan session
```

Each channel is independent enough to be developed and tested separately.

### Discovery and keepalive (UDP multicast)

The printer periodically broadcasts a 12-byte `02 06` announcement packet to the multicast address `239.255.255.253:2968` — roughly once every 60 seconds, and also immediately after the printer wakes from sleep. Byte 11 of the announcement is a sequence counter that increments with each broadcast cycle.

A client registers itself as a scan destination by:

1. Joining the multicast group `239.255.255.253` via `IP_ADD_MEMBERSHIP` on a UDP socket bound to port 2968.
2. Listening for `02 06` announcement packets.
3. Sending a burst of three unicast `02 07` keepalive packets back to the printer's IP on port 2968, spaced 500 ms apart. Each packet must echo the announcement's sequence number in byte 11. The packet also carries the destination's display name, IP address, TCP event port, and a destination ID.

The printer only accepts keepalives during the ~60-second window after broadcasting an announcement. Outside that window it responds with ICMP Port Unreachable. A client that sends unsolicited keepalives — or keepalives with the wrong sequence number — is silently ignored and will not appear in the printer's destination list.

Implemented in `src/keepalive.ts`. `parsePrinterAnnouncement` extracts the sequence byte from incoming `02 06` packets; `buildKeepalivePacket` assembles the `02 07` response; `createKeepaliveResponder` manages the socket lifecycle, multicast membership, and the per-announcement burst with deduplication (the printer broadcasts each beacon three times per cycle with the same sequence number, so the responder suppresses duplicate-sequence firings within a 30-second window to avoid sending nine keepalives per cycle instead of three).

The discovery protocol was fully decoded from Wireshark captures. The critical insight was that byte 11 is a _sequence echo_, not a static "number of key-value pairs" field as the packet structure might suggest — this was confirmed by observing multiple consecutive beacon cycles with different sequence values but the same number of key-value pairs in the keepalive payload. An earlier implementation that hardcoded a fixed byte-11 value of `0x03` was silently ignored by the printer; the service never appeared in its destination list until the sequence-echo behavior was identified and fixed.

### Push-scan trigger (TCP, SOAP-ish)

When the user selects a destination and presses Scan on the panel, the printer opens a TCP connection to the destination's registered event port (2968) and sends an HTTP POST carrying a SOAP body. The critical wrinkle is that Epson uses non-standard HTTP header formatting — headers contain a space before the colon (`Header : value`), which is invalid HTTP/1.1 and will cause a standard HTTP server to reject the request. The service uses a raw `net.createServer` (not `node:http`) and parses the request manually.

The SOAP body's `<PushScanIDIn>` element is the only channel through which the panel's user selections reach the service. It encodes two fields in a compact binary-style string:

- **Byte 0** (Sides): `0` = 1-Sided, `1` = 2-Sided.
- **Byte 1** (Action bitmask): `1` = JPG, `2` = PDF, `4` = Preview on Computer.

The service must reply with an HTTP 200 OK. The response must echo the request's `x-uid` header value verbatim. The printer increments this counter on each scan and uses it to verify the response came from the correct session. A mismatched `x-uid` causes the printer to display "Scanning Error" on the panel after the scan completes — even though the scan data transfers correctly and the output file is produced. This is a panel-state signal, not a data-integrity issue; the root cause and fix are documented in the panel-error investigation (see Reverse Engineering below).

After the push-scan response is sent, the service parses the `PushScanIDIn` value and opens a TLS session to the printer on port 1865. The push-scan TCP connection is then closed with a FIN (not RST — using RST causes the printer to tear down its end aggressively).

Implemented in `src/pushscan.ts`. `parsePushScanRequest` extracts the SOAP fields; `buildPushScanResponse` constructs the echoed response; `resolveEffectiveAction` maps the raw action bitmask to one of `jpg`, `pdf`, or `preview`, applying the `PREVIEW_ACTION` env-var gate (default: reject preview silently; `jpg`/`pdf` redirect it to a real scan).

### The scan session (TLS + ESC/I-2 over "IS" framing)

The actual image transfer happens over a TLS 1.2 session that the service initiates outbound to the printer on port 1865. TLS chain validation is disabled — the printer presents a self-signed certificate and there is no trust chain to validate against. As an opt-in alternative, setting `PRINTER_CERT_FINGERPRINT` pins the peer's SHA-256 fingerprint and aborts the scan at handshake time on mismatch (see `README.md`).

Inside the TLS tunnel, all traffic is wrapped in Epson's proprietary **IS framing**. Every message — in both directions — is an IS packet:

```
Offset  Len  Field
──────  ───  ─────
  0      2   ASCII magic "IS"
  2      2   Packet type (big-endian uint16)
  4      2   Data offset, always 0x000C (12)
  6      4   Payload size (big-endian uint32)
 10      2   Padding (zeros)
 12      N   Payload
```

The packet type field determines the semantics of the payload:

| Type   | Direction      | Meaning                                                 |
| ------ | -------------- | ------------------------------------------------------- |
| 0x8000 | Printer → host | Welcome — first packet after TLS handshake              |
| 0x9000 | Printer → host | Async event (scan start, cancel, timeout, error)        |
| 0xa000 | Printer → host | Passthru data reply (response to a command)             |
| 0xa100 | Printer → host | Lock / unlock acknowledgement                           |
| 0x2000 | Host → printer | Passthru command (sends a command, declares reply size) |
| 0x2100 | Host → printer | Lock request                                            |
| 0x2101 | Host → printer | Unlock request                                          |

`0x9000` async events carry a single dispatch byte in the payload: `0x01` = ScanStart, `0x02` = Disconnect, `0x03` = ScanCancel, `0x04` = Stop, `0x80` = Timeout, `0xa0` = ServerError. A `0x9000`/`0xa0` (ServerError) means the printer rejected the last command and has torn down the session — there is no recovery path. This type-code map was established by Ghidra decompilation of `CISProtocolStream::DidReceiveAsyncEvent` in `ES2Command.dll`.

IS parsing and construction are in `src/protocol.ts`. `parseIsPacket` reads exactly one IS packet from a `Buffer` (returning `null` if the buffer is too short for the declared payload — the scanner buffers incoming data and re-attempts parsing after each new TCP segment). `buildPassthruPacket` and `buildPurereadPacket` construct the two flavors of `0x2000` passthru; `buildLockPacket` and `buildUnlockPacket` construct the `0x2100` / `0x2101` control packets.

The distinction between `buildPassthruPacket` and `buildPurereadPacket` is important: `buildPassthruPacket` sends both the 8-byte data header and a non-zero `cmd_size` field along with command bytes. `buildPurereadPacket` sets `cmd_size=0` and only a non-zero `reply_size` — this is the "please send me the next N bytes from your output queue without me sending a command" form, used in the IMG data-fetch half of each IMG loop iteration.

#### Passthru and ESC/I-2

The passthru `0x2000` packet type carries two sub-layers. The IS payload begins with an **8-byte data header**:

```
Offset  Len  Field
──────  ───  ─────
  0      4   Command size (big-endian uint32) — bytes that follow
  4      4   Expected reply size (big-endian uint32)
  8      N   Command bytes
```

The command bytes are either:

- **Legacy ESC/I** — 2-byte binary commands: `FS Y` (`0x1C 0x59`), `FS X` (`0x1C 0x58`), `FS Z` (`0x1C 0x5A`). These predate ESC/I-2 and handle session initialization.
- **ESC/I-2** — 12-byte ASCII headers of the form `NAMEx0000000`, where `NAME` is a 4-character command name (right-padded with spaces if needed) and `0000000` is a 7-hex-digit parameter block length. Commands include `STAT`, `FIN `, `TRDT`, `IMG `, and `PARA`.
- **Raw parameter bytes** — the `PARA` command's second phase sends the raw scan parameter blob (928–940 bytes depending on source and mode) as a separate passthru with no ESC/I-2 header wrapper.

**PARA is sent in two passthru packets**, not one. The first packet carries the 12-byte `PARAx<hex-len>` header with `reply_size=0`. The second carries the raw parameter bytes with `reply_size=64`. The printer responds only to the second packet, with a 64-byte `PARAx0000000#parOK…` reply if the parameters were accepted or `#parFAIL` if not. This two-phase structure was discovered from the Frida capture: the Windows driver never batches the two sends into a single passthru.

ESC/I-2 command builders are in `src/esci.ts`. `buildFsY`, `buildFsX`, `buildFsZ` produce the legacy 2-byte commands. `buildEsci2Command` builds the generic 12-byte ESC/I-2 header. `buildParaHeader` and `buildParaPayload` build the two PARA phases. Reply parsing is done by `parseEsci2ReplyHeader` (extracts the 12-byte reply header's `cmd` and `length` fields) and `parseTokens` (splits the `#KEY value` token stream from reply bodies).

The SANE `epsonds` backend provides a useful cross-reference: its passthru framing — IS header layout, `0x000C` data offset, 8-byte data header with `cmd_size` / `reply_size` — is byte-identical to what the ET-4950 expects. However, `epsonds` targets older scanners that do not require the legacy ESC/I initialization loop before ESC/I-2 commands. The ET-4950's firmware requires `FS Y → STAT → FIN` polling repeated until the printer reports ready, followed by a `FS X` mode switch, before any ESC/I-2 command will be accepted.

#### Capability discovery cycles

After the mode switch, the driver performs two capability discovery cycles, each consisting of an `INFO` query followed by a `CAPA` query. (The `@` prefix in the Frida capture naming convention is not a wire prefix — the actual command bytes on the wire are `INFOx0000000` and `CAPAx0000000` in the ESC/I-2 format.) A final `RESA` (resolution announce) command is sent before `PARA`. These cycles appear in the Frida captures with consistent counts across all scan scenarios (2 × INFO, 2 × CAPA, 1 × RESA), which suggests they are mandatory initialization steps rather than optional feature queries.

The INFO and CAPA replies declare the scanner's capabilities — supported resolutions, color modes, document sources, and similar parameters. In a host-initiated (pull-scan) flow — how the vendor driver's own UI works — these values would populate a scan dialog. In the push-scan flow implemented here, the replies are consumed and discarded; the PARA payload is hardcoded from the Frida capture rather than being dynamically constructed from capability discovery. This is a deliberate simplification: the ET-4950's capabilities are fixed for the scanning parameters used (300 dpi, color, JPEG), and adding runtime capability negotiation would require additional Frida captures and reverse-engineering work without changing the end result.

---

## The scanner state machine

`startScanSession` in `src/scanner.ts` implements a deterministic state machine. Each incoming IS packet advances the state by exactly one transition; all state is kept in local variables within a single TLS socket callback.

```
CONNECTING
    │  TLS handshake
    ▼
WELCOME          ← receive IS 0x8000 welcome
    │  send Lock (IS 0x2100)
    ▼
LOCKING          ← receive IS 0xa100 lock ack (expect 0x06)
    │
    ▼
INIT1_FS_Y       ← send FS Y (legacy 2-byte), await 1-byte ACK
INIT1_FIN        ← send FIN, await 64-byte reply
    │
INIT2_FS_Z       ← send FS Z (legacy 2-byte), await 1-byte ACK
INIT2_FIN        ← send FIN, await 64-byte reply
    │
INIT_POLL × 3:
  INIT_POLL_FS_Y    ← send FS Y, await ACK
  INIT_POLL_STAT    ← send STAT, await 64-byte envelope
  INIT_POLL_STAT_DRAIN  ← drain N bytes if STAT reply declares length > 0 (flatbed only)
  INIT_POLL_FIN     ← send FIN, await 64-byte reply
    │
MODE_SWITCH      ← send FS X (mode switch to ESC/I-2), await 1-byte ACK
    │
POST_MODE_STAT   ← send STAT, await 64-byte reply
POST_MODE_STAT_DRAIN  ← drain N bytes if declared (flatbed only)
    │
PARA             ← send PARA phase-1 header + phase-2 payload, await #parOK
TRDT             ← send TRDT (transition to data transfer), await reply
    │
IMG loop:
  IMG_META         ← send IMG, await 64-byte metadata reply (contains chunk length)
  IMG_DATA         ← send pure-read(chunk_length), receive image bytes
  (repeat until terminal #pen)
    │
FIN_AFTER_IMG    ← send FIN, await reply
    │
  ┌─ source=ADF ──────────────────────────────────────────────────────┐
  │  POSTSCAN × 2:                                                    │
  │    POSTSCAN_FS_Y  ← send FS Y, await ACK                         │
  │    POSTSCAN_STAT  ← send STAT, await reply                       │
  │    POSTSCAN_DRAIN ← pure-read(12) to drain #ERRADF PE status     │
  │    POSTSCAN_FIN   ← send FIN, await reply                        │
  └───────────────────────────────────────────────────────────────────┘
  (flatbed skips POSTSCAN entirely)
    │
UNLOCKING        ← send Unlock (IS 0x2101), await IS 0xa100 ack
    │
DONE             ← compose/promote output files, then resolve
```

**INIT_POLL iterations.** The init poll runs three times. The Windows driver ran it up to 14 times in one capture because the printer was still waking up; three iterations is sufficient for a printer that is already active. The loop is driven by a counter, not a ready-state signal from the printer — the status values returned by STAT during INIT_POLL are not examined for readiness; they are simply consumed.

**Async events.** At any point during the session, the printer can send an IS `0x9000` async event packet. The scanner handles these as follows: `0x01` (ScanStart) and `0x04` (Stop) are logged and ignored. `0x03` (ScanCancel) transitions to the ERROR state. `0x02` (Disconnect), `0x80` (Timeout), and `0xa0` (ServerError) are fatal — they transition to ERROR and abort the scan. In practice, a `0x9000`/`0xa0` ServerError always means the printer rejected a command (typically a malformed PARA or an unexpected command sequence), and the TLS connection closes within milliseconds of the event.

**IMG loop mechanics.** Each `IMG` command returns a 64-byte metadata envelope whose `IMGx<hex-length>` prefix declares the byte count of the following image data chunk. The scanner issues a pure-read (passthru with `cmd_size=0`, `reply_size=chunk_length`) to pull those bytes, which accumulate into the in-memory JPEG buffer for the current page. Zero-length replies (`IMG x0000000`) indicate the printer is not ready yet — the scanner retries up to 2,000 times before treating it as a timeout. When the IMG metadata reply contains a `#pen` token in its token stream, the current page-side has ended and the accumulated JPEG buffer is flushed to a `page_NN.jpg` file in the session temp directory.

The IMG loop's termination condition differs by source:

- **ADF**: `#pen` is terminal only if the same reply also contains `#lftd000` ("zero pages left"). A `#pen` without `#lftd000` signals a page boundary — the scanner flushes the current page to the temp directory and continues issuing `IMG` commands for the next page.
- **Flatbed**: any `#pen` is terminal, because the glass holds a single page.

**POSTSCAN drain.** After ADF scans the printer queues a final `#ERRADF PE` (ADF Paper End) status message in its output buffer. If this message is not consumed before the session closes, the printer's internal state machine does not advance cleanly, and the panel displays "Scanning Error" on subsequent scans. The two POSTSCAN cycles (`FS Y → STAT → pure-read(12) → FIN`, twice) drain this queued status. Each cycle's `STAT` reply declares a length of 12, and the subsequent pure-read consumes those 12 bytes (`#ERRADF PE  `). The structure mirrors the `INIT_POLL_STAT_DRAIN` mechanism: the printer uses the IS payload-length field as a general signal that the host should issue a drain read before continuing. Flatbed scans do not produce an ADF status message and skip these two POSTSCAN cycles entirely, going directly from `FIN_AFTER_IMG` to `UNLOCKING`.

**Source detection.** The push-scan SOAP body does not indicate whether the printer will scan from the ADF or the flatbed glass — the panel does not expose a source selector. Instead, the printer detects its own source (via the ADF paper sensor) and signals the result in the first `@STAT` reply during INIT_POLL cycle 1. An ADF-mode printer returns a zero-length `STATx0000000` reply; a flatbed-mode printer returns a 12-byte `STATx000000C` reply with filler content. The scanner reads this length field and sets its internal `source` variable, which governs the PARA blob selection, the IMG loop terminator, and the POSTSCAN branching.

---

## Physical-axis handling

### Source: ADF vs flatbed

The scanner detects the physical source from the first `@STAT` reply in INIT_POLL cycle 1. A reply length of 0 indicates ADF; a reply length greater than 0 (12 on the ET-4950) indicates flatbed. When the length is non-zero, those bytes are drained with a pure-read before the next command is sent — the printer queues them as pending output, and failing to drain them desynchronises the IS framing for all subsequent packets.

ADF precedence: when the ADF feeder has paper loaded, the printer picks ADF regardless of whether a document is also present on the glass. The INIT_POLL STAT reply returns length 0 in this case. Users who want flatbed must clear the ADF first.

The PARA payload differs by source:

| Source       | Token      | `#PAG` token | ACQ y-start | Announced length |
| ------------ | ---------- | ------------ | ----------- | ---------------- |
| ADF          | `#ADF`     | `#PAGd000`   | `0000069`   | `0x3A8` (936 B)  |
| ADF + duplex | `#ADFDPLX` | `#PAGd000`   | `0000069`   | `0x3AC` (940 B)  |
| Flatbed      | `#FB `     | (omitted)    | `0000000`   | `0x3A0` (928 B)  |

The rest of the PARA blob — three gamma correction tables, color correction matrix, acquisition geometry, buffer size — is identical across sources and is hardcoded in `src/esci.ts` from the byte-for-byte Frida capture.

### Sides: 1-sided vs 2-sided

The panel's Sides selection is carried in `PushScanIDIn[0]`: `0` = 1-Sided, `1` = 2-Sided. For ADF scans, the scanner passes this as the `duplex` flag to `buildParaPayload`. Duplex replaces the `#ADF` source token with `#ADFDPLX` (four bytes wider), increasing the announced PARA length from `0x3A8` to `0x3AC`. The rest of the blob is identical.

Duplex scans produce image sides in the order front/back/front/back/... The back side of each sheet comes out physically flipped 180° because of the ADF's U-turn paper path — the sheet is pulled through, reversed, and re-fed, so the physical image is upside-down relative to the front side. Back sides are identified by the `#typIMGB` token in their `#pst` (page-start) and `#pen` (page-end) responses; front sides carry `#typIMGA`. Because the `#pst` token arrives at the beginning of a page-side's IMG stream, the scanner can determine orientation at page-start and record it in a `backPages` array without waiting for the full image.

For JPEG output, back-side images have a minimal EXIF APP1 segment prepended after the JPEG SOI marker (via `src/exif.ts`) that sets `Orientation = 3` (rotate 180°). This is a 36-byte synthetic APP1 — the minimum valid structure — since the scanner-produced JPEGs contain no EXIF data of their own. For PDF output, the page's PDF dictionary `/Rotate` entry is set to 180° (via `src/pdf.ts` using pdf-lib). Both approaches allow the viewing application to display pages right-side up without modifying the raw pixel data.

Flatbed scans are always single-sided regardless of the `PushScanIDIn[0]` value.

### Action: JPG / PDF / Preview

The panel's Action selection is the second character of `PushScanIDIn`, interpreted as a bitmask: `1` = JPG, `2` = PDF, `4` = Preview on Computer. The service resolves this to an effective action via `resolveEffectiveAction` in `src/pushscan.ts`.

A key protocol finding: **the wire traffic is identical for JPG and PDF panel selections**. The printer always streams JPEG-encoded image data on the TLS channel regardless of the panel's Action setting. PDF is composed on the host side using pdf-lib after all pages have been received. This was confirmed by capturing a PDF-mode scan with Frida and comparing its TLS payload byte-for-byte against a JPG-mode scan from the same printer — the payloads are identical.

Preview on Computer (`PushScanIDIn[1] = 4`) is rejected by default (the scan does not proceed). The `PREVIEW_ACTION` environment variable overrides this: setting it to `jpg` or `pdf` redirects preview scans through the normal capture flow.

After `DONE`, the end-of-scan step runs in a `setImmediate` callback (to allow the TLS session to close before the synchronous disk writes):

- `action='jpg'`: `promoteTempPagesToOutput` renames `page_NN.jpg` files in the session temp directory to `scan_<timestamp>[_NN].jpg` in the output directory.
- `action='pdf'`: `composePdfFromJpegs` in `src/pdf.ts` embeds each temp JPEG into a pdf-lib `PDFDocument`, applies `/Rotate = 180` on back-side pages, and writes `scan_<timestamp>.pdf`. If composition fails, it falls back to the JPEG promote path.

The temp directory is removed in a `finally` block regardless of outcome.

---

## Reverse engineering: how this was built

The implementation was developed in three phases, each using a different tool to peel back one layer of the protocol.

### Step 1: Wireshark

Wireshark packet captures revealed the discovery and push-scan layers in full. Both operate in plaintext (UDP multicast and HTTP over TCP), so all fields are directly readable. The captures established:

- The multicast address, port, and beacon format (`02 06`/`02 07` packet structure).
- The sequence echo requirement in keepalives — and the consequence of getting it wrong (no entry in the destination list).
- The push-scan HTTP request format, including the non-standard header spacing and the `x-uid` counter.
- The `PushScanIDIn` encoding for Sides and Action.
- That the printer initiates a TLS connection to the host (not the other way around for push-scan initiation) — important for understanding which side opens port 1865.

Capturing UDP multicast and non-standard HTTP required binding a promiscuous-mode capture on the Ethernet interface rather than using a loopback filter. On Windows, `dumpcap` (bundled with Wireshark) works well from the command line — identify the target interface via `dumpcap -D` (using the interface GUID rather than a numerical index, since numerical indexes change when USB network adapters are connected or disconnected).

The TLS session on port 1865 is opaque to Wireshark without the session keys. The captures confirmed that a TLS handshake occurs and that the printer accepts TLS connections from the service, but they could not reveal the plaintext payload.

### Step 2: Frida on the Epson driver (Windows build)

The TLS payload was captured by hooking `CISProtocolStream::SendISPacket` and `CISProtocolStream::ReceiveISPacket` inside `ES2Command.dll` — the two functions, identified by Ghidra analysis (see Step 3), that construct outgoing IS packets and parse incoming IS packets respectively. Windows was chosen as the capture target because Ghidra decompilation of `ES2Command.dll` gave clean access to the hook offsets; the same observations should hold on the macOS or Linux builds modulo symbol differences. Because these functions operate on plaintext before TLS encryption (send path) and after TLS decryption (receive path), the hooks capture the full unencrypted IS payload including all ESC/I-2 command bytes.

The Frida setup has a Windows-specific complication: the target process (`es2projectrunner.exe`) is spawned on demand by `EEventManager.exe` when a scan is triggered, and Windows does not support `device.enable_spawn_gating` (the Frida API for intercepting child processes before they execute). The solution is to hook `EEventManager.exe` directly and instrument it to watch for child-process spawns, then attach to `es2projectrunner.exe` at spawn time via a custom hook in the parent. This is implemented in `tools/frida-capture/host.py` and `tools/frida-capture/agent.js`.

Each captured session is written to a JSONL file in `tools/frida-capture/captures/` where each record is a `{"dir": "SEND"|"RECV", "type": <hex>, "data": <hex>}` object. The captures cover:

| File                                           | Scenario                          |
| ---------------------------------------------- | --------------------------------- |
| `2026-04-24T08-56-07-adf-1p-simplex.jsonl`     | 1-page ADF simplex JPG (baseline) |
| `2026-04-24T08-58-29-adf-1p-duplex.jsonl`      | 1-page ADF duplex JPG             |
| `2026-04-24T08-59-52-adf-3p-simplex.jsonl`     | 3-page ADF simplex JPG            |
| `2026-04-24T09-01-34-adf-3p-duplex.jsonl`      | 3-page ADF duplex JPG             |
| `2026-04-24T09-03-58-adf-1p-simplex-pdf.jsonl` | 1-page ADF simplex PDF            |
| `2026-04-24T09-05-08-flatbed-1p-jpg.jsonl`     | 1-page flatbed JPG                |
| `2026-04-24T09-06-37-flatbed-1p-pdf.jsonl`     | 1-page flatbed PDF                |

The PDF capture was particularly diagnostic: its TLS payload is byte-identical to the JPG baseline capture, confirming that PDF is entirely a host-side composition step and that the printer has no knowledge of the format distinction.

### Step 3: Ghidra on ES2Command.dll

Ghidra static analysis of `ES2Command.dll` (32-bit x86) provided the semantic layer that the Frida captures alone could not: function names, the IS type-code map, the async-event dispatch table, the lock-packet payload format, and the dual command-stack architecture (legacy ESC/I and ESC/I-2 co-existing over the same IS framing). The key findings were:

- The complete IS type-code table (`0x8000` welcome, `0x9000` async event, `0xa000` passthru reply, `0xa100` lock/unlock ack, `0x2000` passthru request, `0x2100`/`0x2101` lock/unlock). These are not documented anywhere publicly; Ghidra's decompilation of `CISProtocolStream::CheckEvent` and its dispatcher made them explicit.
- The async-event dispatch byte table in `CISProtocolStream::DidReceiveAsyncEvent` — specifically that `0xa0` is `ServerError`, which the driver treats as an unrecoverable error requiring session teardown. Early implementation attempts received `IS 0x9000` + `0xa0` on every session and interpreted it as a "write acknowledge" needing a follow-up read, which was incorrect. Ghidra definitively resolved this: `0x9000`/`0xa0` means the printer has rejected the session and will close the connection; there is no recovery.
- The lock-packet payload format: 7 bytes, `01 a0 04 <timeout_BE_u32>`. This exact payload is in `buildLockPacket` in `src/protocol.ts`.
- The existence of two parallel command stacks: `CESCI2Command` for ESC/I-2 text commands and `CESCICommand` for legacy binary ESC/I — both multiplexed through `CISProtocolStream` over the same IS type `0x2000` envelope. This explained why the scanner needs to speak both command languages in a single session.
- Hook addresses used by the Frida agent (`FUN_100a5a40` for `SendISPacket`, `FUN_100a5bf0` for `ReceiveISPacket`), which were identified by following the call chain from the decompiled DLL entry point `ESCreateScanner` through the IS protocol layer.

Ghidra alone could not reveal the exact byte sequences the driver sends during a scan session — that information is assembled at runtime from device state and query results. Ghidra established the structure and the semantics; Frida captured the runtime content. The combination of both tools was necessary.

### The panel-error investigation

One significant debugging episode is worth understanding because its resolution shaped the push-scan implementation. After all other protocol layers were working correctly, the printer's panel displayed "Scanning Error" after every scan via the service, even though a valid output file was produced. The scan data transferred correctly end-to-end.

Investigation via paired Wireshark captures (one from the Epson driver, one from the service) identified the cause: the printer includes an `x-uid` counter in each push-scan POST request and expects to see that exact value echoed in the 200 OK response. The service had hardcoded `x-uid : 1` in its response. The printer resets its counter to `1` at power-on, so the first scan after a reboot succeeded (the counter happened to be `1`), but every subsequent scan failed as the counter advanced. The fix — parsing the `x-uid` from the incoming request and echoing it in the response — is in `buildPushScanResponse` in `src/pushscan.ts`.

### The byte-for-byte replay test

`src/scanner.test.ts` is the regression shield that ties everything together. It loads a Frida capture JSONL file, connects the real `startScanSession` state machine to a fake TLS socket that feeds the captured RECV records one-by-one, and asserts that every byte the state machine sends matches the corresponding SEND record from the capture. Any state-machine edit that changes the outgoing byte sequence will fail this test.

The suite runs six parametrized replay entries: the 1p-simplex, 3p-simplex, and 1p-duplex ADF captures in both JPG mode and PDF mode (reusing the same capture data with `action='pdf'`). JPG replay entries assert JPEG files on disk with correct EXIF orientation on back-side pages. PDF replay entries assert a single composed PDF with correct page count and `/Rotate = 180` on back pages.

Because the protocol was built from these captures, the replay test is both a regression test and a specification: the state machine is, by construction, correct if and only if it produces the exact byte sequence that the Windows driver produced on the same printer.

---

## Code layout

| File               | Responsibility                                                             |
| ------------------ | -------------------------------------------------------------------------- |
| `src/index.ts`     | Service entry point — wires together all modules and starts the event loop |
| `src/config.ts`    | Zod-validated configuration from environment variables                     |
| `src/keepalive.ts` | UDP multicast listener and keepalive responder                             |
| `src/pushscan.ts`  | TCP server for push-scan trigger, SOAP parsing, x-uid echo                 |
| `src/scanner.ts`   | TLS scan session state machine                                             |
| `src/protocol.ts`  | IS-frame encode/decode, lock/unlock/passthru/pureread packet builders      |
| `src/esci.ts`      | ESC/I and ESC/I-2 command builders, PARA payload blobs, reply parsers      |
| `src/exif.ts`      | JPEG EXIF APP1 injection for back-side orientation                         |
| `src/pdf.ts`       | PDF composition from per-page JPEGs using pdf-lib                          |
| `src/output.ts`    | Output filename generation and temp-file promotion                         |
| `src/health.ts`    | HTTP health-check endpoint on port 3000                                    |
| `src/logger.ts`    | Structured logger (wraps pino)                                             |
| `src/lifecycle.ts` | Graceful shutdown coordination                                             |
| `src/network.ts`   | Network interface enumeration helpers                                      |

Test files mirror the module they cover (`src/scanner.test.ts`, `src/keepalive.test.ts`, etc.). The replay test harness support code lives in `src/test-support/`.

Reverse-engineering artifacts:

| Path                            | Contents                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| `tools/frida-capture/host.py`   | Frida orchestrator — child-gates through `EEventManager.exe`           |
| `tools/frida-capture/agent.js`  | Frida JavaScript agent — hooks `SendISPacket` / `ReceiveISPacket`      |
| `tools/frida-capture/captures/` | JSONL capture files used as test fixtures                              |
| `test-fixtures/sample-page.jpg` | JPEG extracted from the 1p-simplex baseline; used by `src/pdf.test.ts` |

---

## Testing

The test suite uses Vitest and runs with `npm test` (approximately 150 tests, completing in under two seconds).

**The replay harness** (`src/scanner.test.ts`) is the most important test file. It instantiates the real `startScanSession` function with a fake TLS socket factory. The fake socket replays the RECV side of a Frida capture (the bytes the printer sent), advancing one IS packet at a time, and records every byte the state machine sends. After the session completes, the test asserts byte-for-byte equality against the SEND side of the capture. On-disk output files are also asserted — JPEG files for JPG-mode runs (including EXIF orientation verification), and a composed PDF for PDF-mode runs (including page count and `/Rotate` metadata on back pages).

**Unit tests** cover each module independently:

- `src/keepalive.test.ts` — announcement parsing, keepalive packet construction, burst timing.
- `src/pushscan.test.ts` — SOAP request parsing, `PushScanIDIn` decoding, `x-uid` echo, action resolution.
- `src/protocol.test.ts` — IS-frame encode/decode round-trips, all packet builder variants.
- `src/esci.test.ts` — ESC/I-2 command builders, PARA payload size assertions, token parser.
- `src/pdf.test.ts` — PDF composition from sample JPEGs, page-count and rotation assertions.
- `src/exif.test.ts` — EXIF APP1 injection, orientation byte placement, SOI/SOF preservation.
- `src/output.test.ts` — filename generation, sorted page file enumeration.
- `src/config.test.ts` — Zod validation, required-field and default-value handling.
- `src/health.test.ts` — HTTP health endpoint response codes and body.
- `src/lifecycle.test.ts` — graceful shutdown signal handling.

The test fixture for `src/pdf.test.ts` is `test-fixtures/sample-page.jpg`, a small JPEG extracted from the 1p-simplex Frida capture by `tools/extract-test-jpeg.ts`.

CI runs `npm install && npm test` on every push and every pull request targeting `main` (see `.github/workflows/test.yml`). The workflow uses `npm install` rather than `npm ci` because the lockfile is generated on Windows and lacks Linux-only optional native dependencies; running `npm ci` on Linux would fail with a missing-dependency error.

To run a single test file with verbose output:

```sh
npx vitest run src/scanner.test.ts --reporter=verbose
```

To run only tests matching a name pattern:

```sh
npm test -- pushscan
```

---

## References

- **node-hp-scan-to** — a comparable project for HP printers that reverse-engineered HP's equivalent "Scan to Computer" protocol. Useful for understanding the general approach to vendor scan-destination registration.
- **SANE `epsonds` backend** (`sane-project/backends`, `backend/epsonds*.{c,h}`) — open-source implementation of the ESC/I-2 scanner protocol for older Epson networked scanners. The IS-frame layout and passthru command structure are compatible with the ET-4950; the initialization sequence (no legacy ESC/I phase) and async-event handling differ. Cross-referencing `epsonds` against the Frida captures was instrumental in confirming which parts of the protocol were standard and which were ET-4950-specific.
- **Frida** (`frida.re`) — dynamic instrumentation toolkit used to hook `ES2Command.dll` and extract plaintext TLS payloads at runtime.
- **Ghidra** (`ghidra.re`) — open-source reverse-engineering suite used for static analysis of `ES2Command.dll` to establish function names, type-code maps, and hook addresses.
- **pdf-lib** — TypeScript PDF manipulation library used for host-side PDF composition.
- **Vitest** — test framework used throughout the suite.
- **ESC/I-2 specification** — not publicly available, but the command names, token formats, and parameter-block structure are corroborated between the SANE `epsonds` backend source code and the Frida capture content. The specification was apparently only distributed to licensed hardware partners.
