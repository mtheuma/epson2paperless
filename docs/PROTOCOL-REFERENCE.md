# Protocol reference

This document is the byte-level protocol reference for `epson2paperless`. It keeps the detailed wire notes separate from the high-level overview in [HOW-IT-WORKS.md](HOW-IT-WORKS.md). For capture methodology and fixture workflows, see [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md).

## The wire protocol

All supported printers use three distinct network channels in sequence. The first two are universal across families; the third (the scan session) is where the printer-family differences live.

```
Printer (broadcast)  →  Service (multicast listener)     Discovery / keepalive
Printer (unicast)    →  Service (TCP port 2968)          Push-scan trigger
Service              →  Printer (TCP port 1865)          Scan session
```

Each channel is independent enough to be developed and tested separately. Inside the scan session, the same `IS` framing wraps either ESC/I-2 commands (ET-4950 family + ET-2950 over TLS; ET-2750 / XP-7100 / ET-4800 / ET-15000 / FF-680W over plain TCP) or legacy ESC/I commands (WF-3620 family, plain TCP). TLS is layered around it only for the ESC/I-2-over-TLS printers (the ET-4950 family and ET-2950 — a separate registry entry); everything else runs on plain TCP.

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

The service must reply with an HTTP 200 OK. The response must echo the request's `x-uid` header value verbatim. The printer increments this counter on each scan and uses it to verify the response came from the correct session. A mismatched `x-uid` causes the printer to display "Scanning Error" on the panel after the scan completes — even though the scan data transfers correctly and the output file is produced. This is a panel-state signal, not a data-integrity issue; the root cause and fix are documented in [the panel-error investigation](REVERSE-ENGINEERING.md#the-panel-error-investigation).

The service parses the `PushScanIDIn` value from the request body, sends the HTTP 200 OK response, and half-closes the push-scan TCP connection with a FIN (not RST — using RST causes the printer to tear down its end aggressively). Once that response has been written, the daemon's callback opens the scan-session connection to the printer on port 1865. In `PRINTER_PROTOCOL=auto` mode the dispatcher probes that port first and chooses the TLS ESC/I-2, plain-TCP ESC/I-2, or legacy ESC/I scanner.

Implemented in `src/pushscan.ts`. `parsePushScanRequest` extracts the SOAP fields; `buildPushScanResponse` constructs the echoed response. Action handling is two-stage: `computeActionFromId` decodes the raw `PushScanIDIn` action bitmask into one of `jpg`, `pdf`, `preview`, or `unknown`; `resolveEffectiveAction` then applies the `PREVIEW_ACTION` env-var gate and returns `jpg`, `pdf`, or `null` (default: reject preview silently → `null`; `PREVIEW_ACTION=jpg`/`pdf` redirects preview into a real scan).

### Scan session: three transport variants on port 1865

Three transport variants ride on TCP port 1865, decided per scan session by `src/protocol-probe.ts` (covered in detail in [Protocol probe](#protocol-probe-three-arms) below):

| Variant       | Transport    | Command set          | Hardware                                         |
| ------------- | ------------ | -------------------- | ------------------------------------------------ |
| `esci2-tls`   | TLS over TCP | ESC/I-2 over IS      | ET-4950 / ET-3950 / ET-4956 / ET-2950            |
| `esci2-plain` | Plain TCP    | ESC/I-2 over IS      | ET-2750 / XP-7100 / ET-4800 / ET-15000 / FF-680W |
| `esci`        | Plain TCP    | Legacy ESC/I over IS | WF-3620 family                                   |

The rest of this section walks the **canonical `esci2-tls` path** in depth, since it's the most mechanically complex (TLS on top, both command generations layered inside) and the foundation that the other two variants peel back from. The plain-TCP ESC/I-2 differences (ET-2750 / XP-7100 / ET-4800 / ET-15000 / FF-680W) live in [ESC/I-2 over plain TCP](#esci-2-over-plain-tcp), and the legacy ESC/I family (WF-3620) in [ESC/I variant](#esci-variant-wf-3620). Both are sibling sections, not appendices.

#### TLS on the canonical path

The `esci2-tls` image transfer happens over a TLS 1.2 session that the service initiates outbound to the printer on port 1865. TLS chain validation is disabled, since the printer presents a self-signed certificate and there is no trust chain to validate against. As an opt-in alternative, setting `PRINTER_CERT_FINGERPRINT` pins the peer's SHA-256 fingerprint and aborts the scan at handshake time on mismatch (see [README](../README.md#configure)). Pinning requires `PRINTER_PROTOCOL=esci2` set explicitly. Under `auto` (or either of the non-TLS variants), the combination is rejected at startup because a probe failure could downgrade silently to a non-TLS path and bypass the pin.

#### IS framing (universal across all three variants)

Whether the session runs over TLS (ET-4950 family + ET-2950) or plain TCP (ET-2750, XP-7100, ET-4800, WF-3620), all traffic is wrapped in Epson's proprietary **IS framing**. Every message in both directions is an IS packet:

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

The data-offset field is asymmetric: host-side is always `0x000C` (12); printer-side is always `0x300C` — confirmed across all seven ET-4950 Frida captures and the ET-2750 / XP-7100 / ET-4800 pcaps. The `0x300C` is a printer-firmware constant that the SANE `epsonds` source treats as opaque too. Our builders write `0x000C` on outbound; our parser reads only the type and length fields and ignores offset 4-5 on inbound, so the asymmetry requires no code change.

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
- **Raw parameter bytes** — the `PARA` command's second phase sends the raw scan parameter blob (928–1000 bytes depending on dialect, source, action, and mode) as a separate passthru with no ESC/I-2 header wrapper.

**PARA is sent in two passthru packets**, not one. The first packet carries the 12-byte `PARAx<hex-len>` header with `reply_size=0`. The second carries the raw parameter bytes with `reply_size=64`. The printer acks the first packet with an empty `0xa000` reply, then responds to the second with a 64-byte `PARAx0000000#parOK…` reply if the parameters were accepted (or `#parNG…` if not). This two-phase structure was discovered from the Frida capture: the Windows driver never batches the two sends into a single passthru.

ESC/I-2 command builders are in `src/esci2/commands.ts`. The legacy 2-byte initialization commands (`buildFsY`, `buildFsX`, `buildFsZ`) live in `src/commands-fs.ts` and are shared with the WF-3620 ESC/I path (which uses `buildFsY` for the `DIAGNOSE_PROTOCOL` probe). `buildEsci2Command` builds the generic 12-byte ESC/I-2 header. `buildParaHeader` builds the PARA passthru header; the PARA body is assembled by `composePara` driven by the registry entry and runtime axes (see [How printer-model differences are handled](#how-printer-model-differences-are-handled)). Reply parsing is done by `parseEsci2ReplyHeader` (extracts the 12-byte reply header's `cmd` and `length` fields) and `parseTokens` (splits the `#KEY value` token stream from reply bodies).

The SANE `epsonds` backend provides a useful cross-reference: its passthru framing — IS header layout, `0x000C` data offset, 8-byte data header with `cmd_size` / `reply_size` — is byte-identical to what the ET-4950 expects. However, `epsonds` targets older scanners that do not require the legacy ESC/I initialization loop before ESC/I-2 commands. The ET-4950's firmware requires a legacy preamble (`FS Y` / `FS Z`, then repeated `FS Y → STAT → FIN` polling, then `FS X`) before the scan-parameter and image-transfer half of the session will be accepted.

#### Capability discovery cycles

During the pre-mode-switch init sequence, the driver performs two capability discovery cycles. The first follows the initial `FS Y` ACK and sends `INFO → CAPA → FIN`; the second follows the `FS Z` ACK and sends `INFO → CAPA → RESA → FIN`. (The `@` prefix in the Frida capture naming convention is not a wire prefix — the actual command bytes on the wire are `INFOx0000000` and `CAPAx0000000` in the ESC/I-2 format.) These cycles appear in the Frida captures with consistent counts across all scan scenarios (2 × INFO, 2 × CAPA, 1 × RESA), which suggests they are mandatory initialization steps rather than optional feature queries.

The INFO and CAPA replies declare the scanner's capabilities (supported resolutions, colour modes, document sources, and similar parameters). In a host-initiated pull-scan flow, the way the vendor driver's own UI works, these values would populate a scan dialog. In the push-scan flow implemented here, INFO is consumed and discarded, while CAPA is hashed into a fingerprint that resolves the printer's registry entry (see [How printer-model differences are handled](#how-printer-model-differences-are-handled)). The PARA payload is **not** dynamically constructed from the advertised capabilities; it is assembled by `composePara` from the resolved entry's pinned data (the named gamma / CMX classes, byte-transcribed from that model's capture). This is a deliberate simplification: every supported printer's capabilities are fixed in firmware for the parameters this project uses (colour and JPEG, plus a fixed 300 dpi for panel-driven models; the ADF-only FF-680W takes its scan resolution from `SCAN_RESOLUTION`), so runtime negotiation would only restate what the captures already pin, at the cost of more reverse-engineering work and no change to the end result.

---

## The scanner state machines

The project has two protocol graphs sharing one engine. Each protocol variant lives in a thin orchestration shell that builds a `SessionTransport` and calls the shared `runScanSession` engine in `src/scan-session.ts`. The state machine itself is plain frozen data: a `Graph<Ctx>` defined in a per-protocol `graph.ts` file whose states the engine walks one IS packet at a time. Each transition is either a static rewrite (incoming IS type → next state + bytes to send) or a decision function that inspects the packet payload and returns the same shape. State threading uses a typed ctx object that the engine carries through every transition.

This section walks the **ESC/I-2 graph** in detail, since it covers two of the three variants (`esci2-tls` and `esci2-plain` share it). The legacy ESC/I graph used by the WF-3620 family follows the same engine pattern with a different shape, summarised in [ESC/I variant (WF-3620)](#esci-variant-wf-3620) below.

The shells / graphs / transports map to the variants like so:

| Variant       | Shell entry point       | Graph             | Transport composition                                                                                                                                |
| ------------- | ----------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esci2-tls`   | `runEsci2Scan`          | `src/esci2/graph` | `withEsci2UnlockOnDestroy(withTlsErrorLabels(socketAsTransport(tls.connect(...))))` — see [Transport adapters](#transport-adapters)                  |
| `esci2-plain` | `runEsci2ScanOverPlain` | `src/esci2/graph` | `withEsci2UnlockOnDestroy(socketAsTransport(net.connect(...)))` — same graph, dialect-driven per-state decisions                                     |
| `esci`        | `runEsciScan`           | `src/esci/graph`  | `socketAsTransport(net.connect(...))` — no transport adapters; UNLOCK is sent from the graph's `UNLOCKING` state rather than via a destroy-time hook |

Both ESC/I-2 entry points share the same graph with no transport-conditional branching — the graph starts at the same `WELCOME` state and processes the same IS framing for either path. The difference lives entirely in the scanner shell: it picks the socket factory (`tls.connect` vs `net.connect`) and the transport-adapter composition (TLS-error labels on the TLS path, plain socket otherwise). `ctx.transport: "tls" | "plain"` rides along on the context only so the unknown-fingerprint diagnostic block can report which transport was in use. `ctx.entry` (resolved from the CAPA fingerprint at INIT1 — see [How printer-model differences are handled](#how-printer-model-differences-are-handled)) drives the per-state decisions (source detection, init-poll count, PARA build). The deterministic single-IS-packet-per-transition contract holds for all three.

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
INIT_POLL × dialect.initPollIterations (3 for ET-4950 family + ET-2950 + XP-7100 + ET-4800, 2 for ET-2750):
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

**INIT_POLL iterations.** The iteration count is per-dialect, read from `ctx.entry.initPollIterations` — 3 for the ET-4950 family, ET-2950, XP-7100, and ET-4800; 2 for ET-2750. It is not a per-transport constant: `esci2-plain` spans both counts. (ET-2750's host driver only loops twice before sending FS X — sending a third FS Y after the printer has moved on returns a non-ACK that fails MODE_SWITCH validation.) The captured drivers actually poll many more times — the ET-4950 family and ET-4800 run 11–14 cycles while the printer wakes the feeder — but that count is a driver artifact, not a readiness gate: a fixed small count suffices for an already-active printer, and replay fixtures are trimmed to match (see [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md)). The loop is driven by a counter, not a ready-state signal from the printer — the status values returned by STAT during INIT_POLL are not examined for readiness; they are simply consumed.

**Async events.** At any point during the session, the printer can send an IS `0x9000` async event packet. The ESC/I-2 graph's `globalAbortHandlers` entry for `0x9000` inspects the dispatch byte and returns `null` (info-only) for `0x01` (ScanStart) and `0x04` (Stop), or an `Error` for `0x03` (ScanCancel — cancel) and the fatal set `0x02`/`0x80`/`0xa0` (Disconnect/Timeout/ServerError). The engine settles with `{ ok: false, reason }` on any returned `Error`, regardless of which fatal it was. The handler is registered at the ESC/I-2 graph level — it applies to both ESC/I-2 variants (TLS and plain-TCP) but not to the legacy ESC/I (WF-3620) graph, which does not register a global async handler. In practice, a `0x9000`/`0xa0` ServerError always means the printer rejected a command (typically a malformed PARA or an unexpected command sequence), and the session connection closes within milliseconds of the event.

**IMG loop mechanics.** Each `IMG` command returns a 64-byte metadata envelope whose `IMGx<hex-length>` prefix declares the byte count of the following image data chunk. The scanner issues a pure-read (passthru with `cmd_size=0`, `reply_size=chunk_length`) to pull those bytes, which accumulate into the in-memory JPEG buffer for the current page. Zero-length replies (`IMG x0000000`) indicate the printer is not ready yet — the scanner retries up to 5,000 times before treating it as a timeout (XP-7100 flatbed has been observed sending ~2,600 zero-replies before pixel data starts). When IMG metadata reports a `#pen` token, the current page-side has ended; after the final pixel chunk for that page has been received in the next IMG_DATA step (or, in the zero-length-pen edge case, immediately from IMG_META), the accumulated JPEG buffer is flushed to a `page_NN.jpg` file in the session temp directory.

The IMG loop's termination condition differs by source:

- **ADF**: `#pen` is terminal only if the same reply also contains `#lftd000` ("zero pages left"). A `#pen` without `#lftd000` signals a page boundary — the scanner flushes the current page to the temp directory and continues issuing `IMG` commands for the next page.
- **Flatbed**: any `#pen` is terminal, because the glass holds a single page.

**POSTSCAN drain.** After ADF scans the printer queues a final `#ERRADF PE` (ADF Paper End) status message in its output buffer. If this message is not consumed before the session closes, the printer's internal state machine does not advance cleanly, and the panel displays "Scanning Error" on subsequent scans. The two POSTSCAN cycles (`FS Y → STAT → pure-read(declared length) → FIN`, twice) drain this queued status. The drain consumes the length declared by the STAT reply — 12 bytes (`#ERRADF PE  `) on every captured ADF post-scan, but the implementation reads the declared length verbatim rather than hardcoding 12. The structure mirrors the `INIT_POLL_STAT_DRAIN` mechanism: the printer uses the IS payload-length field as a general signal that the host should issue a drain read before continuing. Flatbed scans do not produce an ADF status message and skip these two POSTSCAN cycles entirely, going directly from `FIN_AFTER_IMG` to `UNLOCKING`.

**Source detection.** The push-scan SOAP body does not indicate whether the printer will scan from the ADF or the flatbed glass — the panel does not expose a source selector. Instead, the printer detects its own source (via the ADF paper sensor) and signals the result in the first `@STAT` reply during INIT_POLL cycle 1. Dialects with `sourceDetection: "stat-length"` (ET-4950 family + XP-7100 + ET-4800) apply this heuristic: an ADF-mode printer returns a zero-length `STATx0000000` reply and a flatbed-mode printer returns a 12-byte `STATx000000C` reply with filler content. The scanner reads this length field and sets `ctx.source`, which governs the PARA blob selection, the IMG loop terminator, and the POSTSCAN branching.

The ET-2750 dialect uses `sourceDetection: "fixed-flatbed"` and skips this heuristic: its STAT reply declares `length=0` in the 12-byte ESC/I-2 header but packs a 52-byte filler (`#---#---#---…`) inline in the same 64-byte IS frame, so applying the stat-length rule would misclassify it as ADF. ET-2750 hardware is flatbed-only — there's no ADF to detect — so the graph trusts the `source: "flatbed"` value the scanner shell pre-sets in `initialCtx`. The `INIT_POLL_STAT` decision is conditioned on `ctx.entry.sourceDetection === "stat-length"` for the override path. ET-2950 is the other `fixed-flatbed` dialect (flatbed-only hardware) and takes the same skip-the-heuristic path.

### Transport adapters

The engine consumes a generic `SessionTransport` interface (`write` / `end(data?)` / `destroy(err?)` / `on`) — both `tls.TLSSocket` and `net.Socket` satisfy it structurally. ESC/I-2 panel hygiene depends on application-level teardown timing that doesn't belong in the engine itself, so the ESC/I-2 path composes the raw socket through two transport-shape adapters before handing it to `runScanSession` (defined in `src/esci2/transport.ts`):

- **`withEsci2UnlockOnDestroy(inner)`** — protocol-aware. Tracks LOCK/UNLOCK on the wire (by IS type byte at offset 2-3); on destroy, if LOCK was sent but UNLOCK wasn't, calls `inner.end(buildUnlockPacket())` so the unlock bytes leave before FIN. Also gates a polite-close `end()` against a follow-up `destroy()` so the engine's settlement doesn't RST the socket mid-`close_notify`.
- **`withTlsErrorLabels(inner)`** — TLS-only. Labels mid-session error events with `"TLS connection error: …"` and swallows benign post-`end()` resets (`ECONNRESET` / `EPIPE` after the printer FINs first).

The TLS factory composes both: `withEsci2UnlockOnDestroy(withTlsErrorLabels(socketAsTransport(socket)))`. The unlock wrapper is OUTER so its destroy-time `inner.end(buildUnlockPacket())` flows through the TLS-error wrapper, setting that wrapper's `endCalled` flag before bytes leave the host. The plain-TCP factory (`esci2-plain`) composes only the unlock adapter — there's no TLS layer to label or to swallow post-FIN resets from.

The WF-3620 ESC/I path uses no transport-shape adapters. It still emits LOCK and UNLOCK packets on the wire (the same `0x2100` / `0x2101` types the ESC/I-2 path uses), but UNLOCK is sent from the graph's `UNLOCKING.onEnter` rather than via a destroy-time hook, so it doesn't need the polite-close gating that `withEsci2UnlockOnDestroy` provides.

---

## Physical-axis handling

### Source: ADF vs flatbed

For dialects with **`sourceDetection: "stat-length"`** (ET-4950 family + XP-7100 + ET-4800), the scanner detects the physical source from the first `@STAT` reply in INIT_POLL cycle 1: declared length `0` → ADF; declared length `12` → flatbed; any other non-zero length falls back to ADF (no other lengths have been observed in practice — the fallback exists for diagnostic resilience). When the declared length is non-zero, those bytes are drained with a pure-read before the next command is sent — the printer queues them as pending output, and failing to drain them desynchronises the IS framing for all subsequent packets.

For dialects with **`sourceDetection: "fixed-flatbed"`** (ET-2750 and ET-2950), the heuristic is skipped entirely — both are flatbed-only hardware. ET-2750 additionally needs the override because its STAT reply declares length `0` (with a 52-byte filler packed inline in the same 64-byte IS frame), so applying the stat-length rule would misclassify it as ADF. The scanner shell pre-sets `source: "flatbed"` in `initialCtx`, and the `INIT_POLL_STAT` decision is gated on `ctx.entry.sourceDetection === "stat-length"` — the override path doesn't run on these dialects and the pre-set value survives.

ADF precedence (dialects with ADF hardware: ET-4950 family + XP-7100 + ET-4800): when the ADF feeder has paper loaded, the printer picks ADF regardless of whether a document is also present on the glass. The INIT_POLL STAT reply returns length 0 in this case. Users who want flatbed must clear the ADF first.

The composed PARA length depends on the dialect (which gamma / CMX classes and optional segments it carries) and the source axis. Actual `composePara` output per registry entry:

| Dialect                     | Transport     | Flatbed | ADF simplex | ADF duplex |
| --------------------------- | ------------- | ------- | ----------- | ---------- |
| ET-4950 / ET-3950 / ET-4956 | `esci2-tls`   | 928 B   | 936 B       | 940 B      |
| ET-2950                     | `esci2-tls`   | 928 B   | —           | —          |
| ET-2750                     | `esci2-plain` | 936 B   | —           | —          |
| XP-7100                     | `esci2-plain` | 944 B   | 952 B       | 956 B      |
| ET-4800                     | `esci2-plain` | 936 B   | 944 B       | —          |
| ET-15000                    | `esci2-plain` | 936 B   | 944 B       | —          |
| FF-680W                     | `esci2-plain` | —       | 996 B       | 1000 B     |
| DS-575W                     | `esci2-plain` | —       | 996 B       | 1000 B     |

The FF-680W is ADF-only — its source is fixed to ADF (it has no flatbed). It reports no panel selection either (it sends a `JobNumberIn` trigger with no Sides/Action), so its sides, output format, and resolution come from `SCAN_SIDES` / `SCAN_FORMAT` / `SCAN_RESOLUTION` rather than the panel. PARA byte-length is DPI-independent (the `#RSM`/`#RSS`/`#ACQ` fields are fixed-width); the values, not the lengths, scale with `SCAN_RESOLUTION`.

The DS-575W is the FF-680W's ADF-only sibling and reuses the same `adf-crp` PARA layout — the sizes above are its **colour** bodies. It adds a colour-mode axis: `SCAN_COLOR_MODE=grayscale` swaps the 804-byte RGB gamma triplet for a 268-byte mono LUT and `#COLC024` for `#COLM008`, giving a 460 B simplex / 464 B greyscale body. The `#ADFCRP` flag bytes (skew / double-feed / duplex) are GUI-only scan options this service doesn't model; the composer pins the FF-680W canonical for them.

(ET-2950 and ET-2750 are flatbed-only hardware; ET-4800 is flatbed + ADF simplex — its `composePara` can emit a 948 B `#ADFDPLX` body, but the simplex-only panel never requests duplex, so that row is `—`. ET-15000 reuses the ET-4800's class data and shares its PARA shape; only the flatbed body is hardware-verified, with the ADF row pending a capture.)

PARA bodies are assembled at run time by `composePara` (`src/esci2/para-composer.ts`) from the resolved registry entry (`src/esci2/dialects/registry.ts`) plus the source / action axes — see [How printer-model differences are handled](#how-printer-model-differences-are-handled). The per-dialect byte data lives in `src/esci2/data/gamma-classes.ts` and `cmx-classes.ts`, each class byte-transcribed verbatim from that model's capture; none of it is hardcoded in `src/esci2/commands.ts` (that file holds only the command / header builders). Dialects differ by more than length: gamma constant (`#GMMUG18` for ET-2750 / XP-7100 / ET-4800 / ET-15000 vs `#GMMUG10` for the ET-4950 family and ET-2950), optional-segment presence (`#QITOFF` / `#CCTCOL`, flagged per entry), and a model-specific inline `#CMXUM08` ICC-matrix block — so no dialect's body can be derived by editing another's.

Within a dialect, the per-source variants differ in three places: the source token (`#FB ` / `#ADF` / `#ADFDPLX`), the `#PAG` page-count token (present for ADF, omitted for flatbed), and the `#ACQ` y-start offset (`0000069` for ADF, `0000000` for flatbed). The remainder — the three RGB gamma tables (`#GMTRED` / `#GMTGRN` / `#GMTBLU`), CMX colour-correction matrix, scan-area extents, and 1 MB buffer-size token — is byte-identical across sources within a dialect. The FF-680W and DS-575W (`adf-crp` profile) are the exception to this structure: their sides axis is the presence of a `DPLX` token inside the `#ADFCRP…DFL1` prefix, and their `#RSM` / `#RSS` / `#ACQ` fields scale with `SCAN_RESOLUTION` rather than being byte-identical across the resolution axis. The DS-575W additionally varies its `#COL` code and gamma LUT with `SCAN_COLOR_MODE`.

### Sides: 1-sided vs 2-sided

The panel's Sides selection is carried in `PushScanIDIn[0]`: `0` = 1-Sided, `1` = 2-Sided. For ADF scans, the scanner threads this as `ctx.duplex`, which `makeParaSpec` folds into the `adf-duplex` source axis passed to `composePara`. Duplex replaces the `#ADF` source token with `#ADFDPLX` (four bytes wider), increasing the composed PARA length by 4 bytes (e.g. 936 → 940 on the ET-4950 family). The rest of the body is identical.

Duplex scans produce image sides in the order front/back/front/back/... The back side of each sheet comes out physically flipped 180° because of the ADF's U-turn paper path — the sheet is pulled through, reversed, and re-fed, so the physical image is upside-down relative to the front side. Back sides are identified by the `#typIMGB` token in their `#pst` / `#pen` responses; front sides carry `#typIMGA`. The graph updates `ctx.pageSide` on every `IMG_META` reply (the `typ` token is consistent across all packets within a page); when the page completes, the engine reads `ctx.pageSide` from the `flushPage` barrier and pushes the 1-based page index into a `backPageIndices: number[]` array. The array is forwarded to `finalizeSession` so the EXIF / `/Rotate` injection path knows which pages need rotation.

For JPEG output, back-side images have a minimal EXIF APP1 segment prepended after the JPEG SOI marker (via `src/exif.ts`) that sets `Orientation = 3` (rotate 180°). This is a 36-byte synthetic APP1 — the minimum valid structure — since the scanner-produced JPEGs contain no EXIF data of their own. For PDF output, the page's PDF dictionary `/Rotate` entry is set to 180° (via `src/pdf.ts` using pdf-lib). Both approaches allow the viewing application to display pages right-side up without modifying the raw pixel data.

Flatbed scans are always single-sided regardless of the `PushScanIDIn[0]` value.

### Action: JPG / PDF / Preview

The panel's Action selection is the second character of `PushScanIDIn`, interpreted as a bitmask: `1` = JPG, `2` = PDF, `4` = Preview on Computer. The service resolves this to an effective action via `resolveEffectiveAction` in `src/pushscan.ts`.

A key protocol finding for the ESC/I-2 path: **the printer always streams JPEG-encoded image data regardless of the panel's Action setting.** PDF is composed host-side with pdf-lib after all pages have been received, so the printer is never told "PDF". The scan-parameter (PARA) bytes are action-invariant for most dialects (ET-4950 family, ET-2750, ET-4800) — the same capture replays for both `action='jpg'` and `action='pdf'`, and the ADF replay tests assert this by reusing one Frida JPG capture across both runs. **XP-7100 is the exception:** its registry entry carries per-action gamma / CMX classes, so it emits different PARA bytes for JPG vs PDF even though the image stream is identical JPEG either way. (The committed JPG and PDF flatbed captures are separate Frida sessions and so differ slightly in capture-time polling cadence, but the protocol structure is the same.)

The ESC/I path (WF-3620) is different: the firmware locks the scan resolution to the panel's format choice (600 DPI for JPG, 300 DPI for PDF), so the wire bytes do differ between the two — see [ESC/I variant (WF-3620)](#esci-variant-wf-3620) below. Composition still happens host-side via pdf-lib in PDF mode, but the underlying pixel stream is captured at the lower resolution.

Preview on Computer (`PushScanIDIn[1] = 4`) is rejected by default (the scan does not proceed). The `PREVIEW_ACTION` environment variable overrides this: setting it to `jpg` or `pdf` redirects preview scans through the normal capture flow.

After `DONE`, the engine calls `transport.end()` to queue the FIN synchronously and then schedules the end-of-scan step via `setImmediate` — it does **not** wait for the socket's `'close'` event (the close handler is a no-op on the DONE path). The `setImmediate` exists to give any in-flight microtasks — notably the previous `flushPage`'s file-write resolving its Promise — a tick to settle before the synchronous finalize step runs:

- `action='jpg'`: `promoteTempPagesToOutput` reads each `page_NN.jpg` from the session temp directory, writes it to `scan_<timestamp>[_NN].jpg` in the output directory (with collision-suffix handling), and unlinks the temp page. Reading + writing rather than `rename` lets temp and output directories live on different filesystems.
- `action='pdf'`: `composePdfFromJpegs` in `src/pdf.ts` embeds each temp JPEG into a pdf-lib `PDFDocument`, applies `/Rotate = 180` on back-side pages, and writes `scan_<timestamp>.pdf`. If composition fails, it falls back to the JPEG promote path.

The temp directory is removed in a `finally` block regardless of outcome.

---

## Protocol probe (three arms)

Three protocol variants ride on port 1865, decided per scan session by `src/protocol-probe.ts`:

1. **TLS handshake** against `1865`. Success → `esci2` (ET-4950 family + ET-2950). The probe socket is destroyed before the real scan begins.
2. **Plain TCP connect**, await an unsolicited IS-`0x8000` welcome packet within the timeout, then disambiguate by the welcome's payload byte 1 (frame offset 13): WF-3620 emits `0x02` here on every committed WF-3620 fixture and is rejected; the `esci2-plain` printers (ET-2750, XP-7100, ET-4800, FF-680W) emit `0x04` and are accepted. Real fixture payloads are `01 02 00 00 00` (WF-3620) and `01 04 00 00 00` (esci2-plain). The ESC/I-2-over-TLS printers (ET-4950 family, ET-2950) also send a welcome immediately, but only inside the TLS tunnel — connecting to one of them over plain TCP yields no `0x8000` and the arm times out. Success → `esci2-plain`.
3. **Plain TCP connect**, send `ESC @` (`1b 40`), await a 1-byte `0x06` ACK. Success → `esci` (WF-3620).

The byte-1 discriminator in arm 2 is the load-bearing piece: a real WF-3620 also sends an unsolicited `0x8000` welcome on plain TCP (a misconception in the original probe design said it stayed silent until prompted), so welcomes alone don't separate the two families. The check is encoded as a negative — accept any `0x8000` whose payload[1] is NOT the WF-3620 byte — because the WF-3620 anchor is well-supported (the byte is `0x02` across every committed WF-3620 fixture) while the ET-2750 anchor has only one capture, so a hypothetical future ET-2750-class device that emits a different byte at payload[1] would still be accepted.

If all three arms fail, the dispatcher resolves to `esci` so the legacy scanner's connect path can surface the underlying socket error in a meaningful way (rather than throwing a generic "no protocol matched" message).

Only `esci2` (TLS) results are cached for the daemon's lifetime. The two non-TLS arms re-probe each scan because plain-TCP probes are cheap and a transient ECONNRESET — which can happen mid-handshake against a real ET-4950 too — shouldn't pin a misclassification.

## ESC/I-2 over plain TCP

Several printers speak the ET-4950's ESC/I-2 vocabulary **without the TLS layer**: ET-2750 (flatbed-only), XP-7100 (flatbed + ADF, simplex and duplex), ET-4800 (flatbed + ADF simplex), ET-15000 (an A3 EcoTank that mirrors the ET-4800's dialect; flatbed hardware-verified, ADF simplex pending a capture); plus the FF-680W (ADF-only FastFoto photo scanner; sides/format/resolution come from config, not the panel). The wire is plain TCP on port 1865; the IS framing, command names, PARA structure, IMG pull loop, and async-event mechanics are otherwise identical to the TLS path. The scanner shell (`runEsci2ScanOverPlain` in `src/esci2/scanner.ts`) shares the protocol graph (`src/esci2/graph.ts`) with the TLS path — the only differences are at the socket factory (`net.connect` instead of `tls.connect`, no cert pinning, no TLS-error label adapter) and the per-dialect decisions the graph reads from the resolved registry entry.

Wire differences from the ET-4950 (decoded from the pcap captures under `tools/pcap-extract/captures/`):

- **No TLS handshake.** The printer sends the welcome IS packet (type `0x8000`) immediately after TCP connect. (Before the real session the driver opens a throwaway connection on 1865 — a rejected TLS probe on XP-7100 / ET-4800 / FF-680W, an aborted SYN/RST on ET-2750 — so each capture holds two `tcp.port==1865` conversations; isolate the real plain-TCP one — see [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md).)
- **INIT_POLL count is per-dialect:** 2 for ET-2750, 3 for XP-7100 and ET-4800, 8 for FF-680W (`ctx.entry.initPollIterations`). For ET-2750, sending a third FS Y after the printer has moved on returns a non-ACK that fails MODE_SWITCH validation.
- **Source detection / STAT.** XP-7100 and ET-4800 use `sourceDetection: "stat-length"` like the ET-4950 family (length 0 → ADF, 12 → flatbed). ET-2750 uses `"fixed-flatbed"`: its STAT reply packs a 52-byte filler inline in a single 64-byte IS frame while the 12-byte header still declares `length=0`, so the stat-length rule would misclassify it as ADF — the graph skips the override and trusts the `source: "flatbed"` value from `initialCtx`. ET-2750 hardware is flatbed-only, so this is correct. The FF-680W uses `sourceDetection: "fixed-adf"` (ADF-only hardware); the graph pins `ctx.source = "adf"` from the registry entry, mirroring ET-2750's `fixed-flatbed` approach in the opposite direction.
- **PARA bodies are dialect-specific** and larger than the ET-4950 family's: 936 B (ET-2750 flatbed); 944 / 952 / 956 B (XP-7100 flatbed / ADF simplex / ADF duplex); 936 / 944 B (ET-4800 flatbed / ADF simplex); 996 / 1000 B (FF-680W ADF simplex / duplex). They carry `#GMMUG18`, per-entry optional-segment flags, and a model-specific inline `#CMXUM08` ICC-matrix block. See the [PARA table above](#source-adf-vs-flatbed).

These dialects are resolved by the same CAPA-fingerprint lookup used by the rest of the ESC/I-2 family. The scanner shell picks the entry point (`runEsci2Scan` for TLS vs `runEsci2ScanOverPlain` for plain TCP) and pre-sets `ctx.transport` in the initial ctx. On the `esci2-plain` transport, config-time validation rejects `ESCI_FORCE_SOURCE` (a legacy-ESC/I-only knob) and `PRINTER_CERT_FINGERPRINT` (no TLS layer to pin) at startup.

## How printer-model differences are handled

Each supported printer family has an entry in `src/esci2/dialects/registry.ts`,
keyed by a sha256 fingerprint over its CAPA reply (`src/esci2/capa-fingerprint.ts`).
Entries are pure data:

- Dispatch metadata (`sourceDetection`, `initPollIterations`).
- Scan extents (`fbExtents`, `adfExtents`) — manually pinned per family.
- A `gmm` constant plus named `gammaClass` and `cmxClass` lookups resolved from
  `src/esci2/data/gamma-classes.ts` and `cmx-classes.ts`. Class definitions are
  inlined verbatim from captured fixtures; never algorithmically generated.
- Optional-segment presence flags (`#QIT`, `#CCT`).

At INIT1_CAPA the graph computes the fingerprint, looks up the entry via
`lookupRegistryEntry`, and stores it on the session context. At PARA build time
the entry plus the runtime source/action axes feed into `makeParaSpec`, and
`composePara` assembles the PARA body.

Printers with an unrecognised CAPA fingerprint fail fast with a copy-pasteable
diagnostic block — no synthesis attempt, no silent quality regression. Adding
support for a new printer is a data-only change in the normal case: capture its
wire bytes, extract any novel gamma/CMX class into the data files, and add a
registry entry. Replay tests (`src/esci2/scanner.test.ts` and per-dialect files
under `src/esci2/dialects/*.test.ts`) pin the composed output byte-for-byte
against the captured fixture.

Legacy ESC/I (WF-3620 family) uses a separate code path under `src/esci/` with
a 64-byte `FS W` parameter block instead of the `PARA` command; none of the
above applies to it.

## ESC/I variant (WF-3620)

The WF-3620 (and other 2014-era Epson printers using the same firmware
generation) speaks **plain TCP on port 1865** with **ESC/I commands**
inside the same IS framing the ET-4950 uses. It's selected by the third
arm of the [protocol probe](#protocol-probe-three-arms): after TLS fails,
the plain-TCP welcome's payload byte 1 identifies the device as
WF-3620-shaped, then sending `ESC @` elicits the 1-byte legacy ACK.

Key wire differences (full table in
`.reference/wireshark-captures/wf-3620/protocol-decode.md`):

- Init is `ESC @` (`1b 40`), not `FS Y`. The printer also emits an
  unsolicited IS-`0x8000` welcome on plain TCP (same as the ET-2750), so
  the auto-probe disambiguates by the welcome's payload byte 1 — see
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

## References

- **SANE `epsonds` backend** (`sane-project/backends`, `backend/epsonds*.{c,h}`) — open-source implementation of the ESC/I-2 scanner protocol for older Epson networked scanners. The IS-frame layout and passthru command structure are compatible with the ET-4950; the initialization sequence and async-event handling differ.
- **ESC/I-2 specification** — not publicly available, but the command names, token formats, and parameter-block structure are corroborated between the SANE `epsonds` backend source code and the Frida capture content.
