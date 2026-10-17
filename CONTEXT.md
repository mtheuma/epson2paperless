# epson2paperless

A service that stands in for Epson's Windows "Scan to Computer" software: it answers the printer's discovery and panel trigger, drives the scan session, and delivers the pages as files. This glossary covers how the service decides what to send a given printer.

## Printer identity

**Model identity**:
The key that names which printer model is on the other end of a session: its product ID (`PID xxxx`), or its product name where the printer reports a name instead.
_Avoid_: fingerprint (as an identity), model key

**Product ID (PID)**:
The four-hex-digit model number a printer reports in its discovery announcement, its panel trigger, and (on most models) its INFO reply.
_Avoid_: USB ID, device ID

**CAPA fingerprint**:
A hash of a printer's canonicalised CAPA reply. A fallback key when no model identity matches, and a consistency check when one does; never the primary identity.
_Avoid_: dialect hash, model hash

## Dialect

**Dialect**:
Everything the service chooses to send one printer model during an ESC/I-2 session: PARA shape, colour pair, source handling, scan window and poll count.
_Avoid_: profile (reserved for the PARA layout variant), driver

**Capability-derived field**:
A dialect value computed from the printer's own INFO, CAPA or STAT replies rather than written down per model.

**Model override**:
A per-model record that supplies only what capabilities cannot: a captured colour pair, a scan window (where it differs from the generic one), and genuine quirks. Matched by model identity, or by CAPA fingerprint as a fallback.
_Avoid_: registry entry (the pre-override, fingerprint-keyed record), dialect entry

**Generic dialect**:
The dialect an ESC/I-2 printer gets when no model override matches: capability-derived fields plus the neutral pair. Experimental by definition.
_Avoid_: fallback dialect, default printer

**Escape hatch**:
A model override of a capability-derived field, for a printer whose replies misstate what it can do. Deliberately not offered until a real printer needs one.

**Duplex-orientation evidence**:
What confirms which way up a model's duplex back pages arrive: a duplex capture whose orientation has been checked, or a hardware report. A duplex model without it warns on its first duplex scan in a process.

**Scan area**:
The largest region a source can scan, as the printer advertises it.

**Scan window**:
The region the service asks the printer to scan; a paper size placed inside the scan area.
_Avoid_: extents (in prose), scan area

**Source**:
Where the page is scanned from: flatbed, ADF simplex or ADF duplex.
_Avoid_: input, feeder (for the flatbed)

**Init poll**:
The status cycles at the start of an ESC/I-2 session, before the mode switch. Their replies are not read: the source and the errors both come from the status reply after the mode switch, the last before PARA, as in Epson's driver. There, on a printer with both a flatbed and an ADF, "ADF paper empty" means flatbed and anything else means ADF; then an error on the unit being scanned ends the session, and one on another unit only warns. The poll count is an upper bound, not a requirement.
_Avoid_: warm-up loop, readiness wait

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

## Verification

**Provenance**:
Where a model override's colour pair, scan window or poll count came from: an Epson driver capture, a capture of the service's own traffic, a measured compatibility-page scan on that model's hardware (a reporter's, or the maintainer's on borrowed hardware), a reporter's qualitative report, or inheritance from another model. A group can carry more than one. Colour evidence names the colour bytes it vouched for, so it stops counting when they change.
_Avoid_: source (reserved for flatbed/ADF), origin

**Own capture**:
A capture of this service's traffic to a printer. It proves the printer accepted the bytes, not that the colours are right.
_Avoid_: driver capture
