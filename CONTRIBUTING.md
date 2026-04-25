# Contributing

Thanks for your interest in `epson2paperless`. Contributions — bug reports, feature ideas, pull requests — are welcome.

The project's scope is the wire protocol between an Epson EcoTank printer's "Scan to Computer" panel button and a folder on your machine. Anything inside that scope is fair game; reports from EcoTank models other than the ET-4950 are particularly valuable.

## Reporting bugs

Open a GitHub issue with:

- Printer model and firmware version (shown under Settings → Firmware Update on the ET-4950 — adjust for your model).
- What you tried, what you expected, and what actually happened.
- Relevant logs. Re-running with `LOG_LEVEL=debug` shows scanner state transitions and per-request detail; please include the section spanning from "ready" through the failure.
- For protocol-level issues, a `tshark` / Wireshark capture of port 2968 traffic is enormously helpful.

## Proposing changes

For non-trivial work, please open an issue to discuss before writing the PR. It saves time on both sides if the direction needs adjusting.

Smaller things — typos, doc fixes, an obvious bug with a one-line fix — go straight to a PR.

## Development setup

Requires Node.js ≥ 24.15.0.

```bash
git clone https://github.com/mtheuma/epson2paperless.git
cd epson2paperless
npm install
PRINTER_IP=192.0.2.58 npm run dev    # long-running daemon
PRINTER_IP=192.0.2.58 npm run scan   # one-shot mode
npm test                             # 216 tests, ~1s
```

`docs/HOW-IT-WORKS.md` is the deep-dive on the protocol, the scanner state machine, and the reverse-engineering methodology — start there if you're touching anything below the file-output layer.

## Pull requests

- Branch off `main`. PR back to `main`.
- Commit-message style: `type: short summary` — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. The body explains the _why_ when it isn't obvious from the diff.
- The CI gate is `npm run lint`, `npm run format:check`, and `npm test` — all three must pass. Activate the local pre-push hook with `git config core.hooksPath .githooks` to catch issues before pushing.
- If your PR addresses an open issue, link it in the description.
- Protocol changes that affect wire bytes need matching updates to the Frida-capture fixtures in `tools/frida-capture/captures/` — the byte-for-byte replay test in `src/scanner.test.ts` will fail otherwise. See `tools/frida-capture/README.md` for the re-capture workflow.

## Code of conduct

Be civil. I'm a one-person reviewer doing this in spare time, and clear, kind communication is what makes that sustainable.

## License

By contributing, you agree that your contributions are licensed under the MIT license — the same terms as the rest of the repository.
