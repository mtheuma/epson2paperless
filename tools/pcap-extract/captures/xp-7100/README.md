# XP-7100 scanner replay fixtures

Three JSONL fixtures driving `src/esci2/scanner.test.ts` replay cases for
Epson XP-7100 (ESC/I-2 over plain TCP, PID 1147).

| Fixture | Source | Captured pcap (gitignored) |
|---|---|---|
| `jpg-flatbed.jsonl` | flatbed JPG, single page | `jpg-flatbed_anon.pcapng` |
| `jpg-adf-simplex.jsonl` | ADF JPG, single sheet | `jpg-single_anon.pcapng` |
| `jpg-adf-duplex.jsonl` | ADF duplex JPG, single sheet | `jpg-duplex_anon.pcapng` |

## Provenance

Source pcaps from issue [#65](https://github.com/mtheuma/epson2paperless/issues/65)
(reporter: utf8please), age-encrypted in
`.reference/wireshark-captures/xp-7100/*.age` and decrypted-locally under
`_decrypted/` (gitignored).

Each pcap contains two TCP streams to port 1865: the first is the driver's
TLS attempt (rejected by the printer); the second is the actual scan
session over plain TCP. The extract step selects stream index 2.

## Trimming

The driver-captured fixtures have 11-13 FS Y init-poll cycles. Our scanner
sends 3 (xp7100Dialect.initPollIterations). Each fixture is trimmed to
keep only the first 3 INFO/CAPA/FIN cycles before MODE_SWITCH; the rest
are deleted by hand-editing the JSONL.
