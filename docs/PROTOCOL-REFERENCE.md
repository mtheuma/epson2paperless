# Protocol reference

The byte-level reference for the protocols `epson2paperless` speaks. [HOW-IT-WORKS.md](HOW-IT-WORKS.md) has the overview, including the three network channels (discovery, panel trigger, scan session); [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) covers capture methodology and replay fixtures.

The per-model lists live in `src/esci2/dialects/model-overrides.ts` (ESC/I-2), `src/esci/dialects/` (legacy ESC/I) and the [README compatibility table](../README.md#compatible-printers). This document names a model only where it shows a wire-level difference.

## Discovery and keepalive (UDP multicast)

The printer sends an `02 06` announcement to `239.255.255.253:2968` only when it needs a destination list, not on a timer: at power-on, on the panel's manual refresh, and each time Scan > Computer is opened. The panel's destination list is built from whoever answers the latest announcement; no entry outlasts it. (An ET-4956 left idle on its home screen for 11.5 minutes sent none. A capture that once suggested a 60 s cadence had Scan pressed every minute.) An announcement is typically ~80 bytes: the `02 06` magic, a 12-byte header, a service descriptor and a capability list. Header byte 11 is a sequence counter that increments with each announcement.

To get onto the destination list, the service:

1. Joins `239.255.255.253` (`IP_ADD_MEMBERSHIP`) on a UDP socket bound to port 2968.
2. Listens for `02 06` announcements.
3. Answers each with a burst of three unicast `02 07` keepalives to the printer's port 2968, 500 ms apart. Each echoes the announcement's sequence number in byte 11 and carries the destination name, IP address, TCP event port and a destination ID. Byte 11 looks like a key-value count, but a fixed value there is silently ignored ([how that was found](REVERSE-ENGINEERING.md#the-sequence-echo-investigation)).

The printer accepts keepalives only in the ~60 s after an announcement and answers any outside it with ICMP Port Unreachable. A keepalive sent unprompted, or with the wrong sequence number, is ignored and the destination never appears.

### Keepalive format: NetScanMonitor v2 and v3

The announcement ends with a tag list naming the fields it wants back. The keepalive answers those tags in that order and skips any the service doesn't know:

| Version | Tag list (example model)                             | Notes                              |
| ------- | ---------------------------------------------------- | ---------------------------------- |
| v2      | `ClientName,IPAddress,EventPort` (ET-4950)           |                                    |
| v3      | `Ver,ClientName,IPAddress,EventPort,Group` (FF-680W) | Sent from an ephemeral source port |

A tag list that requests `Ver` selects v3. An announcement with no tag list falls back to the announced PID (v3 for the FF-680W and DS-575W, v2 otherwise), as does an FF-680W or DS-575W announcement whose list lacks `Ver`, so those two always get v3. `NETSCAN_VERSION` forces either format.

`src/keepalive.ts` implements it. `parsePrinterAnnouncement` extracts the sequence byte, PID and tag list; `buildKeepalivePacket` assembles the `02 07` reply; `createKeepaliveResponder` owns the socket, the multicast membership and the burst. The printer sends each announcement three times with the same sequence number, so the responder ignores a repeated sequence number for 30 s; otherwise it would send nine keepalives instead of three.

## Panel trigger (TCP, SOAP-ish)

When someone presses Scan with this destination selected, the printer connects to the event port its keepalive advertised (2968) and sends an HTTP POST with a SOAP body. Epson's headers put a space before the colon (`Header : value`), which is invalid HTTP/1.1 and makes a standard HTTP server reject the request, so the service parses requests itself on a raw `net.createServer`.

The request's root element names its kind: `PushScan` (the trigger itself), `JobList` (see [Job control](#job-control-netscanmonitor-v3)) or `ScanEnd`, which is answered OK and nothing more. The service answers HTTP 200 OK, echoing the request's `x-uid` header verbatim and its `x-protocol-version`, then half-closes the connection with a FIN; an RST makes the printer tear down its end aggressively. The printer increments `x-uid` on every trigger and uses it to match the response to the trigger; a response that doesn't echo it makes the panel show "Scanning Error" after the scan, even though the data transfers and the output file is written ([the panel-error investigation](REVERSE-ENGINEERING.md#the-panel-error-investigation)). A trigger that arrives while the scan slot is taken is answered with the protocol `ERROR` status instead, and the panel shows an error.

Once the response is written, the service opens the scan session on the printer's port 1865 ([Scan session variants](#scan-session-variants-on-port-1865)). `src/pushscan.ts` implements the server: `parsePushScanRequest` extracts the SOAP fields and `buildPushScanResponse` builds the reply.

### Panel choices: Sides and Action

The SOAP body's `<PushScanIDIn>` carries the panel's choices, one character each:

| Byte | Field  | Values                                                                 |
| ---- | ------ | ---------------------------------------------------------------------- |
| 0    | Sides  | `0` = 1-Sided (simplex), `1` = 2-Sided (duplex)                        |
| 1    | Action | `1` = JPG, `2` = PDF, `3` = Attach as email, `4` = Preview on Computer |

The Action values are distinct panel options, not bit flags: `3` is not JPG + PDF but the ET-3700's "Attach as email". The panel's action list comes from the printer firmware, not the destination, so a model can offer actions the service doesn't handle. Sides has no meaning on the flatbed, and a flatbed scan ignores byte 0.

Action handling has two stages. `computeActionFromId` decodes the code to `jpg`, `pdf`, `preview` or `unknown` (`3` and any other value). `resolveEffectiveAction` then applies `PREVIEW_ACTION` and returns `jpg`, `pdf` or `null` (no scan). Preview is refused by default, and `PREVIEW_ACTION=jpg` or `pdf` turns it into a real scan. Panels don't always label it Preview: the ET-3700's "User setting" preset sends `4` too. A refused action still gets the 200 OK; no scan session follows, so the printer times out and shows "Communication problem".

Some scanners send no `PushScanIDIn` at all. The button-only FF-680W and DS-575W send a `PushScan` carrying only a `JobNumberIn`, and such a trigger takes its sides and format from `SCAN_SIDES` and `SCAN_FORMAT`. This applies to any v3 trigger without a `PushScanIDIn` (and to the FF-680W and DS-575W whatever version they send); a v2 trigger without one is refused.

### Job control (NetScanMonitor v3)

Two kinds of v3 request (`x-protocol-version : 3.00`) are answered only after a job-control exchange with the printer, on a connection of its own to port 1865. A v3 `PushScan` that carries a `PushScanIDIn`, and a `ScanEnd`, get none.

| Request                           | Step   | Command                  | Reply payload |
| --------------------------------- | ------ | ------------------------ | ------------- |
| `JobList`                         | `JOBW` | A fixed dummy-job record | Empty         |
| `PushScan` with no `PushScanIDIn` | `JOBR` | `JOBR`                   | 8 bytes       |

Each exchange is welcome (`0x8000`) → lock (`0x2100`, 30 s timeout) → lock ack (`0xa100`, `06`) → job packet → job reply (`0xa300`, payload length checked) → unlock (`0x2101`) → unlock ack (`0xa101`). The job packet is IS type `0x2300` carrying the passthru's 8-byte `cmd_size` / `reply_size` header and then the command. Every read times out after 3 s. A failure after the lock still sends the unlock, so the printer isn't left locked against the scan session that opens on the same port moments later.

The connection is always plain TCP, even to a printer whose scan session is TLS. An `esci2` printer sends its welcome only inside TLS, so there the exchange times out waiting for it, as the probe's plain-TCP step does; the failure is logged as a warning and the request is still answered.

The `JobList` response echoes the request's `CapabilityIn` values as `CapabilityOut`. The `PushScan` that follows a `JobList` arrives on a fresh connection (about 0.7 s later on the FF-680W). An admitted `PushScan` holds the scan slot through its `JOBR` round-trip; a `JobList` never takes the slot.

Job control follows the request, not the model: v1 and v2 requests get none, except from the FF-680W and DS-575W, whose job control is confirmed on the wire and runs whatever version they send. For those two a job-control failure is answered with `ERROR`. For any other printer job control is inferred from the request: its first v3 request logs that once, and a failure warns and the scan carries on. `src/job-control.ts` runs the exchanges; `buildPushScanServerOptions` in `src/startup.ts` routes them.

## Scan session variants on port 1865

| Variant       | Transport    | Command set          | Hardware (examples)                         |
| ------------- | ------------ | -------------------- | ------------------------------------------- |
| `esci2`       | TLS over TCP | ESC/I-2 over IS      | ET-4950 family, ET-2950, XP-3200            |
| `esci2-plain` | Plain TCP    | ESC/I-2 over IS      | ET-2750, XP-7100, ET-4800, FF-680W, DS-575W |
| `esci`        | Plain TCP    | Legacy ESC/I over IS | WF-3620 family, XP-620, ET-2550             |

Each variant is named by the `PRINTER_PROTOCOL` value that forces it. The variant is decided per scan session by the transport, not by the dialect: ESC/I-2 model overrides are keyed by model identity, and some are transport-agnostic. The ET-8500 has been reported over both TLS and plain TCP, and the ET-2810 (plain TCP) and XP-3200 (TLS) share one CAPA fingerprint and one model override.

### Protocol probe (two steps)

Under `PRINTER_PROTOCOL=auto`, `src/protocol-probe.ts` picks the variant for each scan session in two steps, neither of which changes printer state:

1. **TLS handshake** on 1865. Success → `esci2`. The probe socket is destroyed before the scan session starts.
2. **Plain TCP connect**, then wait for the unsolicited IS-`0x8000` welcome and classify it by payload byte 1 (frame offset 13): `0x02` → `esci`, anything else → `esci2-plain`. A TLS printer sends its welcome only inside the tunnel, so over plain TCP this step times out (inconclusive).

Both protocol generations send a welcome on plain TCP, so its presence means only "plain TCP". Byte 1 is what separates them:

| payload[1] | Variant       | Models (committed fixtures)                 |
| ---------- | ------------- | ------------------------------------------- |
| `0x02`     | `esci`        | WF-3620, XP-620, and the ESC/I-2 ET-7700    |
| `0x04`     | `esci2-plain` | ET-2750, XP-7100, ET-4800, FF-680W, DS-575W |

Real welcome payloads are `01 02 00 00 00` and `01 04 00 00 00`; the XP-620's is byte-identical to the WF-3620's. What the byte means is unknown, so it is treated as an observed family marker, and any value other than `0x02` classifies as `esci2-plain`.

**The ET-7700 exception.** The ET-7700 speaks ESC/I-2 but welcomes with the WF-3620's exact bytes, so `0x02` alone isn't a reliable legacy ESC/I marker. Once the TLS step fails, the probe looks up the panel trigger's PID (`ProductNameIn`, normalised for case and padding) in `ESCI2_PLAIN_WITH_LEGACY_WELCOME`, currently only the ET-7700's `PID 112B` (issue #145, verified from the reporter's push-scan SOAP). A match selects `esci2-plain` and skips the welcome step, which carries no signal for these models. The PID names the exact model, whose dialect is hardware-validated, so it outranks the ambiguous welcome byte. The PID never overrides a successful TLS step. A host trigger (`scan:now` or the webhook) has no PID, so ET-7700 users need `PRINTER_PROTOCOL=esci2-plain` there.

If neither step classifies, the dispatcher falls back to `esci`, so the legacy ESC/I scanner's connect path reports the underlying socket error rather than a generic "no protocol matched". A PID in the ET-7700 set never reaches that fallback, so an unreachable ET-7700's socket error comes from the scanner it actually speaks.

The probe has no third step sending a bare `ESC @`. Real printers accept only IS-framed commands, and only after a lock: in both the WF-3620 and XP-620 captures every host write begins with the `IS` magic, and `ESC @` appears only inside a `0x2000` passthru after `IS 2100`. Such a step could never classify a real printer, and would only add a wasted round-trip and a misleading error before the fallback answered `esci` anyway.

Only the TLS result is cached for the daemon's lifetime. The plain-TCP step re-probes every session: it is cheap, and a transient ECONNRESET (possible mid-handshake on a real ET-4950 too) shouldn't pin a misclassification.

### TLS and certificate pinning

The `esci2` session is TLS 1.2, opened by the service. Chain validation is off because the printer presents a self-signed certificate. `PRINTER_CERT_FINGERPRINT` pins its SHA-256 fingerprint instead and aborts the scan at handshake on a mismatch (see [README](../README.md#configure)). Pinning needs `PRINTER_PROTOCOL=esci2` set explicitly. It is rejected at startup with `auto`, where a failed probe could silently downgrade to a non-TLS path and bypass the pin, and with either plain-TCP variant.

## IS framing and passthru

Every scan-session message, in both directions and on all three variants, is an IS packet:

```
Offset  Len  Field
──────  ───  ─────
  0      2   ASCII magic "IS"
  2      2   Packet type (big-endian uint16)
  4      2   Data offset (host-side: 0x000C; printer-side: 0x300C or 0x380C)
  6      4   Payload size (big-endian uint32)
 10      2   Padding (zeros)
 12      N   Payload
```

The data offset is asymmetric. The host always writes `0x000C`. Printers send `0x300C` in every committed capture except the FF-680W's and DS-575W's, which carry `0x380C` in every frame. It is a printer-firmware constant, which the SANE `epsonds` source also treats as opaque. The parser reads only the type and length and ignores bytes 4–5, so the variation needs no code.

| Type     | Direction      | Meaning                                                     | Used by      |
| -------- | -------------- | ----------------------------------------------------------- | ------------ |
| `0x8000` | Printer → host | Welcome, the first packet on a fresh connection             | All          |
| `0x9000` | Printer → host | Async event                                                 | ESC/I-2      |
| `0xa000` | Printer → host | Passthru reply                                              | All          |
| `0xa100` | Printer → host | Lock ack                                                    | All          |
| `0xa101` | Printer → host | Unlock ack                                                  | All          |
| `0xa200` | Printer → host | Unsolicited image-stream chunk                              | Legacy ESC/I |
| `0xa300` | Printer → host | Job-control reply                                           | Job control  |
| `0x2000` | Host → printer | Passthru command (sends a command, declares the reply size) | All          |
| `0x2100` | Host → printer | Lock request                                                | All          |
| `0x2101` | Host → printer | Unlock request                                              | All          |
| `0x2200` | Host → printer | Stream config                                               | Legacy ESC/I |
| `0x2300` | Host → printer | Job-control command                                         | Job control  |

An async event (`0x9000`) carries one dispatch byte. The ESC/I-2 graph handles it in every state through its `globalAbortHandlers`; the legacy ESC/I graph registers no handler.

| Byte   | Event       | ESC/I-2 session     |
| ------ | ----------- | ------------------- |
| `0x01` | ScanStart   | Ignored, carries on |
| `0x04` | Stop        | Ignored, carries on |
| `0x03` | ScanCancel  | Fails               |
| `0x02` | Disconnect  | Fails               |
| `0x80` | Timeout     | Fails               |
| `0xa0` | ServerError | Fails               |

Any other byte is ignored too. A failing event settles the session with `{ ok: false, reason }`, whichever it was. A ServerError means the printer rejected the last command (typically a malformed PARA or an unexpected command order) and has torn down the session. The connection closes within milliseconds and there is no recovery.

`src/protocol.ts` parses and builds IS packets. `parseIsPacket` reads one packet from a `Buffer` and returns `null` until the declared payload has arrived, so the scanner buffers incoming data and retries after each TCP segment. `buildLockPacket` and `buildUnlockPacket` build the `0x2100` / `0x2101` packets; the lock payload is 7 bytes, `01 a0 04` and a big-endian u32 timeout.

### Passthru

A `0x2000` passthru payload starts with an 8-byte data header:

```
Offset  Len  Field
──────  ───  ─────
  0      4   Command size (big-endian uint32) — bytes that follow
  4      4   Expected reply size (big-endian uint32)
  8      N   Command bytes
```

`buildPassthruPacket` sends a command with a non-zero `cmd_size`. `buildPurereadPacket` sets `cmd_size=0` and only a `reply_size`, which asks for the next N bytes of the printer's output queue without sending a command; the IMG loop uses it to fetch image data.

The command bytes are one of:

- **Legacy ESC/I**, 2-byte binary: `FS Y` (`1c 59`), `FS X` (`1c 58`), `FS Z` (`1c 5a`). ESC/I-2 printers use these to open the session before the mode switch.
- **ESC/I-2**, a 12-byte ASCII header `NAMEx0000000`: a 4-character command name, space-padded, and the 7-hex-digit length of the parameter block that follows. Commands include `STAT`, `FIN `, `TRDT`, `IMG ` and `PARA`.
- **Raw parameter bytes**: the PARA body, sent as a passthru of its own with no header ([PARA body](#para-body)).

The ESC/I-2 builders are in `src/esci2/commands.ts`: `buildEsci2Command` for the generic header and `buildParaHeader` for PARA's. The legacy ESC/I `buildFsY` / `buildFsX` / `buildFsZ` live in `src/commands-fs.ts`, shared with the legacy ESC/I path, which uses `buildFsY` for its `DIAGNOSE_PROTOCOL` probe. Replies are parsed by `parseEsci2ReplyHeader` (the 12-byte header's name and length, then the [reply-header block](#reply-header-block)) and `parseTokens` (the `#KEY value` token stream in reply bodies).

The SANE `epsonds` backend's passthru framing (IS header, `0x000C` offset, `cmd_size` / `reply_size` header) is byte-identical to the ET-4950's. Its scanners don't need the legacy ESC/I preamble the ET-4950 requires before it accepts ESC/I-2 scan commands: `FS Y` / `FS Z`, then repeated `FS Y → STAT → FIN`, then `FS X`.

## ESC/I-2 scan session

Both ESC/I-2 variants run one graph, `esci2Graph` in `src/esci2/graph.ts`. The engine, `runScanSession` in `src/scan-session.ts`, walks a frozen `Graph<Ctx>` one IS packet at a time and carries a typed context through every transition. A transition is either static (incoming IS type → next state and bytes to send) or a decision function that inspects the payload and returns the same shape. The legacy ESC/I graph uses the same engine with its own states ([Legacy ESC/I scan session](#legacy-esci-scan-session)).

A thin shell per variant builds the transport and calls the engine:

| Variant       | Shell                   | Graph             | Transport                                                                             |
| ------------- | ----------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `esci2`       | `runEsci2Scan`          | `src/esci2/graph` | `withEsci2UnlockOnDestroy(withTlsErrorLabels(socketAsTransport(tls.connect(...))))`   |
| `esci2-plain` | `runEsci2ScanOverPlain` | `src/esci2/graph` | `withEsci2UnlockOnDestroy(socketAsTransport(net.connect(...)))`                       |
| `esci`        | `runEsciScan`           | `src/esci/graph`  | `socketAsTransport(net.connect(...))`; the graph's `UNLOCKING` state sends the unlock |

The ESC/I-2 graph has no transport branching: the shell chooses the socket and the [transport adapters](#transport-adapters). `ctx.transport` (`"tls" | "plain"`) rides along only so the unknown-model diagnostic can name the transport. `ctx.entry`, the dialect resolved by model identity at INIT1 ([How printer-model differences are handled](#how-printer-model-differences-are-handled)), drives the per-state decisions: source detection, the init-poll count and the PARA body.

### State machine

```
CONNECTING
    │  TLS handshake (esci2) or plain TCP connect (esci2-plain)
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
INIT2_RESA       ← send RESA, drain declared body unread
INIT2_FIN        ← send FIN, await 64-byte reply
    │
INIT_POLL × ctx.entry.initPollIterations:
  INIT_POLL_FS_Y        ← send FS Y, await ACK
  INIT_POLL_STAT        ← send STAT, await 64-byte envelope
  INIT_POLL_STAT_DRAIN  ← drain N bytes, unread, if STAT reply declares length > 0
  INIT_POLL_FIN         ← send FIN, await 64-byte reply
    │
MODE_SWITCH      ← send FS X (mode switch to ESC/I-2), await 1-byte ACK
    │
POST_MODE_STAT        ← send STAT, await 64-byte reply: the status before PARA
POST_MODE_STAT_DRAIN  ← drain N bytes if declared
    │
PARA             ← send PARA phase-1 header + phase-2 payload, await #parOK
TRDT             ← send TRDT (transition to data transfer), await reply
    │
IMG loop:
  IMG_META       ← send IMG, await 64-byte metadata reply (contains chunk length)
  IMG_DATA       ← send pure-read(chunk_length), receive image bytes
  (repeat until terminal #pen)
    │
FIN_AFTER_IMG    ← send FIN, await reply
    │
  ┌─ source=ADF ──────────────────────────────────────────┐
  │  POSTSCAN × 2:                                        │
  │    POSTSCAN_FS_Y   ← send FS Y, await ACK             │
  │    POSTSCAN_STAT   ← send STAT, await reply           │
  │    POSTSCAN_DRAIN  ← pure-read(declared length)       │
  │    POSTSCAN_FIN    ← send FIN, await reply            │
  └───────────────────────────────────────────────────────┘
  (flatbed skips POSTSCAN)
    │
UNLOCKING        ← send Unlock (IS 0x2101), await IS 0xa101 ack
    │
DONE             ← compose/promote output files, then resolve
```

### Init and capability cycles

Before the mode switch the session runs two capability cycles: `INFO → CAPA → FIN` after the first `FS Y` ACK, and `INFO → CAPA → RESA → FIN` after the `FS Z` ACK. The Frida captures show the same counts (2 × INFO, 2 × CAPA, 1 × RESA) in every scan scenario, so they look like mandatory initialization rather than optional queries. The `@` prefix in Frida capture names is not on the wire: the commands are `INFOx0000000` and `CAPAx0000000`.

INFO and CAPA describe the scanner: resolutions, colour modes, sources and the like. The session uses them to resolve the model ([How printer-model differences are handled](#how-printer-model-differences-are-handled)), to derive the capability fields, and to choose the wire resolution and JPEG quality ([Scan resolution and JPEG quality](#scan-resolution-and-jpeg-quality)). Colour (the gamma and CMX classes, `gmm`) is not negotiated but taken from the dialect's pinned data, transcribed from that model's capture. Every supported printer's colour parameters are fixed in firmware for what this project needs, so negotiating them would only restate what the captures pin, at the cost of more reverse-engineering work and no change to the result. Resolution is the exception because a single fixed DPI doesn't serve every use the way a fixed colour curve does.

**Init poll.** The session then runs `FS Y → STAT → FIN` up to `ctx.entry.initPollIterations` times: 3 for most dialects, 2 for the ET-2750, 8 for the FF-680W, 12 for the DS-575W. The count isn't tied to the transport, and it is a counter, not a readiness check: the STAT replies are drained unread. After at least one good cycle, a non-ACK to `FS Y` ends the poll early with a warning carrying the reply bytes, and if the mode switch or PARA then fails, the error names that non-ACK as the likely cause. A non-ACK on the first cycle fails the session. This is defensive: no capture shows a printer refusing `FS Y` mid-poll, and none shows what the ET-2750 does with a third `FS Y`.

Epson captures poll for longer (11–14 cycles on the ET-4950 family and ET-4800, while the printer wakes the feeder), but that count isn't a readiness gate. A few cycles suffice for an awake printer, and the replay fixtures are trimmed to match.

### The status before PARA

The last `STAT` reply before PARA (POST_MODE_STAT, after the mode switch, read together with its drained body) is the scanner's state at scan time. The session parses it once and reads, in order, its reply-header block, the source and any status errors. The init poll's replies are drained unread, and nothing reads `ctx.source` before this state.

#### Reply-header block

Every ESC/I-2 reply frame is 64 bytes: the 12-byte `<NAME>x<length>` header, then a 52-byte reply-header block of the reply's own tokens (`#parOK`, `#pen`, `#typIMGA`, …) padded with `#---` filler. A zero-length `STATx0000000` reply is header and filler only. `parseEsci2ReplyHeader` reads two signals from the block, which the status before PARA and every `IMG` reply (IMG_META) act on:

| Token                                      | Meaning                      | Status before PARA | `IMG` reply |
| ------------------------------------------ | ---------------------------- | ------------------ | ----------- |
| `#nrd BUSY`, `#nrd WUP`                    | Busy, warming up             | Wait (below)       | Ignored     |
| `#nrd RSVD`                                | Reserved by another client   | Stop               | Stop        |
| `#nrd AFEN`                                | User authentication required | Stop               | Stop        |
| `#err`, a unit and a code (`#errADF PJ  `) | Header-level error           | Stop               | Stop        |

A stop names the cause, e.g. `POST_MODE_STAT: the printer reported an error (ADF PJ) — clear it on the printer and scan again`. On `BUSY` or `WUP` the session drains any body unread, asks again every 100 ms, and reads the source and errors only from the first ready reply, logging one debug line per wait and per change of code. The wait's deadline is `ESCI2_TIMEOUT_MS`, counted from the first busy reply, since the per-reply timeout restarts on every answer. Past it the scan stops with `Timeout in state POST_MODE_STAT — still waiting after 60000ms: the printer reports it is busy (BUSY)`.

Lowercase `#err` is the header token. Uppercase `#ERR` tokens are status errors (below), judged as such even when a printer puts them inline in the block; an `IMG` reply carrying one stops the session, whatever its unit. No replay fixture's block carries `#nrd` or `#err`.

#### Source

The panel has no source selector and the push-scan request doesn't name one, so the printer detects its own source with the ADF paper sensor and reports it. How the session reads it depends on the sources INFO advertises (`sourceDetection`, derived for every session):

- **Both a flatbed and an ADF** (`pre-para-status`; among recorded models the ET-4950 family, XP-7100, ET-4800, ET-15000 and WF-3835): the reply's content decides. `#ERRADF PE` ("ADF paper empty") → flatbed. Anything else, no error or any other ADF code (which reads as a document in the feeder), → ADF. A loaded feeder wins over a document on the glass, and its reply carries no error, so to scan the flatbed the user must clear the ADF. On every recorded session the flatbed reply is the 12-byte `#ERRADF PE  ` (`STATx000000C`) and the ADF reply is a zero-length `STATx0000000`, so content and declared length agree on the fixtures. A non-zero declared length must be drained with a pure-read before the next command, or the IS framing desyncs.
- **One source** (`fixed-flatbed` / `fixed-adf`): `ctx.source` is pinned at INIT1 and the reply never changes it. The ET-2750 depends on this: with no ADF, its status reply is header and filler only, which a content read would take for ADF. The other flatbed-only models (ET-2950, ET-2810 / XP-3200, ET-8500, ET-7700) take the same path, and the ADF-only FF-680W and DS-575W are `fixed-adf`.

`ctx.source` governs the PARA body, the IMG loop's end condition and POSTSCAN. On every replay fixture the first status and the status before PARA give the same source. Only the DS-575W duplex capture differs between them (its first statuses report `ADF PE`, which clears by the status before PARA), and that printer is ADF-only.

#### Status errors

Each `#ERR` token is a 4-character unit (`ADF`, `FB`, `TPU`) and a code. The session keeps one code per unit, the last the reply gives, so `#ERRADF PE  #ERRADF PJ  ` is a jammed ADF.

- An error whose unit is the source being scanned ends the session before PARA, naming it: `POST_MODE_STAT_DRAIN: the printer reported an error before scanning (ADF PJ)`.
- An error on any other unit warns once per process per model and set of codes (repeats go to `debug`), and the scan carries on.
- `ADF PE` on a flatbed scan is a state, not a fault, and isn't reported.

No code is always fatal and none is exempt. An ADF-only printer stops on `ADF PE` when its feeder is still empty just before PARA, while on a printer with both sources an empty feeder can't stop a scan, because `ADF PE` makes the flatbed the source. Every replay fixture's status before PARA is clear for its source: empty on ADF sessions, `ADF PE` alone on flatbed ones. Only the status reply is judged; the `#ERR` tokens some printers (FF-680W, DS-575W) put in their `CAPA` and `RESA` replies list error codes, not errors the printer is reporting now.

### IMG loop

Each `IMG` returns a 64-byte metadata reply whose `IMGx<hex-length>` header gives the size of the next image chunk, and a pure-read (`reply_size=chunk_length`) pulls that chunk into the current page's JPEG buffer. A zero-length reply (`IMG x0000000`) means the printer isn't ready yet; the session retries up to 5,000 times before timing out. The XP-7100 flatbed has sent about 2,600 before pixel data started.

`#pen` in the metadata ends the current page. Once the page's final chunk arrives in the next IMG_DATA (or at once from IMG_META when that reply declares no chunk), the buffer is flushed to `page_NN.jpg` in the session temp directory. Whether `#pen` also ends the scan depends on the source:

- **ADF:** only when the same reply carries `#lftd000` (no pages left). Otherwise it's a page boundary, and the loop carries on with the next page.
- **Flatbed:** always, since the glass holds one page.

A page's side comes from the `#typIMGA` (front) or `#typIMGB` (back) token in its `#pst` / `#pen` replies; the graph updates `ctx.pageSide` on every IMG_META reply ([Duplex back pages](#duplex-back-pages)).

### POSTSCAN drain

After an ADF scan the printer queues a final `#ERRADF PE` (ADF paper end) status. Left unread when the session closes, it stops the printer's own state machine advancing cleanly, and the panel shows "Scanning Error" on later scans. Two POSTSCAN cycles (`FS Y → STAT → pure-read → FIN`) drain it, each reading the length its STAT reply declares rather than a fixed 12 bytes, though every captured ADF post-scan declares 12 (`#ERRADF PE  `). As with the init poll's drain, a non-zero IS payload length tells the host to drain before continuing. A flatbed scan queues no status and goes straight from FIN_AFTER_IMG to UNLOCKING.

### Transport adapters

The engine takes a generic `SessionTransport` (`write` / `end(data?)` / `destroy(err?)` / `on`), which `tls.TLSSocket` and `net.Socket` both satisfy. Teardown timing that keeps the panel clean doesn't belong in the engine, so the ESC/I-2 shells wrap the socket in adapters from `src/esci2/transport.ts`:

- **`withEsci2UnlockOnDestroy(inner)`** tracks LOCK and UNLOCK on the wire by IS type (bytes 2–3). On a destroy after a LOCK with no UNLOCK, it calls `inner.end(buildUnlockPacket())` so the unlock leaves before the FIN. It also stops a `destroy()` that follows a polite `end()` from resetting the socket mid-`close_notify`.
- **`withTlsErrorLabels(inner)`** (TLS only) labels mid-session errors `"TLS connection error: …"` and swallows the benign `ECONNRESET` / `EPIPE` that follow `end()` when the printer FINs first.

The unlock adapter is the outer one, so its destroy-time `end()` passes through the TLS adapter and sets that adapter's `endCalled` flag before the bytes leave. The plain-TCP shell uses only the unlock adapter. The legacy ESC/I path uses neither: it still sends LOCK and UNLOCK, but its graph sends UNLOCK from `UNLOCKING.onEnter`, so it needs no destroy-time hook or polite-close gating.

### ESC/I-2 over plain TCP

Most models added since the ET-4950 speak ESC/I-2 without TLS, from flatbed-only (ET-2750, ET-7700) through flatbed + ADF (XP-7100, ET-4800) to ADF-only (FF-680W, DS-575W). `runEsci2ScanOverPlain` (`src/esci2/scanner.ts`) runs the same graph, so the IS framing, commands, PARA structure, IMG loop and async events are as above. The differences:

- The shell uses `net.connect` with no TLS adapter, and the printer sends its welcome straight after the TCP connect. `PRINTER_CERT_FINGERPRINT` has nothing to pin and is rejected at startup.
- Epson's software opens a throwaway connection on 1865 before the real session (a rejected TLS probe on the XP-7100, ET-4800, FF-680W and DS-575W; an aborted SYN/RST on the ET-2750), so each capture holds two `tcp.port==1865` conversations and the real one must be [isolated with `--stream`](REVERSE-ENGINEERING.md#extract-a-fixture).
- The per-dialect data (poll count, source policy, PARA body) varies more widely than across the TLS models; see [Per-model PARA sizes](#per-model-para-sizes).

## How printer-model differences are handled

Each supported ESC/I-2 model has a model override in `src/esci2/dialects/model-overrides.ts`. Overrides are pure data, holding only what the printer's replies can't tell us:

- **Identity keys** (`pids`, `names`, `capaFingerprints`): the product IDs the models report in their INFO `#PRD` reply, the product names the FF-680W and DS-575W report there instead, and sha256 fingerprints of their CAPA replies (`src/esci2/capa-fingerprint.ts`). A model whose PID isn't known yet (ET-3950, XP-4100) resolves through the fingerprint it shares with a sibling.
- **The init-poll count** (`initPollIterations`).
- **Scan windows** (`fbExtents`, `adfExtents`): the captured paper size at `windowDpi` (300 unless set; 200 for the `adf-crp` scanners), or `"generic"` to inherit the [generic scan window](#the-generic-dialect). An override keeps its own window only where the generic one differs from it at some advertised DPI on some source: the ET-2750 (2477×3500), XP-7100 (Letter), FF-680W (long page) and DS-575W (the generic window is clipped at 75 DPI, where its own scales one pixel past the scan area). A session whose derived PARA profile reads a pinned window at another reference DPI rescales it first.
- **Colour**: a `gmm` constant and named `gammaClass` / `cmxClass` entries from `src/esci2/data/gamma-classes.ts` and `cmx-classes.ts`, each transcribed verbatim from a captured fixture and never generated. (`identity-um08` names the `et2750-um08` bytes, the identity matrix, for a record that should say so: the ET-8500 and ET-7700 overrides and the generic dialect.) Each class is tagged neutral or Epson-look (a CMX class by whether it is the identity matrix), and `checkColourPair` (`src/esci2/data/colour-pair.ts`) rejects a mixed pair; a test holds every override to it.
- **`provenance`**: the evidence for the colour pair, scan window and poll count, each a list of an Epson capture, an own capture of this service's traffic, a reporter's measured compatibility-page scan, a reporter's qualitative report, or inheritance from another model, linked to an issue, PR or committed fixture. It has no runtime effect. `src/esci2/dialects/provenance.test.ts` holds it to the README: every ✅ model is served by an override (a model sharing another's needs a report of its own); its colour evidence includes an Epson capture or reporter scan or report that vouched for its current colour bytes, by hash, so changing the colour fails until new evidence is recorded; and its window and poll count aren't inherited only.

Three optional fields are covered where they act: `monoGammaClass` ([PARA layout](#layout)), `verifiedWireDpis` ([Scan resolution and JPEG quality](#verifiedwiredpis-and-the-explicit-only-warning)) and `duplexOrientationEvidence` ([Duplex back pages](#duplex-back-pages)).

### Capability-derived fields

Five fields are never on an override. Every session, model override or generic dialect alike, derives them from the printer's own INFO and CAPA replies (`capabilityFields` in `src/esci2/derivation.ts`):

| Field                    | Derived as                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `#QIT` / `#CCT` segments | Sent when `#QITLIST` lists `OFF` / `#CCTLIST` lists `COL`, the values the composer sends                                                |
| ADF duplex               | `#ADFDPLX` in CAPA and an ADF scan area in INFO. An `adf-duplex` PARA for a printer without it is refused before it is sent             |
| PARA profile             | `adf-crp` when CAPA lists `#ADFCRP` and INFO has no flatbed scan area, else standard                                                    |
| Source detection         | Read from the status before PARA when INFO advertises both scan areas, else fixed to the one source                                     |
| Back-page rotation       | Duplex back pages turned 180° when the ADF is duplex and INFO reports it two-pass (`#ADFDPLX2SCN`), else left as the printer sends them |

### Resolving the dialect

At INIT1_CAPA the graph computes the CAPA fingerprint, calls `resolveDialect` (product ID, then product name, then fingerprint) and stores the result on the session context. INFO is read before CAPA, so model identity is available on every trigger path, host triggers included.

A product ID or name hit whose fingerprint isn't one of the override's (as after a firmware update that changes the CAPA reply) warns with the diagnostic block and proceeds with that override. Such a printer keeps each of the override's own scan windows only while it still fits the scan area INFO reports (the long-paper maximum for `adf-crp`); one that doesn't is replaced by the generic window, with a warning. A matching fingerprint skips this check.

At PARA build time `makeParaSpec` combines the dialect with the runtime source and action, and `composePara` assembles the body ([PARA body](#para-body)).

### The generic dialect

A printer whose product ID, product name and CAPA fingerprint are all unrecognised runs the generic dialect (`src/esci2/dialects/generic.ts`), built at INIT1 from its own replies. The session warns ("not recognised — untested, running the generic ESC/I-2 dialect, please report") and logs the diagnostic block at `info`. The generic dialect is:

- the capability-derived fields above (`deriveCapabilities`), plus the sources;
- the neutral pair: the `et4950-stock` tone curve with the identity UM08 matrix, in `UG18` (or `UG10` if that's all `#GMMLIST` offers). A printer whose `#CMXLIST` lacks `UM08` is sent SoC-style (`UG10`, no `#CMX`) on the standard PARA profile, failing if `UG10` isn't listed; an `adf-crp` printer fails, since that profile always carries a matrix;
- the generic scan window, computed per wire DPI: A4 at 300 DPI placed by the `ALGN` rule, scaled to the wire DPI, then clipped to the scan area (`adf-crp`: the full ADF area at 200 DPI). Clipping last keeps every DPI inside the area;
- a poll count of 3 with a flatbed, 12 ADF-only (for timing parity with Epson captures only);
- the same [source detection and status errors](#the-status-before-para) as every printer.

It has no verified DPIs and no greyscale on the wire (pages convert on the host). When the replies lack something it can't do without (a usable scan area, a parseable CAPA, the `JPG` format, a `UG18` or `UG10` gamma mode), the session fails fast with the reason and the diagnostic block.

### Adding a printer

In the normal case this is a data-only change: capture its wire bytes, extract any novel gamma or CMX class into the data files, and add a model override. A novel gamma class also gets a `GAMMA_CLASS_LOOK` tag: neutral if it was captured beside an identity matrix (or none), Epson-look if beside the model's own matrix. The override's composed colour pairs must pass `checkColourPair` (`src/esci2/data/colour-pair.test.ts`), and its provenance records the capture they came from. Replay tests (`src/esci2/scanner.test.ts` and `src/esci2/dialects/*.test.ts`) pin the composed output byte-for-byte against the fixture.

None of this applies to legacy ESC/I, whose 64-byte `FS W` block takes PARA's place and whose [legacy dialects](#legacy-dialects) are resolved by push-scan PID.

## PARA body

PARA is sent in two passthru packets: the 12-byte `PARAx<hex-len>` header with `reply_size=0`, then the raw body with `reply_size=64`. The printer acks the first with an empty `0xa000` reply and answers the second with a 64-byte `PARAx0000000#parOK…` reply, or `#parNG…` if it rejects the body ([PARA rejection](#para-rejection)). Epson captures never send the two in one passthru.

### Layout

`composePara` (`src/esci2/para-composer.ts`) assembles the body at run time from the resolved dialect plus the source, sides, action, colour-mode, resolution and JPEG-quality axes. The byte data lives in `src/esci2/data/gamma-classes.ts` and `cmx-classes.ts`; `src/esci2/commands.ts` holds only the command and header builders.

Dialects differ in the gamma constant (`#GMMUG10` for the ET-4950 family and ET-2950, `#GMMUG18` for every other override), in the optional `#QITOFF` / `#CCTCOL` segments (sent when CAPA lists them), and in a model-specific inline `#CMXUM08` matrix block, so no dialect's body can be derived by editing another's.

Within a dialect, the standard profile's source variants differ in up to three places, two of them fixed:

| Field             | Flatbed | ADF simplex | ADF duplex            |
| ----------------- | ------- | ----------- | --------------------- |
| Source token      | `#FB `  | `#ADF`      | `#ADFDPLX` (+4 bytes) |
| `#PAG` page count | Absent  | Present     | Present               |

The third is the `#ACQ` scan window, the dialect's window for that source, so whether it differs is per model. On the ET-4950 family the ADF window starts at x `0000069` where the flatbed's starts at `0000000`; the XP-7100's windows are identical, both at x 0. Everything else is identical across sources: the three RGB gamma tables (`#GMTRED` / `#GMTGRN` / `#GMTBLU`), the CMX matrix, the 1 MB buffer-size token, and the `#RSM` / `#RSS` resolution fields, which scale with the wire resolution on every dialect ([Scan resolution and JPEG quality](#scan-resolution-and-jpeg-quality)) along with the window. Duplex comes from Sides: the session threads `PushScanIDIn[0]` as `ctx.duplex`, which `makeParaSpec` folds into the `adf-duplex` source axis.

The `adf-crp` profile (FF-680W, DS-575W) has no per-source token. Its sides axis is a `DPLX` token inside the `#ADFCRP…DFL1` prefix. The `#ADFCRP` flag bytes (skew, double-feed, duplex) are GUI-only scan options the service doesn't model, so the composer pins the FF-680W's values.

**Action.** The printer streams JPEG whatever the panel's Action, and PDF is composed on the host, so the printer is never told "PDF". The body is action-invariant on most dialects (ET-4950 family, ET-2750, ET-4800), and the ADF replay tests reuse one Frida JPG capture for both `action='jpg'` and `action='pdf'`. The XP-7100 is the exception: its override carries per-action gamma and CMX classes, so its PARA differs between JPG and PDF even though its image stream doesn't. (The committed flatbed JPG and PDF captures are separate Frida sessions, so they differ slightly in polling cadence, but not in structure.)

**Colour mode.** `SCAN_COLOR_MODE=grayscale` reaches the wire only on an override with a `monoGammaClass`, currently the DS-575W: it swaps the 804-byte RGB gamma triplet for a 268-byte greyscale LUT and `#COLC024` for `#COLM008`. Everywhere else, and under `SCAN_COLOR_MODE=auto` on every model, the body is the colour one and pages convert on the host.

### Per-model PARA sizes

PARA length depends on the dialect and the source, not on DPI: `#RSM`, `#RSS` and `#ACQ` are fixed-width, so their values scale with resolution and their lengths don't. `composePara` output per model override, as pinned by `src/esci2/dialects/*.test.ts` and `src/esci2/scanner.test.ts`:

| Dialect                     | Transport | Flatbed | ADF simplex         | ADF duplex           |
| --------------------------- | --------- | ------- | ------------------- | -------------------- |
| ET-4950 / ET-3950 / ET-4956 | TLS       | 928 B   | 936 B               | 940 B                |
| ET-2950                     | TLS       | 928 B   | —                   | —                    |
| ET-2750                     | plain TCP | 936 B   | —                   | —                    |
| XP-7100                     | plain TCP | 944 B   | 952 B               | 956 B                |
| ET-4800                     | plain TCP | 936 B   | 944 B               | —                    |
| ET-15000                    | plain TCP | 936 B   | 944 B               | —                    |
| FF-680W                     | plain TCP | —       | 996 B               | 1000 B               |
| DS-575W                     | plain TCP | —       | 996 B (grey: 460 B) | 1000 B (grey: 464 B) |
| ET-2810 / XP-3200           | either†   | 936 B   | —                   | —                    |
| ET-8500                     | either†   | 944 B   | —                   | —                    |
| ET-7700                     | plain TCP | 944 B   | —                   | —                    |
| WF-3835                     | plain TCP | 944 B   | 952 B               | —                    |

† Keyed by model identity, not transport: the ET-2810 presents over plain TCP and its fingerprint-sharing XP-3200 sibling over TLS, and the ET-8500 has been reported over both.

A dash is hardware without that source or sides. The ET-2950, ET-2750, ET-2810 / XP-3200, ET-8500 and ET-7700 are flatbed-only. The ET-4800 and WF-3835 are flatbed + ADF simplex: the ET-4800's composer can emit a 948 B `#ADFDPLX` body, but its panel never requests duplex, and the WF-3835's CAPA reports `duplex: N`. The ET-15000 reuses the ET-4800's class data and PARA shape.

## Scan resolution and JPEG quality

`SCAN_RESOLUTION` (50–1200 DPI, optional) and `JPEG_QUALITY` (1–100, default 90) are validated once in `src/config.ts`. On ESC/I-2 both are resolved per session against what the printer's CAPA reply advertises. On legacy ESC/I neither can be chosen per scan ([below](#legacy-esci-fallback-only)).

### CAPA-advertised resolution and quality lists

`parseCapaTokens` (`src/esci2/capabilities.ts`) parses five CAPA segments into `CapaTokens`:

| Segment                         | Field                        | Meaning                                   |
| ------------------------------- | ---------------------------- | ----------------------------------------- |
| `#RSMLIST` / `#RSSLIST`         | `rsmList` / `rssList`        | Main-scan and sub-scan resolution lists   |
| `#ADFRSMSLIST` / `#FB RSMSLIST` | `adfRsmsList` / `fbRsmsList` | Per-source resolution lists               |
| `#JPGRANG`                      | `jpgRange.{min,max}`         | JPEG quality range accepted in `#JPGdNNN` |

A list can mix Epson's two numeric encodings in one segment, 3-digit `dNNN` and 7-digit `iNNNNNNN` (the ET-4950's own `#RSMLIST` does), so `parseNumericList` matches both with one regex.

### Selection rule: the source list is a cap, not an allowed-set

`advertisedDpiSet` (`src/esci2/resolution.ts`) computes the DPIs a scan may request on the wire for its source. The base set is `rsmList ∩ rssList` when both are advertised, or whichever one is. When the source's own list (`adfRsmsList` for ADF, `fbRsmsList` for flatbed) is present too, its maximum caps that set; the source list itself is never treated as the set of allowed values. With neither global list advertised there is nothing to cap, and the source list becomes the allowed set directly.

The captures prove the distinction. The FF-680W and DS-575W advertise `#ADFRSMSLISTd300d600` (300 and 600 only), yet scan at 200 DPI (FF-680W) and 400 DPI (DS-575W). Read as the allowed set, the list would reject both. Read as a ceiling on `rsmList ∩ rssList`, it reproduces them and still enforces each source's real limit: the ET-4950's ADF tops out at 600 DPI where its flatbed reaches 1200, on the same firmware.

`selectWireDpi` then resolves the target resolution against that set:

1. **Exact match:** requested on the wire.
2. **A higher value is advertised:** the smallest advertised value above the target goes on the wire, and the pages are [downsampled on the host](#host-side-downsample). It never upscales.
3. **Target above every advertised value:** the wire request is capped at the advertised maximum, with an info log naming both DPIs.

A printer that advertises no lists at all gets a one-element set, its PARA profile's pinned default (300 DPI standard, 200 DPI `adf-crp`), so a target still goes through the same selection instead of being silently discarded.

### Scan-window scaling from the override reference DPI

A model override's own `fbExtents` / `adfExtents` are pinned at its PARA profile's reference DPI: `STANDARD_BASE_DPI` (300) or `ADF_CRP_BASE_DPI` (200, the FF-680W and DS-575W). An inherited `"generic"` window isn't scaled, because it is computed at the wire DPI. `composePara` scales the `#RSM` / `#RSS` fields and the `#ACQ` window by `resolution / referenceDpi`:

- **Standard profile:** all four `#ACQ` fields, offsets included; an unscaled ET-4950 ADF `x0=69` would shift the crop at any DPI but 300. It scales the window's edges (near edge rounded, far edge floored) and derives width and height from them, because rounding offset and size independently can overshoot. The ET-4950 ADF window spans the full advertised 8.5 in area (`69 + 2481 = 2550` at 300 DPI); at 150 DPI independent rounding (`35 + 1241 = 1276`) lands one pixel past the 1275-px edge, which the firmware rejects with `#parFAIL` (ET-4956, hardware-verified).
- **`adf-crp` profile:** width and height only; `x0` / `y0` pass through unscaled. Every `adf-crp` override's origin is `0,0`, so the difference doesn't show on the wire today, but the two profiles' rules genuinely differ.

### JPEG quality on the wire

`JPEG_QUALITY` drives the ESC/I-2 `#JPGdNNN` segment, clamped to `jpgRange` when the printer advertises one. Host-side encodes (finalize, `POST_PROCESS=document`, downsample) always use the unclamped value. The default 90 gives `#JPGd090`, the bytes every committed replay fixture carries. Legacy ESC/I has no such segment, so there `JPEG_QUALITY` affects only the host encode.

### `verifiedWireDpis` and the explicit-only warning

Each ESC/I-2 model override lists `verifiedWireDpis`: the wire DPIs backed by a committed replay fixture or a documented hardware report (a README compatibility row or a linked issue). When an explicit `SCAN_RESOLUTION` resolves to a wire DPI outside that list, `buildParaSend` logs one warning inviting a report on issue #81, and the scan proceeds. A model's own default DPI never warns, even when it isn't listed: only an explicit `SCAN_RESOLUTION` is something the user can act on by filing a report.

### PARA rejection

Any `#par` reply other than `OK` fails the `PARA` state, with no automatic retry at another DPI. When the wire DPI is outside the model's `verifiedWireDpis`, whether it came from an explicit `SCAN_RESOLUTION` or the dialect's own unverified default, the error names that DPI and suggests unsetting `SCAN_RESOLUTION` (if it was set) or reporting the outcome on issue #81.

### Legacy ESC/I: fallback-only

The legacy ESC/I path (WF-3620 family, XP-620, ET-2550) has no resolution choice on the wire, because DPI × format × dialect was never captured across the board. Its resolution-dependent values are derived (the lines per block from the raster width, the stream config from the printer's `FS G` reply; see [Block layout](#block-layout-fs-w-fs-g-and-the-stream-config)), but each dialect's raster is its fixed captured geometry, so the wire bytes don't change with `SCAN_RESOLUTION`. `LegacyDialectEntry.deliveredDpi` pins each dialect's wire resolution: 600 DPI for WF-3620 JPG and 300 for PDF (the firmware ties it to the panel's Action), and 300 for the XP-620 and ET-2550. A target below the wire resolution is downsampled on the host at finalize, as on ESC/I-2. At or above it the wire resolution is used as-is, with an info log when the target is strictly above.

### Host-side downsample

`downsampleJpeg` (`src/postprocess/downsample.ts`) serves both paths whenever the wire can't reach the target. It sizes each axis independently, `Math.round(px * toDpi / fromDpi)`, rather than deriving one from the other's rounded value, which at a ratio like 300→50 DPI (1/6) would be a row off: a 2481×3506 page must become 414×584, not 414×585. It stamps the new DPI into the JFIF density and re-applies the source page's EXIF orientation (duplex back pages carry `Orientation=3`). It runs inside whichever re-encode `POST_PROCESS=document` or the host-side greyscale conversion already performs, rather than adding a decode and encode of its own. It only downsamples, and throws if asked to upscale, which the selection rule never does.

## Legacy ESC/I scan session

The WF-3620, and other 2014-era Epson printers of the same firmware generation, speak legacy ESC/I over plain TCP on port 1865, inside the same IS framing. The probe's plain-TCP step selects it by the welcome's payload byte 1 (`0x02`).

Two more models speak distinct dialects of the same command family. Both have the same framing and a byte-identical welcome, and both are flatbed-only with a fixed raster:

- **XP-620** (issue #124): a different setup and teardown, run through its own state group.
- **ET-2550** (issue #166): the WF-3620's flatbed path with both `ESC e` source-select pairs removed, since a printer with no ADF is never sent one. That is why the WF-3620 settings NAK at `SOURCE_ACK2` on it.

The WF-3620's wire, compared with ESC/I-2:

- Init is `ESC @` (`1b 40`) rather than `FS Y`, sent inside a `0x2000` passthru after the lock. Like the ESC/I-2 plain-TCP models, the printer sends an unsolicited `0x8000` welcome first.
- Source select is `ESC e <byte>` (0 = flatbed, 1 = ADF simplex, 2 = ADF duplex) before scan setup, and the same byte goes at offset 26 of the `FS W` block. There is no PARA.
- Scan parameters are a 64-byte little-endian binary block after `FS W`.
- Pixels arrive as raw 24-bit GBR (each pixel `[G, B, R]`; the host permutes them to RGB before sharp encodes them) in unsolicited IS-`0xa200` chunks, at 600 DPI for JPG and 300 DPI for PDF. The firmware ties the resolution to the panel's Action, so JPG and PDF sessions differ on the wire; PDF is still composed on the host.
- The host ends each ADF page with a `0x0c 0x00` page-eject. Duplex runs two cycles per sheet, and back pages come out rotated 180° ([Duplex back pages](#duplex-back-pages)).

The graph is `src/esci/graph.ts`, run by `runEsciScan` in `src/esci/scanner.ts`. A page's raw pixels are held in memory (about 104 MB at 600 DPI A4), encoded to JPEG with sharp (`src/esci/raw-to-jpeg.ts`) and handed to the shared [finalize step](#finalize).

### Block layout: FS W, FS G and the stream config

The printer streams a page as fixed-size blocks plus one shorter last block. Three messages describe that layout, and they agree on every legacy ESC/I capture:

- **`FS W` byte 28: lines per block** (`linesPerBlock`), the scanlines in each full block. It is the largest even count, at most 254, whose rows (width × 3 bytes) fit the model's transfer buffer: 64 KiB on the WF-3620 and ET-2550, 256 KiB on the XP-620. That gives 4 for WF-3620 JPG (600 DPI), 8 for WF-3620 PDF (300 DPI) and the ET-2550, and 34 (`0x22`) for the XP-620, where 35 rows fit. `FS W` goes out before `FS G`, so the value comes from the geometry, not the printer. Lines per block × width × 3 bytes is the block size.
- **The 14-byte `FS G` reply** (`parseFsGReply`, little-endian): bytes 0–1 are a status word; 2–5 `chunkSize`, one full block's bytes (zero means not ready yet; see [Multi-page termination](#multi-page-termination)); 6–9 `blockCount`, the number of full blocks; 10–13 `lastBlockBytes`, the bytes of the lines left over. `blockCount × chunkSize + lastBlockBytes` is the page's raw size: WF-3620 JPG is 1750 blocks of 4 lines plus a last block of 2 (7002 lines), PDF 437 of 8 plus 5 (3501). Each block arrives as one `0xa200` chunk with one trailing status byte, so a page is `blockCount + 1` chunks.
- **The 38-byte IS-`0x2200` stream config** (`buildStreamConfigPayload`, big-endian), sent after the `FS G` reply, restates the layout: the block count at bytes 8–11; the block size + 1 (for its status byte) at 16–19 and again at 24–27, followed by a `0x06` terminator at 28; and the last block's bytes + 1 at 33–36, followed by `0x06` at 37. The rest is constant: the sub-payload length 30 at bytes 0–3, and `1` at 20–23 and 29–32.

Every dialect builds its stream config from the `FS G` reply alone and writes the derived lines per block into its `FS W` block.

### Legacy dialects

One legacy ESC/I graph serves all three models. It reads the per-model decisions from a legacy dialect, a `LegacyDialectEntry` (`src/esci/dialects/entry.ts`):

|                             | WF-3620                               | XP-620                                     | ET-2550                                 |
| --------------------------- | ------------------------------------- | ------------------------------------------ | --------------------------------------- |
| Entry                       | `WF3620_ENTRY`                        | `XP620_ENTRY`                              | `ET2550_ENTRY`                          |
| PID                         | `PID 08B8`, and the fallback          | `PID 08C8`                                 | `PID 1106`                              |
| `sourcePolicy`              | `"detect"`                            | `"fixed-flatbed"`                          | `"detect"` (finds no ADF)               |
| Setup, at `LOCKING`         | `ESC @` → `INIT`                      | `ESC I` → `XP_IDENT_A_META`                | `ESC @` → `INIT`                        |
| Pre-start, at `WINDOW_DATA` | `"status-then-start"`                 | `"start-direct"`                           | `"start-direct"`                        |
| Flatbed teardown            | `FS F` → `POST_STATUS`                | `ESC @` → `XP_TEARDOWN_INIT`               | `ESC )` → `ET_TEARDOWN_PAREN`           |
| Raster                      | From source and format (`geometry()`) | Fixed: 300 DPI A4, 2481×3507 px            | Fixed: 300 DPI full glass, 2550×3509 px |
| `FS W` block                | `buildFsWBlock()`                     | Captured block, lines per block written in | WF-3620 layout at its raster            |
| Transfer buffer             | 64 KiB                                | 256 KiB                                    | 64 KiB                                  |
| Wire resolution             | 600 DPI (JPG) / 300 DPI (PDF)         | 300 DPI                                    | 300 DPI                                 |

Each entry also carries its gamma LUTs (`gamma`), and `raster()`, `transferBufferBytes` and `fswBlock()`, the last given the lines per block that `fsWBlockFor` works out from the raster width and the buffer. The WF-3620's versions compute from the requested source and format (`geometry()` and `buildFsWBlock()` in `src/esci/commands.ts`). Only one ET-2550 mode (300 DPI) has been captured; its data in `src/esci/dialects/et2550-data.ts` is generated from the committed fixture rather than hand-transcribed, and its `FS W` block is the same for the capture's JPG and PDF scans. The XP-620's raster and block are transcribed byte-for-byte from its capture into `src/esci/dialects/xp620-data.ts`; the block differs from the WF-3620 layout in a few constant bytes, so the dialect keeps the captured block and writes only the lines per block into it. The stream config isn't per-dialect: the graph builds it from each `FS G` reply.

**Branch points.** `setup` and `teardown` are `Branch<S>` records, `{ next, send }` pairs naming the state to jump to and the command to send on entry. Three graph points read `ctx.entry`, all but setup after the identity check below, so they see any dialect it switched to:

- **Setup** (`LOCKING`): after the lock ack, the graph jumps to `ctx.entry.setup.next` and sends `ctx.entry.setup.send()`.
- **Pre-start** (`WINDOW_DATA`): after the `FS W` block is acked, `"status-then-start"` sends one more `FS F` status round-trip before `FS G`, and `"start-direct"` sends `FS G` at once (the XP-620 and ET-2550 captures skip the prescan status check).
- **Teardown** (`makeFlushTransition`'s flatbed branch; ADF pages always take the page-eject loop, which is dialect-independent): after the last flatbed page flushes. The WF-3620's `POST_STATUS` is the ordinary cleanup cycle. The ET-2550's bare `ESC )` gets a 1-byte `0x80` reply rather than an ACK, and no unlock packet follows, as on the XP-620 ([XP-620 setup and teardown](#xp-620-setup-and-teardown)). Both dialect teardown states are in `cleanupStates`, so a connection drop during teardown still finalizes a page that has already flushed. `POST_STATUS` deliberately isn't, since its `FS F` can still carry a real transfer-end error.

**Choosing the dialect.** `resolveLegacyEntry(productName)` (`src/esci/dialects/registry.ts`) matches the push-scan `ProductNameIn` (parsed by `parsePushScanRequest`, passed through `dispatchScanSession` as `productName`) against each dialect's literal PID string. Any other PID, or the `null` a host trigger passes (`scan:now` in `src/scan-now.ts`, or the webhook; neither has a panel to read a PID from), falls back to `WF3620_ENTRY`, which makes the WF-3620 settings the de facto generic legacy dialect. That is only where the session starts: the identity check can hand it to the printer's own dialect, which is how a host trigger reaches the ET-2550 dialect. The XP-620 dialect is reachable only from a panel trigger (daemon or `npm run scan`). The WF-3620's `PID 08B8` comes from its `FS I` reply; no captured WF-3620 trigger shows its `ProductNameIn`, and the fallback covers it either way.

**Identity check.** The session's first `FS I` reply names the printer: an 80-byte reply with a 16-byte product field at offset 46 (the PIDs above) and a 4-byte firmware field at offset 62. `parseFsIReply` decodes it and `checkLegacyIdentity` compares it with the running dialect:

| Outcome      | When                                                                                                                                                                                                                                            | Effect                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Match        | The printer reports the dialect's own PID                                                                                                                                                                                                       | The usual debug `Dialect resolved` line                                                          |
| Unrecognised | No dialect claims the PID, and the session is on the WF-3620 fallback                                                                                                                                                                           | Warns that an older ESC/I model is untested and trying the WF-3620 settings, asking for a report |
| Switch       | The session is on the WF-3620 fallback, another dialect claims the PID, and that dialect's setup branch is the fallback's (same `setup.next` state, same first command)                                                                         | `ctx.entry` becomes that dialect, with an info line naming both                                  |
| Mismatch     | Another dialect claims the PID but the session is on a PID-keyed dialect (the trigger's PID chose it, and `FS I` doesn't overrule that) or its setup diverged before `FS I`; or the session's PID-keyed dialect isn't the one the printer names | Warns, and the session carries on with `ctx.entry`                                               |

A switch is safe because every byte sent up to that `FS I` is what the adopted dialect would have sent, and the source state carries over unchanged: the adopted dialect's setup also enters `INIT`, so the first `FS F` reply still settles the source. Today a switch is a PID-less trigger reaching an ET-2550, since both it and the WF-3620 open with `ESC @` into `INIT`. Under `scan:now` an XP-620 lands on Mismatch at best: it gets the WF-3620's `ESC @` setup instead of its own `ESC I`, and no capture shows whether that even reaches `FS I`.

Because the PID is read in-session, the check works on host triggers too. Bytes outside printable ASCII in either field are logged as `\xNN`, and a reply that isn't 80 bytes fails the session with the whole reply in hex.

### Source selection

`sourcePolicy: "fixed-flatbed"` (the XP-620) skips all of this. `runEsciScan` starts the session on `initialSource`'s pin (`ctx.source = "flatbed"`, `ctx.sourceDetected = true`, `ctx.adfInstalled = false`) before the graph runs, and the dialect's setup jumps straight into its own group and on to gamma, never reaching the states below. `registry.test.ts` holds that only a dialect whose setup bypasses `INIT` may be `"fixed-flatbed"`.

Under `"detect"` (WF-3620, ET-2550) the session's `FS F` replies settle the source. The first (`STATUS_1A`) says whether an ADF is fitted: byte 1, bit 7 (`fsFAdfInstalled`), set on every WF-3620 reply, flatbed scans included, and clear on the ET-2550 and XP-620. With no ADF the source is the flatbed and no `ESC e` is sent. With one, the session probes with `ESC e 0x01` and reads the following `FS F` status byte:

| `FS F` status byte | Source                                        |
| ------------------ | --------------------------------------------- |
| `0x81`             | `flatbed`                                     |
| `0x01`             | `adf-simplex` or `adf-duplex`, by panel Sides |

The ET-2550's captured sequence is the WF-3620 flatbed path with both `ESC e` + parameter pairs removed, so three shared states branch on the ADF flag rather than the dialect getting its own state group or source rule:

| State        | ADF fitted (WF-3620)                     | No ADF (ET-2550)            |
| ------------ | ---------------------------------------- | --------------------------- |
| `STATUS_1B`  | `ESC e` + `0x01` probe → `SOURCE_ACK1`   | `FS F` → `STATUS_2`         |
| `STATUS_2`   | byte-0 detection; `0x81` → reset cycle   | reset cycle unconditionally |
| `RESET_INIT` | `ESC e` + source byte → `RESET_SRC_ACK1` | `FS F` → `STATUS_READY`     |

`STATUS_2` must skip detection rather than ignore its result: the ET-2550 reports `0x01` there, never the WF-3620's `0x81`, and `legacyDetectSource` reads `0x01` as an ADF. Byte 0's high bit is not the ADF flag.

`ESCI_FORCE_SOURCE` (`flatbed`, `adf-simplex` or `adf-duplex`; legacy ESC/I only, rejected with either ESC/I-2 variant) overrides the detected source for printers whose status byte hasn't been captured yet. A printer with no ADF can't serve a forced ADF source, so the scan stops with a descriptive error instead of desyncing mid-session: on the XP-620 `runEsciScan` (`src/esci/scanner.ts`) rejects it before connecting (`unsupportedForcedSource` in `src/esci/graph.ts`), and on any other printer `STATUS_1A` stops the session when the first `FS F` reply says no ADF is fitted, before any source command is sent.

### XP-620 setup and teardown

The XP-620's setup group (states `XP_IDENT_A_META` through `GAMMA_CMD` in `src/esci/graph.ts`) reproduces the handshake in its capture:

1. **`ESC I`** (`1b 49`) and **`ESC i`** (`1b 69`): two-phase identity reads, like the ESC/I-2 `_META` / `_DATA` pattern. Each gets a 4-byte reply (`02 02` and a little-endian u16 length) followed by a pure-read of that length. The lengths are pinned to the captured values, 19 bytes for `ESC I` and 40 for `ESC i`, and a different length fails fast.
2. **`FS I`**, the usual single-phase 80-byte identity read shared with the WF-3620, followed by the first of three `FS F` status polls.
3. **`ESC @`**, the standard init, then **`ESC 0xe2`** (`1b e2`), an XP-620-only command. Its reply may be `0x06` (ACK) or `0x15` (NAK); the capture proceeds identically either way, so the graph treats both as success. The second `FS F` poll follows.
4. **`ESC (`** and the third `FS F` poll, then the shared gamma phase: three `ESC z` + 256-byte LUT cycles, the same shape as the WF-3620's.

`FS W` → `FS G` then starts the scan directly, with no prescan `FS F` (`prestart: "start-direct"`).

After the image transfer, the teardown group (`XP_TEARDOWN_INIT` through `XP_TEARDOWN_PAREN`) is `ESC @` → `ESC e` + `0x00` → `ESC )`. The printer closes the connection right after the `ESC )` reply, with no `0xa101` unlock ack, so the graph resolves straight to `DONE` instead of going through `UNLOCKING`. The ET-2550 ends the same way after its bare `ESC )`: of the three legacy dialects, only the WF-3620 unlocks.

`src/esci/scanner.test.ts` replays the XP-620 flatbed fixture (`tools/pcap-extract/captures/xp-620/flatbed.jsonl`) byte-for-byte for both JPG and PDF output, alongside the WF-3620 fixtures.

### Multi-page termination

ADF only, so the XP-620 never enters it. After each page-eject the host polls `FS F`, and byte 0 of the 16-byte reply decides: `0x01` means the ADF still has paper (loop back through gamma, window and start for the next page), and `0x81` means it is empty (go on to cleanup). One path covers any page count; 3-sheet simplex, 4-sheet duplex and 1-sheet duplex all run it.

The first `FS G` of an ADF session sometimes returns `chunkSize = 0` because the printer is still pulling paper from the tray. `START_POLL` then polls `FS F` until byte 0 is `0x01`, `START_POLL_READY` sends one more `FS F` to confirm, and `FS G` is re-issued. The `adf-4-page-duplex-pdf` capture shows this pattern.

## Output

### Duplex back pages

Duplex pages arrive in the order front, back, front, back. On a two-pass ADF (ET-4950 family, XP-7100) each back page comes out upside-down relative to its front, because the U-turn paper path pulls the sheet through, reverses it and feeds it again. A single-pass ADF (DS-575W, FF-680W) reads both sides at once and sends the back the same way up as the front. That is confirmed on hardware for the DS-575W in issue #128, where blanket compensation inverted its back pages, and for the FF-680W in issue #249.

On ESC/I-2 the printer's INFO duplex type decides, every session (`duplexBackRotated`: `#ADFDPLX2SCN`, two-pass, rotates; `1SCN`, single-pass, or no duplex, doesn't), resolved by the engine at flush time. A model override records what confirmed its orientation, and which way (`duplexOrientationEvidence`). A duplex scan on a model without that record, or whose record vouched for the other orientation, any printer on the generic dialect included, logs one warning per process naming the choice made and inviting a report. The legacy ESC/I WF-3620's back pages are rotated too.

When a page completes, the engine reads the side the graph set on its `flushPage` barrier. The ESC/I-2 graph takes it from `ctx.pageSide`, set by the `#typIMGB` token (the same on every packet of a page); the legacy ESC/I graph marks every second page of an `adf-duplex` scan as a back page. The engine pushes back pages' 1-based indices into `backPageIndices`, except under an ESC/I-2 dialect with `duplexBackRotated: false`, whose pages are never recorded. `finalizeSession` uses the list to turn those pages without re-encoding pixels:

- **JPG:** `src/exif.ts` inserts a 36-byte synthetic EXIF APP1 segment after the SOI marker with `Orientation = 3` (rotate 180°). It is the minimum valid structure; the printer's JPEGs carry no EXIF of their own.
- **PDF:** `src/pdf.ts` sets the page's `/Rotate` entry to 180 with pdf-lib.

### Finalize

After `DONE` the engine calls `transport.end()` to queue the FIN, then schedules the end-of-scan step with `setImmediate`. It does not wait for the socket's `'close'` event (the close handler is a no-op on the DONE path). The `setImmediate` gives in-flight microtasks, notably the last `flushPage`'s file write, a tick to settle before the synchronous finalize runs. `finalizeSession` (`src/output-tail.ts`) then writes the output:

- `action='jpg'`: `promoteTempPagesToOutput` reads each `page_NN.jpg` from the session temp directory, writes it to `scan_<timestamp>[_NN].jpg` in the output directory (adding a suffix on a name collision) and unlinks the temp page. Reading and writing rather than `rename` lets the temp and output directories sit on different filesystems.
- `action='pdf'`: `composePdfFromJpegs` (`src/pdf.ts`) embeds each temp JPEG in a pdf-lib `PDFDocument`, sets `/Rotate = 180` on back pages and writes `scan_<timestamp>.pdf`. If composition fails it falls back to the JPG path.

The temp directory is removed in a `finally` block whatever the outcome.

### Page density

A legacy ESC/I page is encoded on the host from raw RGB, so its JPEG would carry no density of its own, and a JPEG with no density reads as 72 DPI. That means the wrong physical size in viewers, a `document` re-encode that inherits and rewrites the 72, and a PDF page box four times too large once `composePdfFromJpegs` sizes pages from the density (issue #221). `encodeRawGbrToJpeg` therefore stamps the wire resolution into the JFIF header at encode (a lossless header patch), and every later pass inherits it; a host-side downsample stamps its own target. ESC/I-2 pages need no stamp, because every captured model writes its own JFIF density: 300 DPI on the ET-4950 family, 200/300 on the FF-680W, 400/600 on the DS-575W.

## References

- **SANE `epsonds` backend** (`sane-project/backends`, `backend/epsonds*.{c,h}`): an open-source implementation of the ESC/I-2 protocol for older Epson network scanners. Its IS framing and passthru structure match the ET-4950's; its initialization sequence and async-event handling differ.
- **ESC/I-2 specification:** not publicly available. The command names, token formats and parameter-block structure here are corroborated by the SANE `epsonds` source and the Frida captures.
