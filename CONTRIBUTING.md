# Contributing

Thanks for your interest in `epson2paperless`. Contributions (bug reports, feature ideas, pull requests) are welcome.

The project's scope is the wire protocol between an Epson EcoTank printer's "Scan to Computer" panel button and a folder on your machine. Anything inside that scope is fair game; reports from EcoTank models other than the ET-4950 are particularly valuable.

## Reporting bugs

Open a GitHub issue with:

- Printer model and firmware version (shown under Settings → Firmware Update on the ET-4950; adjust for your model).
- What you tried, what you expected, and what actually happened.
- Relevant logs. Re-running with `LOG_LEVEL=debug` shows scanner state transitions and per-request detail; please include the section spanning from "ready" through the failure.
- For protocol-level issues, a `tshark` / Wireshark capture of port 2968 traffic is enormously helpful.

## Contributing a scan capture

A capture of your scanner scanning the project's **standard test page** is what lets us add or verify support for your model, and you only need to send it once.

1. **Print the test page:** `tools/test-page/compatibility-test-page.pdf` at 100% scale (turn off "fit to page"), plain white A4.
2. **Capture the scan:** set Wireshark's capture filter to `host <printer-ip>` (or `tshark -f "host <printer-ip>"`), then scan the printed page from the panel via **Scan to Computer** into epson2paperless, page 1 (the colour grid) first. Do one scan per mode your hardware supports: Flatbed JPG/PDF, plus ADF 1-Sided / 2-Sided JPG/PDF if you have an ADF.
3. **Send it privately:** a pcap contains your printer's MAC and other identifying bytes, so don't attach it to the issue. Upload to the [Dropbox drop folder](https://www.dropbox.com/request/yksswgt8rqv53l1x9dal) (write-only, no account needed), or email it to `epson2paperless.vineyard182@passmail.com`. Note the model and which mode each capture was.

I'll take it from there.

_(TLS models such as the ET-4950/4956/3950 encrypt the scan session, so a Wireshark capture won't be usable; a compatibility report on its own is still useful.)_

## Proposing changes

For non-trivial work, please open an issue to discuss before writing the PR. It saves time on both sides if the direction needs adjusting.

Smaller things (typos, doc fixes, an obvious bug with a one-line fix) go straight to a PR.

## Development setup

Requires Node.js ≥ 24.15.0.

```bash
git clone https://github.com/mtheuma/epson2paperless.git
cd epson2paperless
npm install
PRINTER_IP=192.0.2.58 npm run dev    # long-running daemon
PRINTER_IP=192.0.2.58 npm run scan   # one-shot mode
npm test                             # full test suite
```

`docs/HOW-IT-WORKS.md` is the architecture overview. If you're touching anything below the file-output layer, start with `docs/PROTOCOL-REFERENCE.md` for the protocol and scanner state machines, and `docs/REVERSE-ENGINEERING.md` for capture and fixture methodology.

## Pull requests

- Branch off `main`. PR back to `main`.
- Commit-message style: `type: short summary` (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`). The body explains the _why_ when it isn't obvious from the diff.
- The CI gate is `npm run lint`, `npm run format:check`, and `npm test`. All three must pass. The local pre-push hook (`git config core.hooksPath .githooks`, one-time per clone) runs the first two on every push so you catch lint/format issues before CI does; tests are left to CI to keep the hook fast.
- If your PR addresses an open issue, link it in the description.
- Protocol changes that affect wire bytes need matching updates to the Frida-capture fixtures in `tools/frida-capture/captures/`. The byte-for-byte replay test in `src/scanner.test.ts` will fail otherwise. See `tools/frida-capture/README.md` for the re-capture workflow.

## Provenance

This project re-implements network behavior for interoperability with user-owned hardware. To keep that footing clear, contributions must observe the following:

- **No Epson source, firmware, binaries, or proprietary documentation** in commits, issues, PRs, code comments, or any tracked file. Functional observations described in your own words are fine; verbatim source, identifier names, or comments from vendor code are not.
- **No NDA-covered material** of any kind.
- **No tables, blobs, or constants derived from vendor source** unless the same bytes are independently captured from the wire (Frida JSONL, Wireshark pcap) and the capture is the artifact of record.
- **Provenance notes, where useful, belong in the PR description or commit message**, not in user-facing copy. Internal notes about how a finding was obtained can live under `.reference/` (gitignored). Keep them off the tracked tree.

## Code of conduct

Be civil. I'm a one-person reviewer doing this in spare time, and clear, kind communication is what makes that sustainable.

## License

By contributing, you agree that your contributions are licensed under the MIT license, the same terms as the rest of the repository.
