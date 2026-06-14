# tools/pcap-extract/captures/ff-680w/

Wireshark captures of Epson's macOS FastFoto / ScanSmart driver scanning to an
FF-680W, contributed by **@bchess** for [PR #110](https://github.com/mtheuma/epson2paperless/pull/110)
(FF-680W support), received 2026-06-13. Captured against Epson's macOS software,
not epson2paperless. Contributor's host: `192.168.10.154`; printer:
`192.168.10.8`; transport: ESC/I-2 over plain TCP, port 1865.

The FF-680W is an ADF-only FastFoto scanner: no flatbed. Sides (1-sided /
2-sided) and resolution (200 / 300 DPI) are software settings chosen at scan
time, so the fixtures cover the source × resolution matrix the dialect exposes.
All three captures scan to PDF (the only output the FastFoto UI offers); the wire
format is JPG, host-composed into a PDF as on every other dialect.

| Fixture                 | Source pcap                          | Sides       | DPI | Format | tcp.stream | Extracted events | Committed events |
| ----------------------- | ------------------------------------ | ----------- | --- | ------ | ---------- | ---------------- | ---------------- |
| `adf-duplex-200.jsonl`  | `ff680w-duplex-200dpi-pdf.pcap`      | ADF duplex  | 200 | PDF    | 7          | 1,459            | 1,450            |
| `adf-simplex-200.jsonl` | `ff680w-singlesided-200dpi-pdf.pcap` | ADF simplex | 200 | PDF    | 7          | 1,338            | 1,329            |
| `adf-simplex-300.jsonl` | `ff680w-singlesided-300dpi-pdf.pcap` | ADF simplex | 300 | PDF    | 7          | 2,289            | 2,280            |

The scan PARA is 1000 bytes for duplex (carries the `SKEWDPLXDFL1` token) and
996 bytes for simplex (`SKEWDFL1`, no `DPLX`). Resolution is threaded into the
`#RSM` / `#RSS` / `#ACQ` segments: 200 DPI → `#ACQ…i0001700i0007200`,
300 DPI → `#ACQ…i0002550i0010800`. Unlike every other dialect, the FF-680W
consumes `ctx.resolution`; the others pin resolution in their class data.

## Stream selection

Each pcap contains several `tcp.port==1865` conversations ahead of the real
session — rejected TLS probes plus the FF-680W's JOBW/JOBR job-control
handshakes — and the real plain-TCP scan session is **tcp.stream 7** in every
capture. Extract with `--stream 7` so the throwaway streams' bytes don't
concatenate ahead of the real one and desync replay (see the shared dual-stream
note in `../et-4800/README.md`).

## Init-handshake trim

`driveFixture` feeds every printer→host event to the scanner regardless of what
the scanner emits, so the committed fixture's printer→host IS-packet sequence
must match the scanner's command sequence exactly. Epson's macOS driver runs a
**richer init handshake** than our shared `esci2Graph`: between the LOCK and the
init-poll loop it sends three commands our scanner never emits — an `EXI*`
capability query, an extra `STAT` after `FS Z`, and a 12-byte `#D&Tx<timestamp>`
date/time PARA. Those elicit five printer→host IS packets the scanner would
never read, so the committed fixtures have them removed (init handshake is
byte-identical across all three captures, so the same five drop in each):

| p>h IS idx | role                         | why dropped                           |
| ---------- | ---------------------------- | ------------------------------------- |
| 5          | `EXI` reply header (len 204) | scanner sends no `EXI*` command       |
| 6          | `EXI` reply body (204 bytes) | "                                     |
| 11         | `STAT` reply (len 0)         | scanner goes `FS Z` → `INFO` directly |
| 16         | `#D&T` PARA ack (len 0)      | scanner sends no date/time PARA       |
| 17         | `#D&T` PARA reply header     | "                                     |

After the trim the printer→host stream is: INFO → CAPA → FIN (INIT1),
FS Z-ack → INFO → CAPA → RESA → FIN (INIT2), then the init-poll loop. host→printer
events are left untouched — the replay test's PARA byte-equivalence shield reads
the scan PARA from them (the FF-680W sends the 12-byte `#D&T` PARA _and_ the real
scan PARA on the host→printer side, so the shield selects the `#RSM`-bearing one).

Unlike the ET-2750 / XP-7100 / ET-4800 references, **no STAT-cycle trim is
needed**: the FF-680W driver runs exactly 8 init-poll cycles, matching the
dialect's `initPollIterations: 8`.

These fixtures are large (~1.5–3.9 MB) because the FF-680W's image data rides in
0xa000 IS frames rather than the 0xa200 stream that pcap-extract folds into a
summary record — expected and harmless; replay is byte-exact regardless.

CAPA fingerprint: `5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd`

Source `.pcap` files (plus the `analyze-para.ts` / `trim-init-handshake.ts`
generation helpers and `SOURCE-NOTES.md`) are gitignored under
`.reference/wireshark-captures/ff-680w/`.
