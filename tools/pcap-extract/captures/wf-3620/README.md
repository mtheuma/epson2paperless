# WF-3620 replay fixtures

JSONL fixtures used by `src/esci/scanner.test.ts` replay tests. Generated
from gitignored Wireshark captures in `.reference/wireshark-captures/wf-3620/`
via `npm run pcap:extract`. Image-stream runs are folded into summary records
so each fixture stays under ~80 KB.

| Fixture                          | Source pcap                     | Scenario                               |
| -------------------------------- | ------------------------------- | -------------------------------------- |
| `flatbed-single-page-jpeg.jsonl` | `flatbed-single-page-jpeg.pcap` | 1 page, flatbed, JPEG (600 DPI)        |
| `flatbed-single-page-pdf.jsonl`  | `flatbed-single-page-pdf.pcap`  | 1 page, flatbed, PDF (300 DPI)         |
| `adf-single-page-jpeg.jsonl`     | `adf-single-page-jpeg.pcap`     | 1 sheet, ADF simplex, JPEG             |
| `adf-single-page-pdf.jsonl`      | `adf-single-page-pdf.pcap`      | 1 sheet, ADF simplex, PDF              |
| `adf-2-page-jpeg.jsonl`          | `adf-2-page-jpeg.pcap`          | 1 sheet, ADF duplex (front+back), JPEG |
| `adf-2-page-pdf.jsonl`           | `adf-2-page-pdf.pcap`           | 1 sheet, ADF duplex, PDF               |
| `adf-3-page-simplex-jpeg.jsonl`  | `adf-3-page-simplex-jpeg.pcap`  | 3 sheets, ADF simplex, JPEG            |
| `adf-3-page-simplex-pdf.jsonl`   | `adf-3-page-simplex-pdf.pcap`   | 3 sheets, ADF simplex, PDF             |
| `adf-4-page-duplex-jpeg.jsonl`   | `adf-4-page-duplex-jpeg.pcap`   | 2 sheets, ADF duplex (4 sides), JPEG   |
| `adf-4-page-duplex-pdf.jsonl`    | `adf-4-page-duplex-pdf.pcap`    | 2 sheets, ADF duplex, PDF              |

To regenerate a fixture:

```
TSHARK_PATH="/path/to/tshark" npm run pcap:extract -- \
  .reference/wireshark-captures/wf-3620/<source>.pcap \
  192.168.188.140 192.168.188.54 1865 \
  tools/pcap-extract/captures/wf-3620/<fixture>.jsonl
```

Source IPs come from the original maltris captures. The replay tests don't
care about IPs — they're only used by tshark's filter at extract time.
