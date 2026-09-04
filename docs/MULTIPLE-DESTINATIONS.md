# Multiple destinations

One running `epson2paperless` is one entry on the printer's **Scan to Computer** list. To offer several entries with different settings (say a greyscale PDF preset for documents and a colour JPG preset for photos) run one instance per entry, each with its own MAC address on your LAN.

## Why one instance per MAC

The printer builds its destination list from the keepalive replies it receives, and it keeps one entry per sending network identity. Tested on an ET-4956 (issue [#170](https://github.com/mtheuma/epson2paperless/issues/170)) and reported on an ET-4800 (issue [#105](https://github.com/mtheuma/epson2paperless/issues/105)):

- Two registrations from one MAC never show together. Within a discovery cycle the first one wins and the rest are ignored, whatever their `SCAN_DEST_NAME`, IP or port.
- Two containers on an `ipvlan` network (own IP, shared MAC) still collapsed to a single, seemingly random entry.
- The same two containers on a `macvlan` network (own IP **and** own MAC) both appeared.

In Docker terms:

| Network mode | Own LAN IP | Own LAN MAC | Works                                                 |
| ------------ | ---------- | ----------- | ----------------------------------------------------- |
| `host`       | No         | No          | No. Also clashes on TCP `2968` and the health port.   |
| `bridge`     | No         | No          | No. The multicast beacon never reaches the container. |
| `ipvlan`     | Yes        | No          | No. Confirmed in #105.                                |
| `macvlan`    | Yes        | Yes         | Yes.                                                  |

Anything that gives each instance its own MAC works the same way: separate hosts, VMs, or NICs. `macvlan` is just the cheapest on one Linux Docker host.

## Compose example

One service per destination, all on a single `macvlan` network. Adapted from the setup shared in #105.

```yaml
name: epson2paperless

x-common: &common
  image: ghcr.io/mtheuma/epson2paperless:latest
  restart: unless-stopped
  init: true
  healthcheck:
    test:
      - CMD
      - node
      - -e
      - "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 15s

x-env: &env
  PRINTER_IP: 192.0.2.58 # your printer
  LOG_LEVEL: info
  # TZ: Europe/London

services:
  documents:
    <<: *common
    environment:
      <<: *env
      SCAN_DEST_NAME: "Docs Grey PDF"
      SCAN_COLOR_MODE: grayscale
      POST_PROCESS: document
    volumes:
      - /srv/paperless/consume:/output
    networks:
      lan:
        ipv4_address: 192.0.2.240 # free address outside your DHCP pool

  photos:
    <<: *common
    environment:
      <<: *env
      SCAN_DEST_NAME: "Photos Colour JPG"
      SCAN_COLOR_MODE: color
      JPEG_QUALITY: "95"
    volumes:
      - /srv/scans/photos:/output
    networks:
      lan:
        ipv4_address: 192.0.2.241

networks:
  lan:
    driver: macvlan
    driver_opts:
      parent: eth0 # your host's LAN interface
    ipam:
      config:
        - subnet: 192.0.2.0/24
          gateway: 192.0.2.1
```

Then `docker compose up -d`. Any Compose runner works (Portainer stacks included). Swarm is not needed.

Before you deploy:

- Set `parent`, `subnet` and `gateway` to your host's real LAN interface and network. On a host with several ports, `parent` must be the one with a cable in it (`ip -o link` shows `LOWER_UP`, not `NO-CARRIER`). A macvlan on an unplugged port comes up cleanly and never hears the printer.
- If a macvlan network for the same subnet already exists (an ad blocker or DNS container is the usual owner), Docker refuses a second one with "Pool overlaps with other one on this address space". Portainer shows this only as a bare 500. Reuse the existing network instead of defining a new one:

  ```yaml
  networks:
    lan:
      external: true
      name: <existing network name>
  ```

- Pick static addresses outside your DHCP pool. The printer reaches each instance at that address.
- `PRINTER_HOSTNAME` works here too. Use the fully qualified name your router returns (for example `EPSON0E5A5A.localdomain`); a bare name depends on a search domain the containers may not inherit.
- Do not add `network_mode: host` or `ports:`. Each container has its own LAN address, so nothing needs publishing.
- Give every service a distinct `SCAN_DEST_NAME`. Leave `SCAN_DEST_ID` at its default. Changing it stops the entry appearing rather than creating a second one.
- Add one named service per destination. Scaling a service with `--scale` copies the same name and settings.

## What each destination can differ on

Anything in the [Configure](../README.md#configure) table: colour mode, `POST_PROCESS`, `JPEG_QUALITY`, `SCAN_RESOLUTION`, output folder, Paperless upload settings and so on.

**Format and sides still come from the printer panel.** On panel-driven models the JPG/PDF and 1-Sided/2-Sided choices are made on the printer for every scan, whichever destination is selected. `SCAN_FORMAT` only applies to button-only scanners and `scan:now`, and `PREVIEW_ACTION` only rewrites the panel's "Preview on Computer" action. A destination named "PDF" therefore relies on the person at the panel choosing PDF.

## Caveats

- **Linux hosts only.** `macvlan` needs a Linux Docker host and does not work in rootless mode or under Docker Desktop on macOS / Windows. See [Docker's macvlan requirements](https://docs.docker.com/engine/network/drivers/macvlan/#platform-support-and-requirements).
- **Prefer a wired interface.** Many Wi-Fi drivers and access points reject frames from extra MAC addresses on one radio.
- **Unraid defaults to `ipvlan`.** It switched for stability reasons. #105 was hit by exactly this; the reporter changed to `macvlan` and both entries appeared.
- **Containers cannot reach their own Docker host.** This is standard `macvlan` behaviour. Bind-mounted output folders are unaffected, so the consume-folder route to Paperless-ngx works as usual. If you use `PAPERLESS_URL` and Paperless runs on the same host, point it at an address the container can route to (a second interface, or a `macvlan` interface on the host as [Docker describes](https://docs.docker.com/engine/network/drivers/macvlan/)), or fall back to the consume folder.
