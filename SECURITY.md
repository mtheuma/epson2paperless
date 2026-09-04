# Security

## Threat model

`epson2paperless` is a **LAN service**. It listens for multicast discovery on `239.255.255.253:2968`, accepts a push-scan trigger on TCP `2968`, and opens a TLS session to the printer on TCP `1865`. It is intended to run on a network segment you trust — your home LAN, a scanner VLAN, or similar.

`PRINTER_IP` and `PRINTER_HOSTNAME` are mutually exclusive. A hostname is routing and peer-filtering metadata, not authentication: its IPv4 results are refreshed periodically and when an unknown peer arrives, and the kernel-observed TCP peer is used for the active transaction. The SOAP `IPAddressIn` field is not trusted for routing.

Those two uses of a hostname fail in opposite directions, deliberately. Peer filtering (`accepts()`) **fails closed**: when a refresh fails it keeps the previous address set and rejects any peer that isn't in it, so a resolver outage can never widen the filter. Choosing a connect address (`target()`) **fails open**: it returns a retained address even while resolution is failing, so a transient DNS blip doesn't take the service down. The residual risk is worth stating plainly: if the printer moved to a different address _and_ DNS is down, the retained address may since have been reassigned to another LAN device, and TLS is unverified by default (see below) — so the service could open a scan session to whatever now answers there. Exposure is narrow, because `target()` is only reached in two places: the startup discovery path (`startPrinterDiscovery` in `src/startup.ts`) and host-triggered `scan:now`. The daemon's scan path never calls it — it routes to the kernel-observed push-scan peer, already validated by `accepts()`. On the TLS path the mitigation is `PRINTER_CERT_FINGERPRINT` together with `PRINTER_PROTOCOL=esci2`, which authenticates the printer regardless of which address it was reached at; the plain-TCP dialects (`esci2-plain`, `esci`) present no certificate and have no equivalent.

Hostname mode also adds a DNS-spoofing surface that fixed-IP mode doesn't have. With `PRINTER_IP`, an attacker has to impersonate that address on the LAN — ARP spoofing or an equivalent L2 position. With `PRINTER_HOSTNAME`, poisoning whichever resolver the host uses is enough, since the answer feeds both the peer filter and the `target()` connect address.

Within that trust boundary, be aware of two deliberate design choices:

- **The printer does not authenticate the host.** Epson's "Scan to Computer" protocol has no host-side credential. Any machine on the same broadcast domain can register as a scan destination. This matches the stock Epson driver's behaviour.
- **TLS to the printer is unverified (`rejectUnauthorized: false`).** The ET-4950 ships a per-device factory-generated self-signed certificate — there is no CA chain to validate against, and no published fingerprint. Standard TLS validation would refuse every printer on the market. Our TLS connection gets confidentiality and integrity against a passive attacker, but **not** authentication of the peer: a LAN attacker who can impersonate `PRINTER_IP` during an active scan could feed arbitrary JPEG/PDF bytes into `OUTPUT_DIR`. Operators on networks they don't fully trust can opt in to fingerprint pinning by setting `PRINTER_CERT_FINGERPRINT` together with `PRINTER_PROTOCOL=esci2` (the explicit protocol setting prevents auto-detection from silently downgrading to plain-TCP ESC/I and bypassing the pin if an attacker RSTs the TLS probe). The check fires at TLS handshake completion, before any protocol bytes are sent (see README's "Verifying the printer's TLS certificate"). The hostname/IP only locates and filters the peer; the fingerprint authenticates the printer.
- **The `/health` endpoint binds to all interfaces and is LAN-reachable.** It exposes a coarse `lastScan` timestamp. This is information-equivalent to the multicast keepalive traffic any LAN observer can already see on `239.255.255.253:2968`, so binding to localhost would be cosmetic rather than substantive. Open by design so external monitoring tools (Uptime Kuma, healthchecks.io, etc.) can probe the service without per-deployment opt-in.

## Mitigations

- **Run the service on a network you trust.** A dedicated scanner VLAN is ideal; a home LAN is usually fine. Don't expose the host to untrusted L2 (public Wi-Fi, shared hosting networks).
- **Treat `OUTPUT_DIR` as untrusted input downstream.** If you're pairing with [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx), its consume directory already treats incoming files as untrusted — that's the right posture regardless of how they got there.
- **Keep the printer firmware up to date.** We have no visibility into the printer's own attack surface; that's Epson's problem, not ours, but you can help it along.

## Reporting a vulnerability

If you believe you've found a security issue in this code, please **do not open a public issue**. Instead:

- Open a [GitHub security advisory](https://github.com/mtheuma/epson2paperless/security/advisories/new) (preferred — private by default), **or**
- Email the author at `epson2paperless.vineyard182@passmail.com` with `epson2paperless security` in the subject.

This is a personal project (see `CONTRIBUTING.md`), so response times are best-effort. I'll acknowledge within a reasonable window and credit reporters who'd like to be named once a fix is public.
