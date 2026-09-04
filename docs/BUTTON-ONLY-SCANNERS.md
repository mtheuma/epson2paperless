# Button-only scanners

The **FF-680W** and **DS-575W** have no panel to pick a destination from — just a Start button. Before that button can reach `epson2paperless`, the scanner has to be paired with it over SNMP.

## Why pairing is needed

The scanner stores a single paired host name and routes every button press to it, so the `ClientName` advertised by `epson2paperless` (i.e. `SCAN_DEST_NAME`) must match that stored name exactly. If it doesn't, the button press never reaches the service — you'll see healthy keepalives in the log but no scan.

## Read the current paired name

```bash
snmpget -v1 -c epson <printer-ip> \
  1.3.6.1.4.1.1248.1.1.3.1.10.2.5.0
```

- **A name comes back** — common on the FF-680W if you've run Epson's software, which stores the PC's hostname. Either set `SCAN_DEST_NAME` to that value, or overwrite the stored name (below). Note the current value first if you may want to restore it.
- **An empty string comes back** — common on the DS-575W, whose button is not paired to a network destination out of the box. You must set it before any button press will reach the service.

## Set the paired name

Set the stored name to match `SCAN_DEST_NAME`:

```bash
snmpset -v1 -c epson <printer-ip> \
  1.3.6.1.4.1.1248.1.1.3.1.10.2.5.0 \
  s 'Paperless'
```

For example, with `SCAN_DEST_NAME=Paperless`, set the SNMP value to `Paperless` too. To undo, `snmpset` the original value back (or an empty string if it started empty).

## Scan settings

With no panel to read a choice from, output format and sides come from the environment instead: `SCAN_FORMAT` and `SCAN_SIDES` in the [Configure](../README.md#configure) table. Both models are ADF-only.
