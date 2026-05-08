# ET-2750 replay fixtures

JSONL fixtures used by `src/esci2/scanner.test.ts`'s
`runEsci2ScanOverPlain` replay test. Generated from gitignored Wireshark
captures in `.reference/wireshark-captures/et-2750/` via `npm run pcap:extract`.

| Fixture                          | Source pcap                       | Scenario                       |
| -------------------------------- | --------------------------------- | ------------------------------ |
| `flatbed-single-page-pdf.jsonl`  | `flatbed-single-page-pdf.pcapng`  | 1 page, flatbed, PDF (300 DPI) |

ET-2750 is flatbed-only hardware (no ADF, no duplex), so the matrix is one
cell. PDF and JPG share the same wire — the panel-PDF case is composed
host-side from `#FMTJPG` data, identical to how our service composes PDFs.

The source pcap contains two TCP conversations on port 1865: a brief
aborted SYN/RST attempt (stream 9) and the real 30-second scan session
(stream 10). The aborted stream's bytes interleave with the real stream
in the host→printer direction filter unless we constrain extraction to
the long-running conversation. Pass `--stream 10` to isolate it:

```
TSHARK_PATH="/path/to/tshark" npm run pcap:extract -- \
  .reference/wireshark-captures/et-2750/flatbed-single-page-pdf.pcapng \
  10.31.50.61 10.31.50.16 1865 \
  tools/pcap-extract/captures/et-2750/flatbed-single-page-pdf.jsonl \
  --stream 10
```

Source IPs come from the original capture (printer 10.31.50.16, host
10.31.50.61). The replay tests don't care about IPs — they're only used
by tshark's filter at extract time.

## Why this fixture is larger than the WF-3620 fixtures

The WF-3620 fixtures use the image-stream summary trick (one record stands
in for hundreds of `0xa200` raw-RGB chunks) to stay under ~80 KB. ET-2750
streams pixel data inside ESC/I-2 `0xa000` IMG-reply frames — there's no
`0xa200` magic to fold on, so the fixture stores ~1500 IMG cycles
verbatim and lands at ~3.9 MB. Replay is byte-exact regardless.
