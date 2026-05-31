# tools/pcap-extract/captures/et-4800/

Wireshark captures of the official Epson ScanSmart driver scanning to an ET-4800,
contributed by the reporter on issue #80 (May 2026). Reporter's host:
`192.168.27.250`; printer: `192.168.27.230`; transport: ESC/I-2 over plain TCP,
port 1865.

| Fixture             | Source pcapng         | Source      | Format | Source events | Committed events |
| ------------------- | --------------------- | ----------- | ------ | ------------- | ---------------- |
| `flatbed-jpg.jsonl` | `jpeg-flatbed.pcapng` | Flatbed     | JPG    | 8,308         | 8,212            |
| `flatbed-pdf.jsonl` | `pdf-flatbed.pcapng`  | Flatbed     | PDF    | 5,537         | 5,441            |
| `adf-jpg.jsonl`     | `jpeg-adf.pcapng`     | ADF simplex | JPG    | 4,790         | 4,709            |
| `adf-pdf.jsonl`     | `pdf-adf.pcapng`      | ADF simplex | PDF    | 4,794         | 4,713            |

PARA bodies are action-invariant on this printer (JPG and PDF emit byte-identical
PARA; PDF is composed host-side from a `#FMTJPG` scan). Hardware is flatbed + ADF
simplex; no duplex.

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
