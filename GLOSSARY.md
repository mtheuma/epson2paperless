# epson2paperless

A service that stands in for Epson's Windows "Scan to Computer" software: it answers the printer's discovery and panel trigger, drives the scan session, and delivers the pages as files. This glossary fixes the words for it, from discovery through to delivered output.

## Discovery and destinations

**Announcement**:
The multicast packet a printer sends whenever it needs a fresh destination list.
_Avoid_: beacon, broadcast

**Keepalive**:
The burst of packets the service sends in answer to an announcement, which puts it on that printer's destination list.
_Avoid_: registration

**NetScanMonitor version**:
The version, 2 or 3, of Epson's discovery-and-trigger protocol that an announcement or panel trigger is written in. A property of the message, not the model.
_Avoid_: v3 printer (say v3 request or v3 announcement), push-scan version

**Destination**:
One entry on a printer's Scan to Computer list.

**Destination name**:
The label a destination shows on the printer's panel.
_Avoid_: client name, dest name, paired name

**Button-only scanner**:
A scanner with a Start button but no panel to pick a destination or settings from.

**Pairing**:
Storing a destination name on a button-only scanner, so its Start button goes to that destination.

## Triggers

**Trigger**:
A request that starts a scan.

**Panel trigger**:
A trigger the printer sends when someone presses Scan or Start on it, including on a button-only scanner. A JobList that comes before it is job control, not a trigger.
_Avoid_: push-scan trigger, panel press, button press, push-scan event

**Host trigger**:
A trigger started from the host instead of the printer: `scan:now` or the webhook.
_Avoid_: manual scan

**Scan slot**:
The service's single right to run a scan against the printer at any moment.
_Avoid_: lock, reservation, hold, gate

**Admission**:
A trigger being given the scan slot.

**Refusal**:
A trigger turned away because the scan slot is taken.

## Run modes

**Daemon**:
The long-running service: discovery, the panel-trigger listener and, when enabled, the webhook.

**One-shot**:
A run of the service that waits for one panel trigger, scans, and exits. Not `scan:now`, which is a host trigger and never waits for the printer.

## Scan settings

**Source**:
Where a page is scanned from: the flatbed or the ADF.
_Avoid_: input, unit, feeder (for the flatbed)

**Sides**:
Whether the ADF scans one side of each sheet or both: simplex or duplex. Has no meaning on the flatbed.
_Avoid_: 1-sided / 2-sided (except when quoting the panel)

**Action**:
The panel's choice of what to do with a scan: JPG, PDF, Preview on Computer or Attach as email. It resolves to an output format, or to no scan.
_Avoid_: format (for the panel choice), effective action

**Colour mode**:
Whether a scan's pages come out in colour, in greyscale, or decided page by page (auto).
_Avoid_: mono, B&W, grayscale (in prose)

**Target resolution**:
The DPI a user asks a scan for.
_Avoid_: requested DPI, scan DPI

**Wire resolution**:
The DPI the printer is actually set to scan at; fixed by the dialect on a legacy printer.
_Avoid_: delivered DPI, scan DPI

## Scan session

**Scan**:
One admitted trigger's work, through to its output.
_Avoid_: job, session

**Scan session**:
The service's connection to the printer during which a scan's pages are read.
_Avoid_: job

**Job**:
The unit of Epson's job control, written and read around a panel trigger on printers that use it. Never a synonym for scan.

**Protocol generation**:
The command set a printer scans with: ESC/I-2 or legacy ESC/I.

**Legacy ESC/I**:
The older Epson scanner command set. ESC/I-2 printers also speak a little of it before the mode switch.
_Avoid_: legacy (alone), legacy init

**Legacy printer**:
A printer whose whole scan session is legacy ESC/I.

**Transport**:
What a scan session's bytes travel over: TLS or plain TCP.

**Variant**:
One of the three ways a scan session runs: ESC/I-2 over TLS, ESC/I-2 over plain TCP, or legacy ESC/I.
_Avoid_: `esci2-tls` (in prose), protocol (alone)

**Protocol probe**:
The check at the start of a scan session that picks its variant.
_Avoid_: arm (for the probe's steps)

**Scanner lock**:
The printer-side lock a scan session takes at its start and releases at its end. Not the scan slot.

**Mode switch**:
The step where an ESC/I-2 session leaves legacy ESC/I for ESC/I-2.

## Printer identity

**Model identity**:
The key that names which printer model is on the other end of a scan session: its product ID (`PID xxxx`), or its product name where the printer reports a name instead.
_Avoid_: fingerprint (as an identity), model key

**Product ID (PID)**:
The four-hex-digit model number a printer reports in its discovery announcement, its panel trigger, and (on most models) its INFO reply.
_Avoid_: USB ID, device ID

**CAPA fingerprint**:
A hash of a printer's canonicalised CAPA reply. A fallback key when no model identity matches, and a consistency check when one does; never the primary identity.
_Avoid_: dialect hash, model hash

## Dialect

**Dialect**:
Everything the service chooses to send one printer model during a scan session, on either protocol generation.
_Avoid_: profile (reserved for the PARA profile), driver

**Legacy dialect**:
A dialect for a legacy ESC/I printer, captured whole and fixed per model: no capability-derived fields and no model override.
_Avoid_: dialect entry, registry entry

**Capability-derived field**:
A dialect value computed from the printer's own INFO, CAPA or STAT replies rather than written down per model.

**Model override**:
A per-model record for an ESC/I-2 printer that supplies only what capabilities cannot: a captured colour pair, a scan window (where it differs from the generic one), and genuine quirks. Matched by model identity, or by CAPA fingerprint as a fallback.
_Avoid_: registry entry (the pre-override, fingerprint-keyed record), dialect entry

**Sibling**:
A model that shares another model's override, having been found to share its CAPA fingerprint, with a report of its own.

**Generic dialect**:
The dialect an ESC/I-2 printer gets when no model override matches: capability-derived fields plus the neutral pair. A model on it is Untested until a compatibility report says otherwise.
_Avoid_: fallback dialect, default printer

**Escape hatch**:
A model override of a capability-derived field, for a printer whose replies misstate what it can do. Deliberately not offered until a real printer needs one.

**PARA profile**:
The layout variant of the PARA body a printer takes: standard or `adf-crp`. A capability-derived field.
_Avoid_: profile (alone)

**Duplex-orientation evidence**:
What confirms which way up a model's duplex back pages arrive: a duplex capture whose orientation has been checked, or a hardware report.

**Scan area**:
The largest region a source can scan, as the printer advertises it.

**Scan window**:
The region the service asks the printer to scan; a paper size placed inside the scan area.
_Avoid_: extents (in prose), scan area

**Init poll**:
The status cycles at the start of an ESC/I-2 session, before the mode switch, whose replies are not read. The poll count is an upper bound, not a requirement.
_Avoid_: warm-up loop, readiness wait

**Reply-header block**:
The 52 bytes after the 12-byte header in every 64-byte ESC/I-2 reply, carrying the printer's not-ready reason (`#nrd`) and header-level error (`#err`), with `#---` filler where it has nothing to report.
_Avoid_: filler (for the whole block), ET-2750 quirk

## Colour

**Colour pair**:
The tone curve (`#GMT`) and colour matrix (`#CMX`) sent together in one PARA; the two are only ever chosen as a pair.

**Neutral pair**:
A colour pair that leaves colour to the host: an identity colour matrix and a gray-balance-only tone curve.
_Avoid_: stock, flat

**Epson-look pair**:
A colour pair that applies the model's own colour profile and a contrast tone curve on the printer.
_Avoid_: enhanced, profile mode

**Mixed pair**:
A colour pair that combines one half of a neutral pair with one half of an Epson-look pair. Not a valid choice.

**SoC-style**:
A printer that receives a tone curve but no colour matrix at all, with the UG10 gamma mode.
_Avoid_: TLS model

## Output

**Page**:
The image of one side of one sheet, as the printer delivers it; a duplex sheet gives two pages.
_Avoid_: image, side (for the image)

**Back page**:
The page from a sheet's reverse side in a duplex scan.

**Output**:
What a scan delivers: one PDF, or one JPG per page.
_Avoid_: document, scan (for the file)

**Output format**:
The file type a scan delivers: JPG or PDF.

**Host downsample**:
Scaling pages down on the host when the wire resolution is above the target resolution.

**Greyscale conversion**:
Turning a colour page into greyscale on the host.

**Post-processing mode**:
What the service does to page images on the host before delivering them: nothing, or document correction.
_Avoid_: post-process profile

**Document correction**:
The post-processing mode that neutralises the paper white point and re-encodes each page.
_Avoid_: document profile, enhancement

**Paper white point**:
The colour of the paper on a page, measured from that page.
_Avoid_: white point (alone)

**Device white point**:
How a particular scanner renders white paper; a fixed per-device setting.
_Avoid_: white point (alone), cast (for the setting)

## Verification

**Verified**:
A model's status once every capability its hardware has is confirmed working on real hardware.

**Experimental**:
A listed model's status while something about it is still untested.

**Untested**:
The status of a model with no compatibility report yet.

**Compatibility report**:
An issue reporting how a model did with the service.

**Compatibility page**:
The test PDF a reporter scans so colour and geometry can be measured.
_Avoid_: test page

**Diagnostic block**:
The dump of a printer's identity and capability replies that the log prints for an unrecognised ESC/I-2 printer, for pasting into a compatibility report.

**Verified resolution**:
A wire resolution that evidence shows a model scanning at.

**Capture**:
A raw recording of a scan session's traffic.

**Replay fixture**:
A scan session extracted from a capture and committed to the repo, which the tests replay against the service.
_Avoid_: capture (for a committed fixture)

**Provenance**:
The evidence behind a model override's colour pair, scan window or poll count: an Epson capture, an own capture, a reporter scan, a reporter report, or inherited evidence.
_Avoid_: source (reserved for flatbed/ADF), origin

**Epson capture**:
A capture of Epson's own software scanning a printer.
_Avoid_: driver capture, vendor capture

**Own capture**:
A capture of this service's traffic to a printer. It proves the printer accepted the bytes, not that the colours are right.
_Avoid_: driver capture

**Reporter scan**:
Evidence from a compatibility-page scan on the model's own hardware, measured.

**Reporter report**:
Evidence from a compatibility report that describes the result rather than measuring it.

**Inherited evidence**:
Evidence borrowed from another model with the same settings.

**Provisional evidence**:
Inherited colour evidence expected to match but not yet confirmed on the model's own hardware.
