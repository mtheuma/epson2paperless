# ET-7700 replay fixtures

JSONL fixtures used by `src/esci2/scanner.test.ts`'s
`runEsci2ScanOverPlain` replay test. Generated from gitignored Wireshark
captures in `.reference/wireshark-captures/et-7700/` via `npm run pcap:extract`.

| Fixture             | Source pcap               | Scenario                       |
| ------------------- | ------------------------- | ------------------------------ |
| `flatbed-jpg.jsonl` | `epson-capture-jpeg.pcap` | 1 page, flatbed, JPG (300 DPI) |
| `flatbed-pdf.jsonl` | `epson-capture-pdf.pcap`  | 1 page, flatbed, PDF (300 DPI) |

ET-7700 is flatbed-only hardware (no ADF, no duplex). Both captures were
provided by the issue [#145](https://github.com/mtheuma/epson2paperless/issues/145)
reporter and record **epson2paperless itself** (the `:main` image carrying the
speculative dialect from PR #153) scanning via a panel trigger — not Epson's
driver. The captured PARA is byte-identical to `composePara`'s output for the
registry entry in both sessions, which is what the replay test's
byte-equivalence shield pins. Because the captures are of our own service,
no init-handshake trimming is needed: the sessions replay verbatim.

Each pcap holds exactly one TCP conversation on port 1865, so no `--stream`
isolation is required:

```
TSHARK_PATH="/path/to/tshark" npm run pcap:extract -- \
  .reference/wireshark-captures/et-7700/epson-capture-jpeg.pcap \
  10.0.30.63 10.0.30.162 1865 \
  tools/pcap-extract/captures/et-7700/flatbed-jpg.jsonl
```

(Same for the PDF capture → `flatbed-pdf.jsonl`.) Source IPs come from the
original capture (printer 10.0.30.162, host 10.0.30.63). The replay tests
don't care about IPs — they're only used by tshark's filter at extract time.

Like the ET-2750/ET-4800 fixtures, pixel data rides in ESC/I-2 IMG-reply
frames with no `0xa200` runs to fold, so each fixture stores its IMG cycles
verbatim (~4 MB each). Replay is byte-exact regardless.
