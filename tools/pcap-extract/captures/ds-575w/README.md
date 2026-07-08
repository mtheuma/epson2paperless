# tools/pcap-extract/captures/ds-575w/

Wireshark captures of Epson's own scan software scanning to a DS-575W, contributed
by **@EliSauder** for [issue #128](https://github.com/mtheuma/epson2paperless/issues/128)
(DS-575W support). Captured against Epson's software, not epson2paperless.
Contributor's host: `192.168.11.167`; printer: `192.168.11.202`; transport:
ESC/I-2 over plain TCP, port 1865.

The DS-575W is an ADF-only, button-only sheet-fed scanner — a sibling of the
FF-680W (announces PID `0169`; FF-680W is `016B`). No flatbed. Sides
(1-sided / 2-sided), resolution, and colour mode are software settings chosen at
scan time.

| Fixture                                  | Source pcap                                   | Sides       | DPI (wire) | Colour    | `#COL` | tcp.stream | Committed events | Role                    |
| ---------------------------------------- | --------------------------------------------- | ----------- | ---------- | --------- | ------ | ---------- | ---------------- | ----------------------- |
| `adf-duplex-600-mono-jpg.jsonl`          | `ds575w-startup+scan.pcapng`                  | ADF duplex  | 600        | grayscale | M008   | 1          | 7,398            | full replay             |
| `adf-simplex-400-mono-jpg.jsonl`         | `ds575w-simplex-greyscale-400.pcapng`         | ADF simplex | 400        | grayscale | M008   | 1          | 3,897            | full replay             |
| `adf-simplex-600-color-jpg.oracle.jsonl` | `ds575w-simplex-color-1200gui-600wire.pcapng` | ADF simplex | 600        | colour    | C024   | 0          | 140              | PARA/gamma oracle (h>p) |

## PARA layout — colour vs greyscale

The scan PARA is `#ADF`-prefixed with a single layout that swaps just two things
between colour and greyscale — the gamma segment and the `#COL` code:

```
#ADFCRP <flags> #RSMi<dpi> #RSSi<dpi> #COL<code> #FMTJPG #JPGd090 #GMMUG18
   <gamma LUT>  #CMXUM08…  #CRPi0000000 #DFAi0000000i0001550 #LAMOFF #PAGd000 #ACQ… #BSZi1048576
```

- **greyscale** → `#COLM008` + a 268-byte `#GMTMONO` LUT → **460-byte** PARA.
- **colour** → `#COLC024` + an 804-byte `#GMTRED`/`GRN`/`BLU` LUT triplet → **996-byte** PARA.

The two differ byte-for-byte only in the gamma segment (268 vs 804) and the `#COL`
code; everything else (`#GMMUG18`, `#FMTJPG #JPGd090`, CMX, trailer, `#BSZ`) is
identical. This is a distinct, much smaller layout than the FF-680W's
1000/996-byte `SKEWDPLXDFL1` PARA — the DS-575W dialect is not a byte-copy of the
FF-680W's.

Two of the three data blocks are **already in the tree**, byte-identical:

- The colour RGB gamma triplet equals the existing `ff680w-adf` gamma class.
- The CMX (`UM08`) equals the existing `et2750-um08` class.

Only the 268-byte greyscale `#GMTMONO` LUT is novel (transcribed verbatim as the
`ds575w-mono` gamma class). The DS-575W's own colour and greyscale fixtures pin
all three directly in the replay test (gamma/CMX segment equality), independent of
the PARA-flags question below.

## The `#ADFCRP` flags field — GUI-driven, pinned to the FF-680W canonical

The bytes between `#ADFCRP ` and `#RSM` encode **scan options chosen in Epson's
GUI** that epson2paperless does not model: `SKEW` (skew correction), `DFL1`
(double-feed detection), `DPLX` (duplex). The field is variable and its order is
not stable for the same logical settings, as EliSauder's five captures show:

| Capture               | GUI settings              | `#ADFCRP` flags |
| --------------------- | ------------------------- | --------------- |
| b&w 150 simplex       | contents-skew, skip-blank | _(empty)_       |
| auto 75 simplex       | skew off, double-feed     | `DFL1`          |
| greyscale 400 simplex | skew, double-feed         | `DFL1SKEW`      |
| colour 1200 simplex   | page-skew, double-feed    | `SKEWDFL1`      |
| grey 600 duplex       | _(committed fixture)_     | `DPLXSKEW`      |

Because the printer tolerates an empty field and no capture is authoritative for a
button-initiated scan, the composer pins the **FF-680W canonical** —
`SKEW` + `[DPLX]` + `DFL1` — which is validated on sibling hardware. Consequences
for the replay test:

- The **colour oracle** (`SKEWDFL1`) matches the canonical exactly, so it carries
  a **strict full-PARA byte-equivalence** assertion.
- The **mono fixtures** were captured with different GUI flag orderings
  (`DFL1SKEW`, `DPLXSKEW`), so they are **driven to completion functionally**; the
  novel mono data is pinned via direct gamma/CMX segment equality rather than a
  full-PARA compare.

End-to-end correctness against real hardware is confirmed separately by having the
contributor run epson2paperless (branch build) against the DS-575W.

## The colour oracle (`…color-jpg.oracle.jsonl`)

EliSauder captured all five scans in one app session, so Epson's software reused a
single persistent TCP connection. Only the earlier scans carry the welcome / LOCK
/ CAPA init; the colour scan's stream opens mid-connection (first frame is a
`0x9000` async event, no init handshake), so it **cannot be driven** by the
scanner graph. It is committed as a **PARA/gamma oracle only** — reduced to its
140 host→printer (`h>p`) events, which is all `extractCapturedParaBody` reads —
and the test uses it to pin the colour PARA and RGB gamma, not to drive a session.

## Stream selection

The greyscale / b&w / auto captures each contain a short rejected TLS-probe stream
(`tcp.stream 0`, ~9 frames) ahead of the real plain-TCP scan (`tcp.stream 1`) —
extract those with `--stream 1`. The **colour** capture has no TLS probe (its
scan reuses the already-open connection), so its real session is the sole stream,
`tcp.stream 0`. See the shared dual-stream note in `../et-4800/README.md`.

The **first** attachment on the issue (`scan.pcapng`, kept as
`ds575w-scan-INCOMPLETE-mid-session.pcapng` under `.reference/`) was started
mid-session and lacked the connection setup / CAPA exchange; the re-capture
(`ds575w-startup+scan.pcapng`) fixed that for the duplex fixture.

## Init-handshake trim

`driveFixture` feeds every printer→host event to the scanner regardless of what
the scanner emits, so a committed replay fixture's printer→host IS-packet sequence
must match the scanner's command sequence exactly. Epson's driver runs the same
three extras as the FF-680W between the LOCK and the init-poll loop — an `EXI*`
capability query, an extra `STAT` after `FS Z`, and a 12-byte `#D&T` date/time
PARA — which our shared `esci2Graph` never emits. The committed fixtures have the
printer→host IS packets these elicit removed (`trim-init-handshake.ts`, role-driven
so a divergent capture fails loudly).

The exact drop set is **capture-specific**, because the post-`FS Z` STAT's declared
length is session-variable and a `len=0` STAT is one packet where a `len=12` STAT is
two, shifting every later index:

| Fixture                    | post-FS-Z STAT | `--drop`          | packets |
| -------------------------- | -------------- | ----------------- | ------- |
| `adf-duplex-600-mono-jpg`  | `len=12`       | `5,6,11,12,17,18` | 6       |
| `adf-simplex-400-mono-jpg` | `len=0`        | `5,6,11,16,17`    | 5       |

Derive the set for a fresh capture from `analyze-init.ts`'s paired listing. The
colour oracle needs no trim (it is h>p-only and never driven). host→printer events
are left untouched, so `extractCapturedParaBody` reads the scan PARA from them.

## Init poll

The init-poll loop is kept intact at its captured **12 cycles** in both full-replay
fixtures (registry `initPollIterations: 12`), mirroring the FF-680W's "match the
driver's count, no trim" approach. The DS-575W driver polls until ready, so the
count is session-variable — an earlier partial capture showed 8. A future fixture
would need its poll loop trimmed to 12 (or whatever the registry entry pins).

CAPA fingerprint: `90f98ad1ef34fc40fcd9b49f880b0599569c80b343ab9b05c92d15cfac30b074`

Both full-replay fixtures are validated end-to-end: driven through
`runEsci2ScanOverPlain` they complete and write the expected JPG page count
(duplex → 2 front+back, simplex → 1).

These fixtures are large (~3–13 MB) because the DS-575W's image data rides in
`0xa000` IS frames rather than the `0xa200` stream that pcap-extract folds into a
summary record — expected and harmless; replay is byte-exact regardless. (The
colour oracle is tiny because it keeps only host→printer events.)

Source `.pcap` files (plus the `analyze-init.ts` / `dump-para.ts` /
`trim-init-handshake.ts` / `count-poll.ts` / `para-head.ts` / `extract-classes.ts`
/ `validate-*.ts` generation + validation helpers and `SOURCE-NOTES.md`) are
gitignored under `.reference/wireshark-captures/ds-575w/`.
