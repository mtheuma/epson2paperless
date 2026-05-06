# pcap-render

Dev-only CLI that takes a real Wireshark `.pcap` of a WF-3620 scan session
and runs the captured raw GBR pixel data through the project's image
pipeline (`encodeRawGbrToJpeg` → `output-tail.finalizeSession`), producing
viewable JPEGs / PDFs on disk.

Used to eyeball real maltris captures end-to-end before merging WF-3620
support — the replay tests in `src/esci/scanner.test.ts` use synthesised
fill-byte data, which exercises wire-protocol correctness but doesn't
verify that real pixel content round-trips correctly.

Not reachable from the runtime service. Not invoked by tests.

## Requirements

- `tshark` on PATH, or set `TSHARK_PATH`.

## Usage

```
TSHARK_PATH="/c/Program Files/Wireshark/tshark.exe" \
  npm run pcap:render -- <pcap> <source> <format> <outputDir>
```

- `<source>`: `flatbed` | `adf-simplex` | `adf-duplex`
- `<format>`: `jpg` | `pdf`
- IP and port defaults match the maltris captures (host 192.168.188.140,
  printer 192.168.188.54, port 1865); override with `HOST_IP`,
  `PRINTER_IP`, `SCAN_PORT` env vars for captures from other users.

## Examples

```bash
# 1-page flatbed PDF
npm run pcap:render -- \
  .reference/wireshark-captures/wf-3620/flatbed-single-page-pdf.pcap \
  flatbed pdf /tmp/render-out

# 1-sheet duplex JPEG (2 pages, page_02 has EXIF Orientation=3)
npm run pcap:render -- \
  .reference/wireshark-captures/wf-3620/adf-2-page-jpeg.pcap \
  adf-duplex jpg /tmp/render-out

# 2-sheet duplex PDF (4 pages, pages 2+4 rotated 180°)
npm run pcap:render -- \
  .reference/wireshark-captures/wf-3620/adf-4-page-duplex-pdf.pcap \
  adf-duplex pdf /tmp/render-out
```

## What gets verified

Visually inspecting the output catches problems that wire-bytes-only
tests can't:

- Channel ordering (RGB vs BGR).
- Stride/width off-by-one.
- Chunk-parser drift across page boundaries.
- Duplex back-page rotation actually fixing the U-turn flip.
- PDF page order and per-page rotation.
