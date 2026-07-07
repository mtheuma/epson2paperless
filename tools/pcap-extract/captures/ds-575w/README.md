# tools/pcap-extract/captures/ds-575w/

Wireshark capture of Epson's own scan software scanning to a DS-575W, contributed
by **@EliSauder** for [issue #128](https://github.com/mtheuma/epson2paperless/issues/128)
(DS-575W support), received 2026-07-07. Captured against Epson's software, not
epson2paperless. Contributor's host: `192.168.11.167`; printer: `192.168.11.202`;
transport: ESC/I-2 over plain TCP, port 1865.

The DS-575W is an ADF-only, button-only sheet-fed scanner — a sibling of the
FF-680W (announces PID `0169`; FF-680W is `016B`). No flatbed. Sides
(1-sided / 2-sided), resolution, and colour mode are software settings chosen at
scan time. The one contributed capture is a 2-sided (duplex) 600-DPI grayscale
scan to JPG; the wire format is JPG (two images per sheet, front + back).

| Fixture                         | Source pcap                  | Sides      | DPI | Colour    | Format | tcp.stream | Extracted events | Committed events |
| ------------------------------- | ---------------------------- | ---------- | --- | --------- | ------ | ---------- | ---------------- | ---------------- |
| `adf-duplex-600-mono-jpg.jsonl` | `ds575w-startup+scan.pcapng` | ADF duplex | 600 | grayscale | JPG    | 1          | 7,409            | 7,398            |

The scan PARA is **460 bytes**, `#ADF`-prefixed (segment order
`#ADF CRP DPLX SKEW #RSM #RSS #COL #FMT #JPG #GMM #GMT <gamma LUT> #CMX #CRP #DFA #LAM #PAG #ACQ #BSZ`).
This is a distinct, much smaller layout than the FF-680W's 1000/996-byte
`SKEWDPLXDFL1` PARA — the DS-575W dialect is not a byte-copy of the FF-680W's.
The grayscale scan pins `#COLM008` / `#GMTMONO`; a colour capture (`C024` / RGB)
would be needed to pin the colour PARA and gamma.

## Stream selection

The driver first opens a short TLS probe on port 1865, which the printer rejects
(it has no TLS), then reopens a second plain-TCP connection for the real session.
The pcap therefore contains two `tcp.port==1865` conversations: a 2-frame
TLS-probe stream (`tcp.stream 0` — a leading ClientHello plus a stray `0x8000`
welcome from the doomed socket) and the multi-thousand-frame plain-TCP scan
stream (`tcp.stream 1`). Extract with `--stream 1` so the TLS-probe bytes don't
concatenate ahead of the real session (see the shared dual-stream note in
`../et-4800/README.md`). The **first** attachment on the issue (`scan.pcapng`,
kept as `ds575w-scan-INCOMPLETE-mid-session.pcapng` under `.reference/`) was
started mid-session and lacked the connection setup / CAPA exchange; the
re-capture (`startup+scan.pcapng`) fixed that. A `startup.pcapng` (setup only,
no scan) accompanies it as a clean CAPA cross-check.

## Init-handshake trim

`driveFixture` feeds every printer→host event to the scanner regardless of what
the scanner emits, so the committed fixture's printer→host IS-packet sequence
must match the scanner's command sequence exactly. Request/reply is strictly 1:1
(`p>h` count == `h>p` count + 1, the +1 being the unsolicited `0x8000` welcome at
`p>h[0]`), so `p>h[k]` is the reply to `h>p[k-1]`.

Epson's driver runs the **same three extras as the FF-680W** between the LOCK and
the init-poll loop — an `EXI*` capability query, an extra `STAT` after `FS Z`, and
a 12-byte `#D&T` date/time PARA — which our shared `esci2Graph` never emits. The
committed fixture has the six printer→host IS packets they elicit removed:

| p>h IS idx | role                           | why dropped                           |
| ---------- | ------------------------------ | ------------------------------------- |
| 5          | `EXI` reply header (len 89)    | scanner sends no `EXI*` command       |
| 6          | `EXI` reply body (89 bytes)    | "                                     |
| 11         | `STAT` reply header (len 12)   | scanner goes `FS Z` → `INFO` directly |
| 12         | `STAT` reply body (12 bytes)   | "                                     |
| 17         | `#D&T` PARA ack (empty)        | scanner sends no date/time PARA       |
| 18         | `#D&T` PARA reply (`PARAx[0]`) | "                                     |

After the trim the printer→host stream is: welcome → lock-ack → FS-Y-ack, then
INFO → CAPA → FIN (INIT1), FS-Z-ack → INFO → CAPA → RESA → FIN (INIT2), then the
init-poll loop. This mirrors the FF-680W trim; the only difference is the
post-`FS Z` STAT here declares `len=12` (header + 12-byte body = 2 packets) where
the FF-680W's was `len=0` (a single packet), so six packets drop rather than five.
host→printer events are left untouched: the scanner never emits the `#D&T` PARA,
so the driver's 12-byte `#D&T` PARA and the 460-byte scan PARA both remain on the
host→printer side. A PARA byte-equivalence shield must therefore select the
`#RSM`-bearing scan PARA (not just "the host PARA"), exactly as the FF-680W
harness's `extractCapturedParaBody` does.

**No init-poll trim.** Unlike the ET-2750 / XP-7100 / ET-4800 references, the
init-poll loop is kept intact at its captured **12 cycles**, and the follow-on
registry entry should set `initPollIterations: 12` to match (the FF-680W's
"match the driver's count, no trim" approach). Note the DS-575W driver polls
until ready, so the count is session-variable — an earlier partial capture of the
same scanner showed 8 cycles. A future second fixture would need trimming to 12
(or whatever count the registry entry pins).

CAPA fingerprint: `90f98ad1ef34fc40fcd9b49f880b0599569c80b343ab9b05c92d15cfac30b074`

The fixture is validated end-to-end: driven through `runEsci2ScanOverPlain` (with
a temporary `fixed-adf` / `initPollIterations: 12` registry entry) it completes
and writes 2 JPG pages (front + back).

These fixtures are large (~13 MB) because the DS-575W's 600-DPI image data rides
in `0xa000` IS frames rather than the `0xa200` stream that pcap-extract folds into
a summary record — expected and harmless; replay is byte-exact regardless.

Source `.pcap` files (plus the `analyze-init.ts` / `dump-para.ts` /
`trim-init-handshake.ts` / `validate-*.ts` generation + validation helpers and
`SOURCE-NOTES.md`) are gitignored under `.reference/wireshark-captures/ds-575w/`.
