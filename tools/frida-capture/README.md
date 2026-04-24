# frida-capture

Capture plaintext IS packets from Epson's Windows scanning driver
(`es2projectrunner.exe` hosting `ES2Command.dll`) to observe the byte
sequence the real driver exchanges with the printer. The Node.js scanner
in `src/` was built by diffing its outgoing bytes against these captures.

## Why this is here

`epson2paperless` was developed against a single printer model (ET-4950).
The test suite replays captured wire traffic to regression-protect the
scanner against protocol drift. If you're using a different Epson ET-
model and the service doesn't work for you, capturing a known-good
scan session from Epson's Windows driver is the fastest way to diagnose
the protocol delta — share the JSONL output (with any sensitive content
scrubbed) on an issue and we can work out what's different.

## Prerequisites

- Windows host with Epson Scan 2 installed (driver DLL typically at
  `C:\Program Files (x86)\epson\Epson Scan 2\Core\ES2Command.dll`).
- Python 3.8+ with Frida: `pip install frida`.
- Node.js + `tsx` (already covered by this repo's dev dependencies).

## Usage

### Capture a scan

Make sure `EEventManager.exe` is running (it's the long-lived Epson
service that spawns `es2projectrunner.exe` when a scan is triggered).
Then, from a terminal on the same machine:

```bash
python tools/frida-capture/host.py --child-gate --label my-scan
```

The host attaches to `EEventManager.exe`, enables child gating, and
waits. When "child gating enabled" appears, trigger a scan from the
printer panel (choose the Epson destination the Windows software
registers, not `epson2paperless`'s destination). The host attaches to
the spawned `es2projectrunner.exe` and streams each IS packet into a
JSONL file under `tools/frida-capture/captures/`.

When the scan finishes, the target exits and the host closes the file.

### Read a capture

```bash
npx tsx tools/frida-capture/pretty-print.ts \
    tools/frida-capture/captures/<timestamp>-<label>.jsonl \
    > tools/frida-capture/captures/<timestamp>-<label>.txt
```

## Troubleshooting

### Initial packets (welcome / lock) are missing from the capture

Use `--child-gate` (default in the example above). Without it, the 50 ms
polling loop plus Frida's attach latency misses the first ~100-400 ms
after the target spawns. Child gating lets Frida attach to the target
before its first instruction executes.

### Agent reports "ES2Command.dll not loaded"

The DLL loads lazily. Trigger the scan only **after** the host logs
`[host] attaching to PID …` (for the non-gated flow) or
`[host] child gating enabled` (for the gated flow).

### Agent errors about bad addresses

The hook offsets in `agent.js` were verified against a specific
ES2Command.dll version. If Epson Scan 2 has been updated on the host
machine, addresses may have shifted. Open `ES2Command.dll` in Ghidra
(or a comparable disassembler) and re-locate the two TLS helper
functions — the comments at the top of `agent.js` describe their
signatures and the surrounding call sites.

### `pip install frida` fails

Try pinning to a known-good version: `pip install frida==16.5.9`. On
corporate-proxy networks, download the wheel from
https://github.com/frida/frida/releases and install it locally.
