# tools/pcap-extract/captures/et-4800/

Wireshark captures of the official Epson ScanSmart driver scanning to an ET-4800,
contributed by the reporter on issue #80 (May 2026). Reporter's host:
`192.168.27.250`; printer: `192.168.27.230`; transport: ESC/I-2 over plain TCP,
port 1865.

| Fixture             | Source pcapng         | Source      | Format | tcp.stream | Source events | Committed events |
| ------------------- | --------------------- | ----------- | ------ | ---------- | ------------- | ---------------- |
| `flatbed-jpg.jsonl` | `jpeg-flatbed.pcapng` | Flatbed     | JPG    | 11         | 8,306         | 8,210            |
| `flatbed-pdf.jsonl` | `pdf-flatbed.pcapng`  | Flatbed     | PDF    | 12         | 5,535         | 5,439            |
| `adf-jpg.jsonl`     | `jpeg-adf.pcapng`     | ADF simplex | JPG    | 7          | 4,788         | 4,707            |
| `adf-pdf.jsonl`     | `pdf-adf.pcapng`      | ADF simplex | PDF    | 10         | 4,792         | 4,711            |

PARA bodies are action-invariant on this printer (JPG and PDF emit byte-identical
PARA; PDF is composed host-side from a `#FMTJPG` scan). Hardware is flatbed + ADF
simplex; no duplex.

## Stream selection

The ET-4800 driver first opens a short TLS probe on port 1865, which the printer
rejects (it has no TLS), then reopens a second plain-TCP connection for the real
session. Each pcap therefore contains two `tcp.port==1865` conversations: an
8-frame TLS-probe stream and the multi-thousand-frame plain-TCP scan stream.
Extract with `--stream <N>` (the plain-TCP stream per the table above) so the
TLS-probe bytes — a leading ClientHello plus a stray `0x8000` welcome from the
doomed socket — don't get concatenated ahead of the real session. Without the
filter the fixture would carry the welcome twice and a leading TLS record, neither
of which the scanner sees against real hardware (it opens one plain-TCP socket and
receives a single welcome, same as the ET-4950 / ET-2750 references).

## Init-poll trim

The driver runs a poll-until-ready `FS Y → STAT → FIN` loop before switching to
extended mode — 11 cycles (flatbed) / 12 cycles (ADF) in the raw captures. Our
scanner does a fixed 3 (`initPollIterations: 3`, the ET-4950 recipe), so the
committed fixtures are trimmed to the first 3 STAT cycles, cutting at FS Y cycle
boundaries and resuming at FS X. This keeps the replay aligned with the scanner
(`driveFixture` feeds every `p>h` event regardless of what the scanner emits, so
the fixture's cycle count must match the scanner's). The leading STAT cycle is
preserved, so the `stat-length` source-detection signal survives the trim
(flatbed first STAT = 12 bytes, ADF first STAT = 0 bytes). This mirrors
`trimStatCycles(raw, 3)` used by the ET-4950 Frida replay, applied here at
fixture-generation time for the pcap-extract `{dir, hex}` shape.

CAPA fingerprint: `7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2`

Source `.pcapng` files are gitignored under `.reference/wireshark-captures/et-4800/`.
