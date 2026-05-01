# test-page

A 2-page A4 PDF designed for end-to-end scan-pipeline verification — known
content, known colour values, clear orientation markers. Send to a user
reporting a printer-compatibility issue; ask them to print it duplex and
scan it with the printer's panel "Scan to Computer" feature; then render
their resulting `.pcap` via `tools/pcap-render/` and compare against the
original PDF as the known-correct source.

The pre-generated PDF is committed at
`tools/test-page/compatibility-test-page.pdf` — point users at that
directly. The generator (`generate.ts`) is here only for regenerating the
PDF if the layout ever changes.

## What's on the test page

**Page 1 — FRONT:**

- Big "FRONT — TOP" header at the top, "FRONT — BOTTOM" footer at the
  bottom — orientation is unambiguous in the rendered output.
- Asymmetric red "F" marker in the top-left corner — distinguishes a
  horizontal flip from a 180° rotation (which would otherwise look the same
  on a symmetric page).
- 12 colour swatches (3 × 4 grid) with their RGB hex codes printed beneath.
  Pure red/green/blue, cyan/magenta/yellow, three greys, three mixed
  (orange/purple/teal). Eyedropper any swatch in the rendered JPEG and
  compare to the printed label — confirms colour channels are decoded
  correctly.
- Five thin horizontal lines near the bottom — any skew or shear in the
  pipeline shows up as parallel lines that aren't parallel any more.
- Crosshair marks at all 4 corners — alignment / crop verification.

**Page 2 — BACK:**

- "BACK — TOP" / "BACK — BOTTOM" markers; blue "B" in top-left.
- Asymmetric content (different from Page 1) so a front/back swap mistake
  is visible.
- Three lines of coloured text (red, green, blue) — tests anti-aliased
  coloured edges, where channel-ordering bugs (BGR vs RGB) are most
  obvious.
- A short Lorem Ipsum paragraph.
- Same horizontal-line and crosshair patterns.

## Regenerating

```
npm run test-page:generate -- tools/test-page/compatibility-test-page.pdf
```

Default output path if the argument is omitted is
`./compatibility-test-page.pdf` in the working directory. Re-commit the
result if the layout changed.

The generator uses the project's existing `pdf-lib` dependency and the
built-in `Helvetica` / `Helvetica-Bold` fonts — no new deps, no font files
to ship.

## Verification flow

1. Run the generator → get `compatibility-test-page.pdf`.
2. Send it to the user; ask them to print it **duplex** (so the back side
   ends up on the back of the same physical sheet), confirm both pages came
   out cleanly, and load the printed sheet into the ADF.
3. Ask them to do a scan via the panel's "Scan to Computer" button and
   capture the wire traffic (Wireshark / dumpcap on the printer-host LAN
   interface, save as `.pcap`).
4. Run `tools/pcap-render` against their `.pcap` to produce JPEGs.
5. Compare the rendered JPEGs against the original PDF:
   - Front: are colours in the swatches correct? Is the "F" marker visible
     in the top-left of the rendered output?
   - Back: with `adf-duplex` source, is the back-page JPEG right-side-up
     (rotation working) and are the coloured text lines actually coloured
     (not grey / not channel-swapped)?
   - Both: are the horizontal lines parallel? Are the corner crosshairs
     visible at all four corners? Any colour cast on the white background?
