# How it works

Many networked Epson printers expose a panel feature called "Scan to Computer". Press Scan on the panel, pick a destination, and the file lands on the chosen device. The transport is a proprietary, closed-source protocol implemented by Epson's vendor driver stack (available for Windows, macOS, and Linux; reverse-engineering for this project was done against the Windows build, where the driver chain is `EEventManager.exe` / `es2projectrunner.exe` / `ES2Command.dll`). Across the printer families this project supports, the high-level shape is the same: UDP multicast for destination registration, an HTTP-shaped push-scan trigger, and a per-scan session on TCP port 1865. The wire details inside that session vary by family.

The supported families fall into two protocol generations:

- **ESC/I-2** (the modern stack). ET-4950 / ET-3950 / ET-4956 use it over TLS. ET-2750 uses the same vocabulary over plain TCP.
- **Legacy ESC/I** (2014-era WorkForce family). WF-3620 and similar models speak a different command set over plain TCP.

This project reverse-engineers those stacks and re-implements them as a single Node.js/TypeScript service. Instead of requiring a desktop machine running Epson's driver GUI, the service runs headless on Linux or in Docker and presents itself to the printer as a named scan destination called "Paperless". When the user presses Scan on the panel, the service captures the image and writes a JPEG or composed PDF to disk. When `PAPERLESS_URL` and `PAPERLESS_TOKEN` are configured, completed scans are also POSTed to Paperless-ngx and (by default) deleted locally after a successful upload.

The work began on the ET-4950, the author's hardware. WF-3620 support followed an external compatibility report; ET-2750 followed once another reporter contributed a capture. v0.4.0 consolidated the three transport variants onto a shared scan-session engine.

The implementation came from progressively cheaper reverse-engineering layers, picked per printer family. The original ET-4950 work needed all three: Wireshark for the cleartext discovery and push-scan phases, Frida to extract the TLS-tunneled payload byte-for-byte from `ES2Command.dll`, and Ghidra to decompile that DLL for the IS type-code map and async-event semantics. The plain-TCP printer families (ET-2750, WF-3620) needed only the Wireshark layer. Their wire is unencrypted, so captures alone were enough; `tools/pcap-extract/` converts a `.pcapng` straight into a JSONL replay fixture. The Frida and Ghidra investment paid for the TLS-tunnel family once and for all, and subsequent printer families came in cheaply.

This document explains the protocol, the code structure, and the reverse-engineering methodology, so someone working on a related Epson printer can follow the same approach.

---

## The wire protocol

All supported printers use three distinct network channels in sequence. The first two are universal across families; the third (the scan session) is where the printer-family differences live.

```
Printer (broadcast)  →  Service (multicast listener)     Discovery / keepalive
Printer (unicast)    →  Service (TCP port 2968)          Push-scan trigger
Service              →  Printer (TCP port 1865)          Scan session
```

Each channel is independent enough to be developed and tested separately. Inside the scan session, the same `IS` framing wraps either ESC/I-2 commands (ET-4950 family + ET-2750) or legacy ESC/I commands (WF-3620 family). TLS is layered around it for ET-4950; the other two run on plain TCP.

### Discovery and keepalive (UDP multicast)

The printer periodically broadcasts an `02 06` announcement packet to the multicast address `239.255.255.253:2968` — roughly once every 60 seconds, and also immediately after the printer wakes from sleep. The announcement carries service identification (typically ~80 bytes total: `02 06` magic + 12-byte header + service descriptor + capability list). Byte 11 of the header is a sequence counter that increments with each broadcast cycle.

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

The service parses the `PushScanIDIn` value from the request body, sends the HTTP 200 OK response, and half-closes the push-scan TCP connection with a FIN (not RST — using RST causes the printer to tear down its end aggressively). Once that response has been written, the daemon's callback opens the scan-session connection to the printer on port 1865. In `PRINTER_PROTOCOL=auto` mode the dispatcher probes that port first and chooses the TLS ESC/I-2, plain-TCP ESC/I-2, or legacy ESC/I scanner.

Implemented in `src/pushscan.ts`. `parsePushScanRequest` extracts the SOAP fields; `buildPushScanResponse` constructs the echoed response. Action handling is two-stage: `computeActionFromId` decodes the raw `PushScanIDIn` action bitmask into one of `jpg`, `pdf`, `preview`, or `unknown`; `resolveEffectiveAction` then applies the `PREVIEW_ACTION` env-var gate and returns `jpg`, `pdf`, or `null` (default: reject preview silently → `null`; `PREVIEW_ACTION=jpg`/`pdf` redirects preview into a real scan).

### Scan session: three transport variants on port 1865

Three transport variants ride on TCP port 1865, decided per scan session by `src/protocol-probe.ts` (covered in detail in [Protocol probe](#protocol-probe-three-arms) below):

| Variant       | Transport    | Command set          | Hardware                    |
| ------------- | ------------ | -------------------- | --------------------------- |
| `esci2-tls`   | TLS over TCP | ESC/I-2 over IS      | ET-4950 / ET-3950 / ET-4956 |
| `esci2-plain` | Plain TCP    | ESC/I-2 over IS      | ET-2750 (flatbed-only)      |
| `esci`        | Plain TCP    | Legacy ESC/I over IS | WF-3620 family              |

The rest of this section walks the **canonical `esci2-tls` path** in depth, since it's the most mechanically complex (TLS on top, both command generations layered inside) and the foundation that the other two variants peel back from. The plain-TCP ESC/I-2 differences (ET-2750) live in [ESC/I-2 over plain TCP](#esci-2-over-plain-tcp-et-2750), and the legacy ESC/I family (WF-3620) in [ESC/I variant](#esci-variant-wf-3620). Both are sibling sections, not appendices.

#### TLS on the canonical path

The `esci2-tls` image transfer happens over a TLS 1.2 session that the service initiates outbound to the printer on port 1865. TLS chain validation is disabled, since the printer presents a self-signed certificate and there is no trust chain to validate against. As an opt-in alternative, setting `PRINTER_CERT_FINGERPRINT` pins the peer's SHA-256 fingerprint and aborts the scan at handshake time on mismatch (see [README](../README.md#configure)). Pinning requires `PRINTER_PROTOCOL=esci2` set explicitly. Under `auto` (or either of the non-TLS variants), the combination is rejected at startup because a probe failure could downgrade silently to a non-TLS path and bypass the pin.

#### IS framing (universal across all three variants)

Whether the session runs over TLS (ET-4950) or plain TCP (ET-2750, WF-3620), all traffic is wrapped in Epson's proprietary **IS framing**. Every message in both directions is an IS packet:

```
Offset  Len  Field
──────  ───  ─────
  0      2   ASCII magic "IS"
  2      2   Packet type (big-endian uint16)
  4      2   Data offset (host-side: 0x000C; printer-side: 0x300C — see below)
  6      4   Payload size (big-endian uint32)
 10      2   Padding (zeros)
 12      N   Payload
```

The data-offset field is asymmetric: host-side is always `0x000C` (12); printer-side is always `0x300C` — confirmed across all seven ET-4950 Frida captures and the ET-2750 pcap. The `0x300C` is a printer-firmware constant that the SANE `epsonds` source treats as opaque too. Our builders write `0x000C` on outbound; our parser reads only the type and length fields and ignores offset 4-5 on inbound, so the asymmetry requires no code change.

The packet type field determines the semantics of the payload. The ESC/I-2 path uses these types:

| Type   | Direction      | Meaning                                                 |
| ------ | -------------- | ------------------------------------------------------- |
| 0x8000 | Printer → host | Welcome — first packet on a fresh session connection    |
| 0x9000 | Printer → host | Async event (scan start, cancel, timeout, error)        |
| 0xa000 | Printer → host | Passthru data reply (response to a command)             |
| 0xa100 | Printer → host | Lock acknowledgement                                    |
| 0xa101 | Printer → host | Unlock acknowledgement                                  |
| 0x2000 | Host → printer | Passthru command (sends a command, declares reply size) |
| 0x2100 | Host → printer | Lock request                                            |
| 0x2101 | Host → printer | Unlock request                                          |

The legacy ESC/I path (WF-3620) reuses `0x8000`, `0xa000`, `0xa100`/`0xa101`, and `0x2000`/`0x2100`/`0x2101` with the same meaning, plus two extra types: `0x2200` (host → printer stream config) and `0xa200` (printer → host unsolicited image-stream chunks). It does not use `0x9000` async events.

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

**PARA is sent in two passthru packets**, not one. The first packet carries the 12-byte `PARAx<hex-len>` header with `reply_size=0`. The second carries the raw parameter bytes with `reply_size=64`. The printer acks the first packet with an empty `0xa000` reply, then responds to the second with a 64-byte `PARAx0000000#parOK…` reply if the parameters were accepted (or `#parNG…` if not). This two-phase structure was discovered from the Frida capture: the Windows driver never batches the two sends into a single passthru.

ESC/I-2 command builders are in `src/esci2/commands.ts`. The legacy 2-byte initialization commands (`buildFsY`, `buildFsX`, `buildFsZ`) live in `src/commands-fs.ts` and are shared with the WF-3620 ESC/I path (which uses `buildFsY` for the `DIAGNOSE_PROTOCOL` probe). `buildEsci2Command` builds the generic 12-byte ESC/I-2 header. `buildParaHeader` and `buildParaPayload` build the two PARA phases. Reply parsing is done by `parseEsci2ReplyHeader` (extracts the 12-byte reply header's `cmd` and `length` fields) and `parseTokens` (splits the `#KEY value` token stream from reply bodies).

The SANE `epsonds` backend provides a useful cross-reference: its passthru framing — IS header layout, `0x000C` data offset, 8-byte data header with `cmd_size` / `reply_size` — is byte-identical to what the ET-4950 expects. However, `epsonds` targets older scanners that do not require the legacy ESC/I initialization loop before ESC/I-2 commands. The ET-4950's firmware requires a legacy preamble (`FS Y` / `FS Z`, then repeated `FS Y → STAT → FIN` polling, then `FS X`) before the scan-parameter and image-transfer half of the session will be accepted.

#### Capability discovery cycles

During the pre-mode-switch init sequence, the driver performs two capability discovery cycles. The first follows the initial `FS Y` ACK and sends `INFO → CAPA → FIN`; the second follows the `FS Z` ACK and sends `INFO → CAPA → RESA → FIN`. (The `@` prefix in the Frida capture naming convention is not a wire prefix — the actual command bytes on the wire are `INFOx0000000` and `CAPAx0000000` in the ESC/I-2 format.) These cycles appear in the Frida captures with consistent counts across all scan scenarios (2 × INFO, 2 × CAPA, 1 × RESA), which suggests they are mandatory initialization steps rather than optional feature queries.

The INFO and CAPA replies declare the scanner's capabilities (supported resolutions, colour modes, document sources, and similar parameters). In a host-initiated pull-scan flow, the way the vendor driver's own UI works, these values would populate a scan dialog. In the push-scan flow implemented here, the replies are consumed and discarded. The PARA payload is hardcoded from the Frida capture rather than dynamically constructed from capability discovery. This is a deliberate simplification: every supported printer's capabilities are fixed in firmware for the parameters this project uses (300 dpi, colour, JPEG), and adding runtime negotiation would only restate what the captures already pin. The cost would be additional Frida captures and reverse-engineering work, with no change to the end result.

---

## The scanner state machines

The project has two protocol graphs sharing one engine. Each protocol variant lives in a thin orchestration shell that builds a `SessionTransport` and calls the shared `runScanSession` engine in `src/scan-session.ts`. The state machine itself is plain frozen data: a `Graph<Ctx>` defined in a per-protocol `graph.ts` file whose states the engine walks one IS packet at a time. Each transition is either a static rewrite (incoming IS type → next state + bytes to send) or a decision function that inspects the packet payload and returns the same shape. State threading uses a typed ctx object that the engine carries through every transition.

This section walks the **ESC/I-2 graph** in detail, since it covers two of the three variants (`esci2-tls` and `esci2-plain` share it). The legacy ESC/I graph used by the WF-3620 family follows the same engine pattern with a different shape, summarised in [ESC/I variant (WF-3620)](#esci-variant-wf-3620) below.

The shells / graphs / transports map to the variants like so:

| Variant       | Shell entry point       | Graph             | Transport composition                                                                                                                                |
| ------------- | ----------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esci2-tls`   | `runEsci2Scan`          | `src/esci2/graph` | `withEsci2UnlockOnDestroy(withTlsErrorLabels(socketAsTransport(tls.connect(...))))` — see [Transport adapters](#transport-adapters)                  |
| `esci2-plain` | `runEsci2ScanOverPlain` | `src/esci2/graph` | `withEsci2UnlockOnDestroy(socketAsTransport(net.connect(...)))` — same graph, profile-conditional decisions                                          |
| `esci`        | `runEsciScan`           | `src/esci/graph`  | `socketAsTransport(net.connect(...))` — no transport adapters; UNLOCK is sent from the graph's `UNLOCKING` state rather than via a destroy-time hook |

Both ESC/I-2 entry points share the same graph via an `Esci2Profile = "esci2-tls" | "esci2-plain"` discriminator threaded through `Esci2Ctx`. The deterministic single-IS-packet-per-transition contract holds for all three.

```
CONNECTING
    │  session handshake (TLS for esci2-tls; plain TCP for esci2-plain)
    ▼
WELCOME          ← receive IS 0x8000 welcome
    │  send Lock (IS 0x2100)
    ▼
LOCKING          ← receive IS 0xa100 lock ack (expect 0x06)
    │
    ▼
INIT1_FS_Y       ← send FS Y (legacy 2-byte), await 1-byte ACK
INIT1_INFO       ← send INFO, drain declared capability body
INIT1_CAPA       ← send CAPA, drain declared capability body
INIT1_FIN        ← send FIN, await 64-byte reply
    │
INIT2_FS_Z       ← send FS Z (legacy 2-byte), await 1-byte ACK
INIT2_INFO       ← send INFO, drain declared capability body
INIT2_CAPA       ← send CAPA, drain declared capability body
INIT2_RESA       ← send RESA, drain declared resolution body
INIT2_FIN        ← send FIN, await 64-byte reply
    │
INIT_POLL × 3 (or × 2 on esci2-plain):
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
  │    POSTSCAN_DRAIN ← pure-read(declared length) to drain          │
  │                     #ERRADF PE status (12 bytes in practice)     │
  │    POSTSCAN_FIN   ← send FIN, await reply                        │
  └───────────────────────────────────────────────────────────────────┘
  (flatbed skips POSTSCAN entirely)
    │
UNLOCKING        ← send Unlock (IS 0x2101), await IS 0xa101 ack
    │
DONE             ← compose/promote output files, then resolve
```

**INIT_POLL iterations.** The init poll runs three times on `esci2-tls` and twice on `esci2-plain` (ET-2750's host driver only loops twice before sending FS X — sending a third FS Y after the printer has moved on returns a non-ACK that fails MODE_SWITCH validation). The Windows driver ran the ET-4950 loop up to 14 times in one capture because the printer was still waking up; three iterations is sufficient for a printer that is already active. The loop is driven by a counter, not a ready-state signal from the printer — the status values returned by STAT during INIT_POLL are not examined for readiness; they are simply consumed.

**Async events.** At any point during the session, the printer can send an IS `0x9000` async event packet. The ESC/I-2 graph's `globalAbortHandlers` entry for `0x9000` inspects the dispatch byte and returns `null` (info-only) for `0x01` (ScanStart) and `0x04` (Stop), or an `Error` for `0x03` (ScanCancel — cancel) and the fatal set `0x02`/`0x80`/`0xa0` (Disconnect/Timeout/ServerError). The engine settles with `{ ok: false, reason }` on any returned `Error`, regardless of which fatal it was. The handler is registered at the ESC/I-2 graph level — it applies to both ESC/I-2 variants (TLS and plain-TCP) but not to the legacy ESC/I (WF-3620) graph, which does not register a global async handler. In practice, a `0x9000`/`0xa0` ServerError always means the printer rejected a command (typically a malformed PARA or an unexpected command sequence), and the session connection closes within milliseconds of the event.

**IMG loop mechanics.** Each `IMG` command returns a 64-byte metadata envelope whose `IMGx<hex-length>` prefix declares the byte count of the following image data chunk. The scanner issues a pure-read (passthru with `cmd_size=0`, `reply_size=chunk_length`) to pull those bytes, which accumulate into the in-memory JPEG buffer for the current page. Zero-length replies (`IMG x0000000`) indicate the printer is not ready yet — the scanner retries up to 2,000 times before treating it as a timeout. When IMG metadata reports a `#pen` token, the current page-side has ended; after the final pixel chunk for that page has been received in the next IMG_DATA step (or, in the zero-length-pen edge case, immediately from IMG_META), the accumulated JPEG buffer is flushed to a `page_NN.jpg` file in the session temp directory.

The IMG loop's termination condition differs by source:

- **ADF**: `#pen` is terminal only if the same reply also contains `#lftd000` ("zero pages left"). A `#pen` without `#lftd000` signals a page boundary — the scanner flushes the current page to the temp directory and continues issuing `IMG` commands for the next page.
- **Flatbed**: any `#pen` is terminal, because the glass holds a single page.

**POSTSCAN drain.** After ADF scans the printer queues a final `#ERRADF PE` (ADF Paper End) status message in its output buffer. If this message is not consumed before the session closes, the printer's internal state machine does not advance cleanly, and the panel displays "Scanning Error" on subsequent scans. The two POSTSCAN cycles (`FS Y → STAT → pure-read(declared length) → FIN`, twice) drain this queued status. The drain consumes the length declared by the STAT reply — 12 bytes (`#ERRADF PE  `) on every captured ADF post-scan, but the implementation reads the declared length verbatim rather than hardcoding 12. The structure mirrors the `INIT_POLL_STAT_DRAIN` mechanism: the printer uses the IS payload-length field as a general signal that the host should issue a drain read before continuing. Flatbed scans do not produce an ADF status message and skip these two POSTSCAN cycles entirely, going directly from `FIN_AFTER_IMG` to `UNLOCKING`.

**Source detection.** The push-scan SOAP body does not indicate whether the printer will scan from the ADF or the flatbed glass — the panel does not expose a source selector. Instead, the printer detects its own source (via the ADF paper sensor) and signals the result in the first `@STAT` reply during INIT_POLL cycle 1. On the `esci2-tls` profile (ET-4950 family), an ADF-mode printer returns a zero-length `STATx0000000` reply and a flatbed-mode printer returns a 12-byte `STATx000000C` reply with filler content. The scanner reads this length field and sets its internal `source` variable, which governs the PARA blob selection, the IMG loop terminator, and the POSTSCAN branching.

The `esci2-plain` profile (ET-2750) skips this heuristic: ET-2750's STAT reply declares `length=0` in its 12-byte ESC/I-2 header but packs a 52-byte filler (`#---#---#---…`) inline in the same 64-byte IS frame, so applying the ET-4950 rule would misclassify it as ADF. ET-2750 hardware is flatbed-only — there's no ADF to detect — so the graph trusts the `source: "flatbed"` value the scanner shell pre-sets in `initialCtx` and the `INIT_POLL_STAT` decision is conditioned on `ctx.profile === "esci2-tls"` for the override path.

### Transport adapters

The engine consumes a generic `SessionTransport` interface (`write` / `end(data?)` / `destroy(err?)` / `on`) — both `tls.TLSSocket` and `net.Socket` satisfy it structurally. ESC/I-2 panel hygiene depends on application-level teardown timing that doesn't belong in the engine itself, so the ESC/I-2 path composes the raw socket through two transport-shape adapters before handing it to `runScanSession` (defined in `src/esci2/transport.ts`):

- **`withEsci2UnlockOnDestroy(inner)`** — protocol-aware. Tracks LOCK/UNLOCK on the wire (by IS type byte at offset 2-3); on destroy, if LOCK was sent but UNLOCK wasn't, calls `inner.end(buildUnlockPacket())` so the unlock bytes leave before FIN. Also gates a polite-close `end()` against a follow-up `destroy()` so the engine's settlement doesn't RST the socket mid-`close_notify`.
- **`withTlsErrorLabels(inner)`** — TLS-only. Labels mid-session error events with `"TLS connection error: …"` and swallows benign post-`end()` resets (`ECONNRESET` / `EPIPE` after the printer FINs first).

The TLS factory composes both: `withEsci2UnlockOnDestroy(withTlsErrorLabels(socketAsTransport(socket)))`. The unlock wrapper is OUTER so its destroy-time `inner.end(buildUnlockPacket())` flows through the TLS-error wrapper, setting that wrapper's `endCalled` flag before bytes leave the host. The plain-TCP factory (ET-2750) composes only the unlock adapter — there's no TLS layer to label or to swallow post-FIN resets from.

The WF-3620 ESC/I path uses no transport-shape adapters. It still emits LOCK and UNLOCK packets on the wire (the same `0x2100` / `0x2101` types the ESC/I-2 path uses), but UNLOCK is sent from the graph's `UNLOCKING.onEnter` rather than via a destroy-time hook, so it doesn't need the polite-close gating that `withEsci2UnlockOnDestroy` provides.

---

## Physical-axis handling

### Source: ADF vs flatbed

On the **`esci2-tls` profile** (ET-4950 family), the scanner detects the physical source from the first `@STAT` reply in INIT_POLL cycle 1: declared length `0` → ADF; declared length `12` → flatbed; any other non-zero length falls back to ADF (no other lengths have been observed in practice — the fallback exists for diagnostic resilience). When the declared length is non-zero, those bytes are drained with a pure-read before the next command is sent — the printer queues them as pending output, and failing to drain them desynchronises the IS framing for all subsequent packets.

On the **`esci2-plain` profile** (ET-2750), this heuristic is skipped entirely. ET-2750 hardware is flatbed-only, but its STAT reply declares length `0` (with a 52-byte filler packed inline in the same 64-byte IS frame), so applying the ET-4950 rule would misclassify it as ADF. The scanner shell pre-sets `source: "flatbed"` in `initialCtx`, and the `INIT_POLL_STAT` decision is gated on `ctx.profile === "esci2-tls"` — the override path doesn't run on the plain profile and the pre-set value survives.

ADF precedence (ET-4950 family only): when the ADF feeder has paper loaded, the printer picks ADF regardless of whether a document is also present on the glass. The INIT_POLL STAT reply returns length 0 in this case. Users who want flatbed must clear the ADF first.

The PARA payload differs by source and protocol profile:

| Source       | Profile       | Token      | `#PAG` token | ACQ y-start | Announced length |
| ------------ | ------------- | ---------- | ------------ | ----------- | ---------------- |
| ADF          | `esci2-tls`   | `#ADF`     | `#PAGd000`   | `0000069`   | `0x3A8` (936 B)  |
| ADF + duplex | `esci2-tls`   | `#ADFDPLX` | `#PAGd000`   | `0000069`   | `0x3AC` (940 B)  |
| Flatbed      | `esci2-tls`   | `#FB `     | (omitted)    | `0000000`   | `0x3A0` (928 B)  |
| Flatbed      | `esci2-plain` | `#FB `     | (omitted)    | `0000000`   | `0x3A8` (936 B)  |

The three ET-4950 (`esci2-tls`) variants are hardcoded in `src/esci2/commands.ts` from byte-for-byte Frida captures. The ET-2750 (`esci2-plain`) flatbed blob is also in `src/esci2/commands.ts` and is byte-transcribed from a pcap capture (see `tools/pcap-extract/captures/et-2750/`); it differs from the ET-4950 flatbed blob by more than length — different gamma constant (`#GMMUG18` vs `#GMMUG10`), no `#QITOFF`/`#CCTCOL` block, new inline `#CMXUM08` ICC-matrix block, slightly different `#ACQ` extents — so it could not be derived by editing the ET-4950 blob.

Within the `esci2-tls` profile, the per-source variants differ in three places: the source token (`#ADF` / `#ADFDPLX` / `#FB `), the `#PAG` page-count token (present for ADF, omitted for flatbed), and the `#ACQ` y-start offset (`0000069` for ADF, `0000000` for flatbed). The remainder — the three RGB gamma correction tables (`#GMTRED` / `#GMTGRN` / `#GMTBLU`), color correction matrix, scan-area extents, and 1 MB buffer-size token — is byte-identical across sources within the profile.

### Sides: 1-sided vs 2-sided

The panel's Sides selection is carried in `PushScanIDIn[0]`: `0` = 1-Sided, `1` = 2-Sided. For ADF scans, the scanner passes this as the `duplex` flag to `buildParaPayload`. Duplex replaces the `#ADF` source token with `#ADFDPLX` (four bytes wider), increasing the announced PARA length from `0x3A8` to `0x3AC`. The rest of the blob is identical.

Duplex scans produce image sides in the order front/back/front/back/... The back side of each sheet comes out physically flipped 180° because of the ADF's U-turn paper path — the sheet is pulled through, reversed, and re-fed, so the physical image is upside-down relative to the front side. Back sides are identified by the `#typIMGB` token in their `#pst` / `#pen` responses; front sides carry `#typIMGA`. The graph updates `ctx.pageSide` on every `IMG_META` reply (the `typ` token is consistent across all packets within a page); when the page completes, the engine reads `ctx.pageSide` from the `flushPage` barrier and pushes the 1-based page index into a `backPageIndices: number[]` array. The array is forwarded to `finalizeSession` so the EXIF / `/Rotate` injection path knows which pages need rotation.

For JPEG output, back-side images have a minimal EXIF APP1 segment prepended after the JPEG SOI marker (via `src/exif.ts`) that sets `Orientation = 3` (rotate 180°). This is a 36-byte synthetic APP1 — the minimum valid structure — since the scanner-produced JPEGs contain no EXIF data of their own. For PDF output, the page's PDF dictionary `/Rotate` entry is set to 180° (via `src/pdf.ts` using pdf-lib). Both approaches allow the viewing application to display pages right-side up without modifying the raw pixel data.

Flatbed scans are always single-sided regardless of the `PushScanIDIn[0]` value.

### Action: JPG / PDF / Preview

The panel's Action selection is the second character of `PushScanIDIn`, interpreted as a bitmask: `1` = JPG, `2` = PDF, `4` = Preview on Computer. The service resolves this to an effective action via `resolveEffectiveAction` in `src/pushscan.ts`.

A key protocol finding for the ESC/I-2 path (ET-4950 family + ET-2750): **the printer is unaware of the JPG-vs-PDF distinction.** It always streams JPEG-encoded image data regardless of the panel's Action setting; PDF is composed on the host side using pdf-lib after all pages have been received. The ADF replay tests assert this directly — the same Frida JPG capture is reused as the fixture for both `action='jpg'` and `action='pdf'` test runs, and the state machine produces the expected outputs in both cases. (The committed JPG and PDF flatbed captures are separate Frida sessions and so differ slightly in capture-time polling cadence, but the protocol structure is the same.)

The ESC/I path (WF-3620) is different: the firmware locks the scan resolution to the panel's format choice (600 DPI for JPG, 300 DPI for PDF), so the wire bytes do differ between the two — see [ESC/I variant (WF-3620)](#esci-variant-wf-3620) below. Composition still happens host-side via pdf-lib in PDF mode, but the underlying pixel stream is captured at the lower resolution.

Preview on Computer (`PushScanIDIn[1] = 4`) is rejected by default (the scan does not proceed). The `PREVIEW_ACTION` environment variable overrides this: setting it to `jpg` or `pdf` redirects preview scans through the normal capture flow.

After `DONE`, the engine calls `transport.end()` to queue the FIN synchronously and then schedules the end-of-scan step via `setImmediate` — it does **not** wait for the socket's `'close'` event (the close handler is a no-op on the DONE path). The `setImmediate` exists to give any in-flight microtasks — notably the previous `flushPage`'s file-write resolving its Promise — a tick to settle before the synchronous finalize step runs:

- `action='jpg'`: `promoteTempPagesToOutput` reads each `page_NN.jpg` from the session temp directory, writes it to `scan_<timestamp>[_NN].jpg` in the output directory (with collision-suffix handling), and unlinks the temp page. Reading + writing rather than `rename` lets temp and output directories live on different filesystems.
- `action='pdf'`: `composePdfFromJpegs` in `src/pdf.ts` embeds each temp JPEG into a pdf-lib `PDFDocument`, applies `/Rotate = 180` on back-side pages, and writes `scan_<timestamp>.pdf`. If composition fails, it falls back to the JPEG promote path.

The temp directory is removed in a `finally` block regardless of outcome.

---

## Protocol probe (three arms)

Three protocol variants ride on port 1865, decided per scan session by `src/protocol-probe.ts`:

1. **TLS handshake** against `1865`. Success → `esci2` (ET-4950 family). The probe socket is destroyed before the real scan begins.
2. **Plain TCP connect**, await an unsolicited IS-`0x8000` welcome packet within the timeout, then disambiguate by the welcome's payload byte 1 (frame offset 13): WF-3620 emits `0x02` here on every committed WF-3620 fixture and is rejected; the ET-2750 emits `0x04` and is accepted. Real fixture payloads are `01 02 00 00 00` (WF-3620) and `01 04 00 00 00` (ET-2750). The ET-4950 also sends a welcome immediately, but only inside its TLS tunnel — connecting to an ET-4950 over plain TCP yields no `0x8000` and the arm times out. Success → `esci2-plain`.
3. **Plain TCP connect**, send `ESC @` (`1b 40`), await a 1-byte `0x06` ACK. Success → `esci` (WF-3620).

The byte-1 discriminator in arm 2 is the load-bearing piece: a real WF-3620 also sends an unsolicited `0x8000` welcome on plain TCP (a misconception in the original probe design said it stayed silent until prompted), so welcomes alone don't separate the two families. The check is encoded as a negative — accept any `0x8000` whose payload[1] is NOT the WF-3620 byte — because the WF-3620 anchor is well-supported (the byte is `0x02` across every committed WF-3620 fixture) while the ET-2750 anchor has only one capture, so a hypothetical future ET-2750-class device that emits a different byte at payload[1] would still be accepted.

If all three arms fail, the dispatcher resolves to `esci` so the legacy scanner's connect path can surface the underlying socket error in a meaningful way (rather than throwing a generic "no protocol matched" message).

Only `esci2` (TLS) results are cached for the daemon's lifetime. The two non-TLS arms re-probe each scan because plain-TCP probes are cheap and a transient ECONNRESET — which can happen mid-handshake against a real ET-4950 too — shouldn't pin a misclassification.

## ESC/I-2 over plain TCP (ET-2750)

A second ESC/I-2 hardware variant — the ET-2750 — uses the same protocol vocabulary as the ET-4950 family **without the TLS layer**. The wire is plain TCP on port 1865; the IS framing, command names, PARA structure, IMG pull loop, and async-event mechanics are otherwise identical. The scanner shell (`runEsci2ScanOverPlain` in `src/esci2/scanner.ts`) shares the protocol graph (`src/esci2/graph.ts`) with the TLS path — the only differences are at the socket factory (`net.connect` instead of `tls.connect`, no cert pinning, no TLS-error label adapter) and a small set of profile-conditional decisions inside the graph.

Wire differences from the ET-4950, decoded from `flatbed-single-page-pdf.pcapng`:

- **No TLS handshake.** The printer sends the welcome IS packet (type `0x8000`) immediately after TCP connect.
- **INIT_POLL runs 2 iterations** (not 3). Profile-conditional in `INIT_POLL_FIN`'s decision; sending a third FS Y after the printer has moved on returns a non-ACK that fails MODE_SWITCH validation.
- **STAT replies pack a 52-byte filler inline** in a single 64-byte IS frame. The 12-byte ESC/I-2 reply header still declares `length=0`, so the ET-4950 length-based source-detection heuristic would misclassify ET-2750 as ADF. The graph skips the override on `esci2-plain` and trusts the `source: "flatbed"` value from `initialCtx`. ET-2750 hardware is flatbed-only, so this is correct.
- **PARA flatbed payload is 936 bytes** (vs ET-4950 flatbed's 928): different gamma constant, no `#QITOFF`/`#CCTCOL` block, new inline `#CMXUM08` ICC-matrix block, slightly different `#ACQ` extents. See the [PARA table above](#source-adf-vs-flatbed) for the full row.

The variant is selected by an `Esci2Profile = "esci2-tls" | "esci2-plain"` discriminator threaded through `Esci2Ctx`. The PARA builder dispatches on profile (`buildParaFlatbedTls` vs `buildParaFlatbedPlain`); the scanner shell selects which entry point (`runEsci2Scan` vs `runEsci2ScanOverPlain`) and pre-sets the profile in initial ctx. ET-2750 is flatbed-only hardware — config-time validation rejects `esci2-plain + ESCI_FORCE_SOURCE` and `esci2-plain + PRINTER_CERT_FINGERPRINT` combinations at startup.

## ESC/I variant (WF-3620)

The WF-3620 (and other 2014-era Epson printers using the same firmware
generation) speaks **plain TCP on port 1865** with **ESC/I commands**
inside the same IS framing the ET-4950 uses. It's the third arm of the
[protocol probe](#protocol-probe-three-arms): when TLS fails and the
printer doesn't send an IS-`0x8000` welcome on plain TCP, sending `ESC @`
elicits a 1-byte ACK from a WF-3620-class device.

Key wire differences (full table in
`.reference/wireshark-captures/wf-3620/protocol-decode.md`):

- Init is `ESC @` (`1b 40`), not `FS Y`. The printer also emits an
  unsolicited IS-`0x8000` welcome on plain TCP (same as the ET-2750), so
  the auto-probe disambiguates by the welcome's payload-byte 2 — see
  [Protocol probe](#protocol-probe-three-arms).
- Source select is sent as `ESC e <byte>` (0=flatbed, 1=ADF simplex,
  2=ADF duplex) before scan setup. The same byte is also written into
  byte 26 of the 64-byte FS W parameter block. Not encoded in PARA tokens
  (there are no PARA tokens — see below).
- Scan parameters fit in a 64-byte little-endian binary block after `FS W`,
  not a 936-byte ASCII PARA blob.
- The printer pushes raw 24-bit GBR-interleaved pixels (bytes per pixel
  are `[G, B, R]`; the host permutes to RGB before sharp encodes them) in
  IS-0xa200 chunks at 600 DPI (JPG) / 300 DPI (PDF) — the firmware locks
  the resolution to the panel's format choice.
- ADF pages are terminated by a host-sent `0x0c 0x00` page-eject. Duplex
  produces two cycles per sheet; the back side comes out 180°-rotated and
  the host applies EXIF Orientation=3 / `/Rotate 180` accordingly.

The ESC/I state machine lives in `src/esci/scanner.ts`. Per-page raw
pixel buffers are accumulated in memory (~104 MB at 600 DPI A4), encoded
to JPEG via sharp, and handed off to `output-tail.ts`'s shared post-scan
pipeline.

### Source selection (ESC/I)

The PushScan SOAP carries `duplex` and `action` (Sides + Format) but no
explicit ADF-vs-flatbed selector. The legacy graph probes with `ESC e 0x01`
and reads the following `FS F` status reply to detect the physical source:

| `FS F` status byte | ESC/I source                           |
| ------------------ | -------------------------------------- |
| `0x81`             | `flatbed`                              |
| `0x01`             | `adf-simplex` or `adf-duplex` by panel |

Setting `ESCI_FORCE_SOURCE=flatbed` (or `adf-simplex` / `adf-duplex`)
overrides the detected value for edge cases whose status byte has not been
captured yet.

### Multi-page termination

After every page-eject, the host polls `FS F`. The 16-byte status reply's
byte 0 is the discriminator: `0x01` means the ADF still has paper (loop
back through gamma/window/start for the next page); `0x81` means the ADF
is empty (proceed to cleanup). This handles arbitrary page counts —
3-sheet simplex, 4-sheet duplex, and 1-sheet duplex all share the same
state-machine path.

The first `FS G` of an ADF session sometimes returns a 14-byte reply with
`chunkSize = 0` — the printer is still threading paper from the tray and
isn't ready to start streaming. The state machine handles this with a
small retry loop: `START_POLL` polls `FS F` until status byte 0 is `0x01`,
then `START_POLL_READY` does one more `FS F` for confirmation, then
re-issues `FS G`. This pattern was captured in `adf-4-page-duplex-pdf` and
mirrors the Windows driver's behaviour.

---

## Reverse engineering: how this was built

The implementation grew in two distinct waves, each using the lightest reverse-engineering toolchain that could decode the printer family at hand.

The **first wave** (ET-4950) needed all three of Wireshark, Frida, and Ghidra because the scan session is wrapped in TLS. Frida hooked the Windows driver's pre-encryption send and post-decryption receive paths to dump the plaintext IS payload; Ghidra decompiled the same DLL to identify the hook offsets and decode the IS type-code map. Three steps, in order.

The **second wave** (ET-2750 + WF-3620) needed only Wireshark. Both speak plain TCP, so the wire bytes are directly readable from a single capture. `tools/pcap-extract/` converts those captures into JSONL replay fixtures. This is "Step 4" below: the same methodology with one fewer tool, applicable to any future plain-TCP Epson printer family.

### Step 1: Wireshark

Wireshark packet captures revealed the discovery and push-scan layers in full. Both operate in plaintext (UDP multicast and HTTP over TCP), so all fields are directly readable. The captures established:

- The multicast address, port, and beacon format (`02 06`/`02 07` packet structure).
- The sequence echo requirement in keepalives — and the consequence of getting it wrong (no entry in the destination list).
- The push-scan HTTP request format, including the non-standard header spacing and the `x-uid` counter.
- The `PushScanIDIn` encoding for Sides and Action.
- That the printer initiates the push-scan trigger (a plain-TCP connection from the printer to the host's event port 2968), but the _host_ initiates the scan-session connection on port 1865 (TLS for ESC/I-2, plain TCP for ET-2750 and WF-3620). Knowing which side opens which port turned out to matter for both the firewall rules in `README.md` and the listener / connector roles in `pushscan.ts` vs the scanner shells.

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

The ET-2750 and WF-3620 families speak plain TCP on port 1865 (no TLS layer), so a Wireshark capture of one scan session shows every byte the driver and printer exchanged. Frida and Ghidra are not needed.

The workflow:

1. Run a Windows VM (or another machine with the vendor driver installed) on the same LAN as the printer.
2. Start `dumpcap` (or Wireshark) on the LAN-side interface, filtering on `tcp port 1865 || udp port 2968`.
3. Trigger a scan from the printer panel and let it complete.
4. Save the resulting `.pcapng` (or `.pcap`).
5. Convert the capture into a JSONL replay fixture: `npm run pcap:extract -- <pcap> <hostIp> <printerIp> <port> <out.jsonl>` (add `--stream N` if the pcap contains multiple TCP conversations on port 1865 and you need to isolate one; list the available stream indices with `tshark -r <pcap> -Y "tcp.port==1865" -T fields -e tcp.stream -e ip.src -e ip.dst | sort -u`, or open the pcap in Wireshark and read the `tcp.stream` field on a packet). The fixture's shape is one JSON object per line: regular events look like `{"dir":"h>p"|"p>h","ts":<seconds>,"hex":"<hex>"}`, and runs of `IS-0xa200` image chunks (WF-3620 family) are folded up into single summary records of the form `{"dir":"p>h","ts":<seconds>,"summary":"image-stream","frameCount":N,"totalBytes":N,"chunkSize":N}`. The summary collapse is what keeps WF-3620 fixtures in the 8–30 KB range; ET-2750 carries pixels inside `0xa000` ESC/I-2 frames so its fixture stays uncompressed (about 3.9 MB for one flatbed page).
6. Eyeball-validate the result. **For WF-3620 captures only:** `npm run pcap:render -- <pcap> <source> <format> <outputDir>` reconstructs the scanned page from the raw 24-bit GBR pixels carried in `IS-0xa200` chunks, where `source` is `flatbed`/`adf-simplex`/`adf-duplex` and `format` is `jpg`/`pdf`. It operates on the original `.pcap` (not the JSONL) and reads `HOST_IP`/`PRINTER_IP`/`SCAN_PORT` env vars (defaults baked in) for the same tshark filter `pcap:extract` uses. **For ET-2750 captures**, `pcap:render` does not apply: ET-2750 image data lives inside ESC/I-2 `0xa000` IMG replies as already-encoded JPEG bytes, not in the WF-3620's GBR-pixel `0xa200` stream. The simpler ET-2750 validation path is to drop the new JSONL into `tools/pcap-extract/captures/et-2750/`, wire it into `src/esci2/scanner.test.ts`'s plain-TCP fixture matrix, and inspect the JPEGs the replay test writes to its temp dir.

Capture sources (gitignored) live under `.reference/wireshark-captures/{wf-3620,et-2750}/`. The extracted JSONL replay fixtures are committed to `tools/pcap-extract/captures/{wf-3620,et-2750}/` and drive the per-variant replay tests; see [The byte-for-byte replay test](#the-byte-for-byte-replay-test) below. Note that the pcap fixture shape (`{dir, ts, hex}` plus optional image-stream summaries) is **different** from the Frida fixture shape (`{hook, type_hex, payload_hex, payload_size, ts}`) used for the ET-4950 captures; `src/esci/test-support/replay.ts` and `src/esci2/test-support/replay.ts` consume the pcap shape, while `src/esci2/scanner.test.ts` consumes the Frida shape directly.

This is the methodology to reach for first when adding a new printer family. If TLS turns out to be in play (a `tcp.port == 1865` capture shows a TLS handshake, opaque ciphertext after, no readable IS frames), fall back to the Step 2 + 3 toolchain.

### The panel-error investigation

One significant debugging episode is worth understanding because its resolution shaped the push-scan implementation. After all other protocol layers were working correctly, the printer's panel displayed "Scanning Error" after every scan via the service, even though a valid output file was produced. The scan data transferred correctly end-to-end.

Investigation via paired Wireshark captures (one from the Epson driver, one from the service) identified the cause: the printer includes an `x-uid` counter in each push-scan POST request and expects to see that exact value echoed in the 200 OK response. The service had hardcoded `x-uid : 1` in its response. The printer resets its counter to `1` at power-on, so the first scan after a reboot succeeded (the counter happened to be `1`), but every subsequent scan failed as the counter advanced. The fix — parsing the `x-uid` from the incoming request and echoing it in the response — is in `buildPushScanResponse` in `src/pushscan.ts`.

### The byte-for-byte replay test

`src/esci2/scanner.test.ts` is the regression shield for the ESC/I-2 path. It runs in two modes:

- **TLS replay (byte-for-byte).** For the ET-4950 Frida captures, the test feeds the captured printer-side records to a `FakeTlsSocket` one-by-one and asserts that every byte the state machine writes matches the corresponding host-side record from the capture. Any edit that changes the outgoing byte sequence will fail. Eight parametrized entries run here: 1p-simplex, 3p-simplex, 1p-duplex (ADF), and 1p-flatbed each in both JPG and PDF mode. The ADF entries reuse a single capture per scenario across `action='jpg'` and `action='pdf'`; the flatbed entries use separate captures for each format because the original Frida session captured them as distinct runs.
- **Plain-TCP replay (behavioural).** For the ET-2750 (`runEsci2ScanOverPlain`), the helper in `src/esci2/test-support/replay.ts` feeds only the printer-side events from a pcap-extracted fixture to a `FakePlainSocket` and asserts the session's on-disk output and end-state, not per-host-byte equality. The fixture is roughly 3.9 MB — a couple of orders of magnitude larger than the WF-3620 fixtures (8-30 KB each) — because ET-2750's IMG cycles wrap pixel data in `0xa000` ESC/I-2 frames; there's no `0xa200` image-stream summary path to fold the per-chunk records into a single summary line like the WF-3620 extractor uses.

JPG replay entries assert JPEG files on disk with the correct EXIF Orientation byte on back-side pages; PDF replay entries assert a single composed PDF with correct page count and `/Rotate = 180` on back pages.

`src/esci/scanner.test.ts` applies the same behavioural replay approach to the WF-3620 ESC/I path, using ten pcap-derived JSONL fixtures in `tools/pcap-extract/captures/wf-3620/` (single-page, 2-page duplex, 3-page simplex, 4-page duplex, and flatbed-single-page, each in JPG and PDF mode). It also feeds only printer-side events; host bytes are not asserted equal to the fixture.

The TLS replay's byte-for-byte guarantee is the strongest regression shield in the suite: that state machine is, by construction, correct if and only if it produces the exact byte sequence that the Windows driver produced on the same printer. The pcap-based behavioural replays are weaker (multiple host-side sequences could in principle pass) but cover the variants for which Frida captures aren't available.

---

## Code layout

| File                      | Responsibility                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`            | Service entry point — long-running daemon. Wires modules together and starts the event loop.                                                                                                                                                 |
| `src/one-shot.ts`         | One-shot CLI variant of the daemon (`npm run scan`). Same scanning wire behaviour as the daemon, but no health endpoint; exits after the first scan completes.                                                                               |
| `src/startup.ts`          | Startup banner + scan dispatcher: routes each push-scan to the right scanner shell based on detected variant.                                                                                                                                |
| `src/config.ts`           | Zod-validated configuration from environment variables.                                                                                                                                                                                      |
| `src/keepalive.ts`        | UDP multicast listener and keepalive responder.                                                                                                                                                                                              |
| `src/pushscan.ts`         | TCP server for push-scan trigger, SOAP parsing, x-uid echo.                                                                                                                                                                                  |
| `src/protocol.ts`         | IS-frame encode/decode, lock/unlock/passthru/pureread packet builders.                                                                                                                                                                       |
| `src/protocol-probe.ts`   | Three-arm probe (TLS → plain-TCP-await-`0x8000` → `ESC @` ACK) classifying each scan's protocol variant.                                                                                                                                     |
| `src/scan-session.ts`     | Generic graph-driven scan-session engine. Walks a `Graph<Ctx>` one IS packet at a time; protocol-blind.                                                                                                                                      |
| `src/esci2/scanner.ts`    | Orchestration shell for the ESC/I-2 path (TLS + plain-TCP entry points). Builds the transport, calls engine.                                                                                                                                 |
| `src/esci2/graph.ts`      | ESC/I-2 protocol graph (states, transitions, PARA dispatch). Driven by `src/scan-session.ts`.                                                                                                                                                |
| `src/esci2/commands.ts`   | ESC/I-2 command builders, PARA payload blobs (TLS + plain), reply parsers.                                                                                                                                                                   |
| `src/esci2/transport.ts`  | TLS-error-label and ESC/I-2 unlock-on-destroy adapters that wrap a raw socket as a `SessionTransport`.                                                                                                                                       |
| `src/esci/scanner.ts`     | Orchestration shell for the WF-3620 ESC/I path. Plain TCP, no transport adapters.                                                                                                                                                            |
| `src/esci/graph.ts`       | ESC/I (WF-3620) protocol graph.                                                                                                                                                                                                              |
| `src/esci/commands.ts`    | ESC/I command builders and reply parsers.                                                                                                                                                                                                    |
| `src/esci/luts.ts`        | Gamma LUT tables for the ESC/I scan path.                                                                                                                                                                                                    |
| `src/esci/raw-to-jpeg.ts` | Raw 24-bit GBR (wire order) → permute to RGB → JPEG encoding via sharp (ESC/I path only).                                                                                                                                                    |
| `src/commands-fs.ts`      | Legacy 2-byte `FS Y` / `FS X` / `FS Z` builders shared by both protocols.                                                                                                                                                                    |
| `src/graph-helpers.ts`    | Shared graph-state helpers (`expectIsType`, `expectLength`, `ackByte`).                                                                                                                                                                      |
| `src/exif.ts`             | JPEG EXIF APP1 injection for back-side orientation.                                                                                                                                                                                          |
| `src/pdf.ts`              | PDF composition from per-page JPEGs using pdf-lib.                                                                                                                                                                                           |
| `src/output.ts`           | Output filename generation and temp-file promotion.                                                                                                                                                                                          |
| `src/output-tail.ts`      | End-of-scan finalize pipeline: JPG promote / PDF compose with `/Rotate=180` on back pages, optional Paperless upload, temp-dir cleanup. (JPG EXIF injection happens earlier, in the engine's flushPage barrier — see `src/scan-session.ts`.) |
| `src/paperless-upload.ts` | Paperless-ngx HTTP upload + post-upload local-file cleanup (when `PAPERLESS_URL` + `PAPERLESS_TOKEN` set).                                                                                                                                   |
| `src/health.ts`           | HTTP health-check endpoint (port from `HEALTH_PORT`, default 3000). Daemon-only — `one-shot.ts` does not start it.                                                                                                                           |
| `src/logger.ts`           | Hand-rolled structured logger; text or JSON output via `LOG_FORMAT`.                                                                                                                                                                         |
| `src/lifecycle.ts`        | Graceful shutdown coordination.                                                                                                                                                                                                              |
| `src/network.ts`          | Resolves the local IP that can reach the printer (UDP `connect()` trick).                                                                                                                                                                    |

Test files mirror the module they cover (`src/esci2/scanner.test.ts`, `src/esci/scanner.test.ts`, `src/keepalive.test.ts`, etc.). The replay test harness support code lives in `src/esci2/test-support/` and `src/esci/test-support/`.

Reverse-engineering artifacts:

| Path                            | Contents                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| `tools/frida-capture/host.py`   | Frida orchestrator — child-gates through `EEventManager.exe`           |
| `tools/frida-capture/agent.js`  | Frida JavaScript agent — hooks `SendISPacket` / `ReceiveISPacket`      |
| `tools/frida-capture/captures/` | JSONL capture files used as test fixtures                              |
| `test-fixtures/sample-page.jpg` | JPEG extracted from the 1p-simplex baseline; used by `src/pdf.test.ts` |

---

## Testing

The test suite uses Vitest and runs with `npm test` (516 passing tests plus 1 skipped test across 27 files, completing in roughly 5 seconds).

**The replay harnesses** are the most important test files. They run in two modes — see [The byte-for-byte replay test](#the-byte-for-byte-replay-test) above for the full account. In short: `src/esci2/scanner.test.ts` runs `runEsci2Scan` against a `FakeTlsSocket` for the ET-4950 Frida captures and asserts byte-for-byte equality on every host send; for the ET-2750 (`runEsci2ScanOverPlain` against `FakePlainSocket`) the harness feeds only printer-side fixture events and asserts on-disk output, not host-byte equality. `src/esci/scanner.test.ts` follows the same behavioural pattern for the WF-3620 ESC/I path using pcap-derived JSONL fixtures. On-disk output is asserted in both modes — JPEG files for JPG-mode runs (including EXIF orientation verification), and a composed PDF for PDF-mode runs (including page count and `/Rotate` metadata on back pages).

**Unit tests** cover each module independently:

- `src/scan-session.test.ts` — engine pump: graph dispatch, decision-state evaluation, flushPage barrier, settlement lifecycle, IS-payload sanity-cap, `bypassIgnoreFilter` per-state opt-out.
- `src/protocol.test.ts` — IS-frame encode/decode round-trips, all packet builder variants.
- `src/protocol-probe.test.ts` — three-arm probe (TLS / plain-TCP-welcome / `ESC @`), cache rules, override paths.
- `src/startup.test.ts` — `dispatchScanSession` routing: each `Variant` selects the right scanner shell and threads config fields (`scanDestId`, `tempDir`, `printerCertFingerprint`, `esciForceSource`, `jpegQuality`, `diagnoseProtocol`, `paperless`) through correctly.
- `src/keepalive.test.ts` — announcement parsing, keepalive packet construction, burst timing.
- `src/network.test.ts` — `getLocalIpForTarget` UDP `connect()` mock: success returns OS-selected local address; error path closes the socket and rejects with target-IP context.
- `src/pushscan.test.ts` — SOAP request parsing, `PushScanIDIn` decoding, `x-uid` echo, action resolution.
- `src/esci2/commands.test.ts` — ESC/I-2 command builders, PARA payload byte-exact assertions (TLS + plain), token parser.
- `src/esci2/graph.test.ts` — ESC/I-2 graph shape, key state transitions, source-detect heuristic, `bypassIgnoreFilter` flags on POSTSCAN drains.
- `src/esci2/transport.test.ts` — `withEsci2UnlockOnDestroy` + `withTlsErrorLabels` adapters and their composition.
- `src/esci/commands.test.ts` — ESC/I command builders, FS W block, gamma LUTs, FS G reply parser.
- `src/esci/graph.test.ts` — ESC/I graph shape, STATUS_2 source-detect, gamma cycle, IMG_RECEIVING flush logic.
- `src/esci/raw-to-jpeg.test.ts` — raw 24-bit GBR → RGB permutation + JPEG encoding round-trip.
- `src/esci/scanner-diagnose.test.ts` — `DIAGNOSE_PROTOCOL` mode: ESC @ NAK + FS Y probe behaviour.
- `src/output-tail.test.ts` — finalize pipeline (JPG promote, PDF compose, PDF compose-failure → JPG fallback, Paperless upload boundary, temp-dir cleanup on failure). Per-upload mechanics live in `src/paperless-upload.test.ts`.
- `src/output.test.ts` — filename generation, sorted page file enumeration.
- `src/paperless-upload.test.ts` — multipart POST, retention-flag handling, error paths.
- `src/pdf.test.ts` — PDF composition from sample JPEGs, page-count and rotation assertions.
- `src/exif.test.ts` — EXIF APP1 injection, orientation byte placement, SOI/SOF preservation.
- `src/config.test.ts` — Zod validation, required-field and default-value handling, pair-validation rules.
- `src/health.test.ts` — HTTP health endpoint response codes and body.
- `src/lifecycle.test.ts` — graceful shutdown signal handling.
- `src/logger.test.ts` — text vs JSON formatting, level filtering, structured-record fields.
- `tools/pcap-extract/extract.test.ts` — end-to-end smoke test of the tshark-driven pcap extractor against a tiny fixture pcap; skipped on CI when `tshark` isn't on PATH (this is the one skipped test in the count above).
- `tools/frida-capture/pretty-print.test.ts` — `formatRecord` annotating welcome / lock / passthru / async-event / unknown / malformed IS packets in the human-readable replay log.

The test fixture for `src/pdf.test.ts` is `test-fixtures/sample-page.jpg`, a small JPEG extracted from the 1p-simplex Frida capture by `tools/extract-test-jpeg.ts`.

CI runs `npm install` followed by the same lint + format:check + test trio that the local pre-push hook enforces, on every push to `dev` / `main` and every pull request targeting `dev` or `main` (see `.github/workflows/test.yml`). The workflow uses `npm install` rather than `npm ci` because the lockfile is generated on Windows and lacks Linux-only optional native dependencies; running `npm ci` on Linux would fail with a missing-dependency error.

To run a single test file with verbose output:

```sh
npx vitest run src/esci2/scanner.test.ts --reporter=verbose
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
