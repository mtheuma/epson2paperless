# ET-2550 replay fixture

JSONL fixture used by `src/esci/scanner.test.ts` replay tests. Generated from a
gitignored Wireshark capture in `.reference/wireshark-captures/et-2550/` via
`npm run pcap:extract`. Contributed for issue #166.

| Fixture         | Scenario                                      |
| --------------- | --------------------------------------------- |
| `flatbed.jsonl` | 1 page, flatbed, 300 DPI colour, 2550×3509 px |

Legacy ESC/I, like `../wf-3620/` and `../xp-620/` — not ESC/I-2. The welcome
payload's byte 1 is `0x02` and no `FS Y` appears anywhere in the session.

## Two things make this capture unusual

**The session runs over link-local IPv6.** The reporter's PC reached the printer
at `fe80::14cb:1e02:3744:510e` → `fe80::46d2:44ff:fe0f:1f58`, not over IPv4. A
Bonjour-discovered scanner can pick IPv6 with no user control over the choice,
and two earlier capture attempts filtered on the printer's IPv4 address came back
holding only multicast and no session at all. `pcap-extract` grew IPv6 support
for this (PR #167); pass the v6 literals exactly as below.

**The source pcap holds two scans in one TCP connection.** Epson Scan keeps the
socket open across scans, so a JPG scan (t≈43 s) and a PDF scan (t≈98 s) share
one stream, and the capture ends with no FIN — the connection was still open when
recording stopped. Our push-scan model opens a fresh session per scan, and
`concatHostBytes` would otherwise splice both scans' host bytes into one expected
transcript, so the pcap is trimmed to the first scan before extraction. Frame
29697 is that scan's terminating `ESC )`.

The two scans are byte-identical in `FS W`, stream config and gamma, which is why
one fixture covers both the JPG and PDF cases: the format is a host-side decision
and never reaches the wire.

## To regenerate

```
"/path/to/editcap" -r \
  .reference/wireshark-captures/et-2550/et2550-flatbed-jpg_v6.pcapng \
  /tmp/et2550-scan1.pcapng 1-29697

TSHARK_PATH="/path/to/tshark" npm run pcap:extract -- \
  /tmp/et2550-scan1.pcapng \
  fe80::14cb:1e02:3744:510e fe80::46d2:44ff:fe0f:1f58 1865 \
  tools/pcap-extract/captures/et-2550/flatbed.jsonl \
  --stream 4
```

Expected output: 60 events (40 `h>p` / 20 `p>h`), one folded image stream of 439
chunks / 26,844,289 bytes at chunk size 61201, and a 20-frame host transcript of
1292 bytes:

```
LOCK -> ESC @ -> FS I -> FS F x3 -> ESC ( -> ESC @ -> FS F
     -> ESC z x3 (+256B LUT each) -> FS W (+64B body) -> FS G -> STREAMCFG -> ESC )
```

## Notes for the dialect entry

- **No `ESC e` anywhere.** The device is flatbed-only and the vendor driver never
  sends a source-select command, which is why the WF-3620 fallback NAKs at
  `SOURCE_ACK2` — it probes with a hardcoded ADF-simplex source byte.
- **No teardown is observed.** The capture ends mid-connection, so the only
  session terminator we have evidence for is the trailing `ESC )`. There is no
  unlock packet, matching `../xp-620/`.
- **Gamma is not identity.** The G and B LUTs are, but R is identity except for a
  contiguous band from index 54 to 140 where every value is exactly +1. That is
  most likely a rounding artifact of the reporter's professional-mode settings
  rather than a model tone curve, but it is transcribed as captured so the
  byte-equivalence shield holds.
- `FS G`'s reply is transfer segmentation, not raster dimensions: chunk size
  61200, chunk count 438, final partial chunk 38250. Those satisfy
  `438 x 61200 + 38250 = 26,843,850 = 2550 x 3509 x 3`. The stream config echoes
  the same values with `+1` each, accounting for the per-chunk status byte.
