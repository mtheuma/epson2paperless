# Security

## Threat model

`epson2paperless` is a **LAN service**. It listens for multicast discovery on `239.255.255.253:2968`, accepts a push-scan trigger on TCP `2968`, and opens a TLS session to the printer on TCP `1865`. It is intended to run on a network segment you trust — your home LAN, a scanner VLAN, or similar.

Within that trust boundary, be aware of two deliberate design choices:

- **The printer does not authenticate the host.** Epson's "Scan to Computer" protocol has no host-side credential. Any machine on the same broadcast domain can register as a scan destination. This matches the stock Epson driver's behaviour.
- **TLS to the printer is unverified (`rejectUnauthorized: false`).** The ET-4950 ships a per-device factory-generated self-signed certificate — there is no CA chain to validate against, and no published fingerprint. Standard TLS validation would refuse every printer on the market. Our TLS connection gets confidentiality and integrity against a passive attacker, but **not** authentication of the peer: a LAN attacker who can impersonate `PRINTER_IP` during an active scan could feed arbitrary JPEG/PDF bytes into `OUTPUT_DIR`.

## Mitigations

- **Run the service on a network you trust.** A dedicated scanner VLAN is ideal; a home LAN is usually fine. Don't expose the host to untrusted L2 (public Wi-Fi, shared hosting networks).
- **Treat `OUTPUT_DIR` as untrusted input downstream.** If you're pairing with [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx), its consume directory already treats incoming files as untrusted — that's the right posture regardless of how they got there.
- **Keep the printer firmware up to date.** We have no visibility into the printer's own attack surface; that's Epson's problem, not ours, but you can help it along.

Optional printer-certificate pinning (via a user-supplied SHA-256 fingerprint) is on the roadmap as a follow-up hardening step — see the project's issue tracker.

## Reporting a vulnerability

If you believe you've found a security issue in this code, please **do not open a public issue**. Instead:

- Open a [GitHub security advisory](https://github.com/mtheuma/epson2paperless/security/advisories/new) (preferred — private by default), **or**
- Email the author at `matt.theuma@gmail.com` with `epson2paperless security` in the subject.

This is a personal project (see `CONTRIBUTING.md`), so response times are best-effort. I'll acknowledge within a reasonable window and credit reporters who'd like to be named once a fix is public.
