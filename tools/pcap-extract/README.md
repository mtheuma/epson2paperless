# pcap-extract

Converts a Wireshark `.pcap` of a WF-3620/XP-620 (or any plain-TCP legacy)
scan session into a small JSONL fixture used by `src/esci/scanner.test.ts`.

## Requirements

- `tshark` on PATH, or set `TSHARK_PATH`.

## Usage

```
TSHARK_PATH="/c/Program Files/Wireshark/tshark.exe" \
  npm run pcap:extract -- <pcap> <hostIp> <printerIp> <port> <out.jsonl> [--stream N]
```

`--stream N` isolates one `tcp.stream` when the pcap holds multiple
conversations on `<port>` (e.g. an aborted SYN/RST or a rejected TLS probe
ahead of the real session).

## Fixture format

One JSON object per line. Most events are `{dir, ts, hex}`. Long runs of
IS-0xa200 image chunks are collapsed into one
`{summary: "image-stream", chunkCount, totalBytes, chunkSize}` record so
the committed fixture stays under a few KB. `chunkCount` counts `0xa200`
IS chunks, not TCP frames. The replay test re-synthesises a pixel stream
of `totalBytes` from a known fill pattern.
