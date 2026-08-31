# scan-compare

Measures scans with one consistent metric set so outputs from different sources
are directly comparable: our pipeline with and without `POST_PROCESS=document`,
a vendor reference (Epson Scan 2), and the same page re-scanned on other
hardware later.

Built for issue #146 (auto colour mode declining to convert under `document`)
and the torn-edge artefact reports on PR #143.

## Usage

```
npm run scan:compare -- <file...> [--document] [--tone-curve <name>]
```

Accepts PDFs (every embedded JPEG is extracted and measured as a page) or image
files. `--document` additionally runs each page through the document profile and
prints the after-metrics beneath the before — the before/after view for judging
a change to the clip. `--tone-curve <name>` (implies `--document`) also applies
that dialect's pinned tone curve, so the `+ document` row matches what the
pipeline delivers for a dialect that has one; without it the row is clip-only.
Valid names are the keys of `TONE_CURVES` (currently `et4950-family`). A
`+ document` row's chroma columns and GREY/COLOUR verdict are the pipeline's
own — computed on clip-stage raw pixels, before any tone curve or re-encode —
so the row reports the verdict the service would actually reach.

## Metrics

| Column      | Meaning                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `white%`    | Fraction of the page that is pure 255 — how hard the background is flattened.                                                                |
| `paper`     | Per-channel 95th-percentile white point, and the `cast` spread between channels.                                                             |
| `at-risk%`  | Non-white detail within `CLIP_BELOW_PAPER` of the paper white — detail the document profile forces to pure white (torn edges, soft shadows). |
| `knee%`     | Non-white detail inside the clip's soft-knee band, where (before #164) the steep per-channel slope amplified chroma.                         |
| `chroma>24` | Fraction over the auto-colour classifier's broad floor, and `>64` over its strong floor, with the resulting verdict.                         |

`at-risk%` and `knee%` are shares of non-white detail, not of the page, so they
stay meaningful regardless of how much white space a page has.

## Interpreting a comparison

A vendor reference that preserves soft near-white detail will show a high
`at-risk%` — that is detail our clip would destroy, not a defect in theirs. A
rising `chroma>24` between a page and its `+ document` row means the clip is
manufacturing colour out of neutral content — the defect that stopped auto
colour mode converting greyscale pages until #164's neutral-preserving knee;
any significant rise now is a regression.

Note that running `--document` over an already-processed vendor output is a
double-process and not a like-for-like pipeline comparison; for that, measure our
own raw scan of the same page.

## Reference baseline (EliSauder's DS-575W page, PR #143 / issue #146)

The same A5 notebook page — three coloured smileys, ruled lines, torn
spiral-binding tabs down one edge — captured five ways. Recorded so later
measurements (other hardware, or a change to the clip) have a fixed comparison
point. Files are not committed; they are the attachments on PR #143. The
`document` rows were produced by the pre-#164 per-channel clip and are kept as
the record of the defect it fixed.

| Source                             | white% | at-risk% | knee% | chroma>24 | chroma>64 | verdict |
| ---------------------------------- | ------ | -------- | ----- | --------- | --------- | ------- |
| Epson Scan 2 reference             | 93.9   | 38.2     | 21.1  | 0.224%    | 0.132%    | COLOUR  |
| ours, no post-process (neutral pg) | 0.0    | 94.1     | 0.6   | 0.000%    | 0.000%    | GREY    |
| ours, no post-process (colour pg)  | 0.0    | 94.8     | 1.7   | 0.180%    | 0.050%    | COLOUR  |
| ours, `document` (neutral pg)      | 89.5   | 23.5     | 20.9  | 2.003%    | 1.138%    | COLOUR  |
| ours, `document` (colour pg)       | 89.3   | 16.7     | 23.9  | 2.169%    | 1.133%    | COLOUR  |

Three things this pins:

1. **The old clip amplified chroma rather than inventing it.** A page that is
   already single-channel greyscale measures 0.000% before and after `document`.
   A three-channel scan of the _same physically neutral_ back side went from
   effectively zero to 2.003% — roughly 9x amplification of ordinary sensor and
   JPEG chroma noise, pushing it over the classifier's 24 floor. That was why
   auto colour mode stopped converting under `document` (issue #164).
2. **Background flattening is not the problem.** We reach 89-93% pure white
   against Epson's 93.9%. The cost is where we differ: `at-risk` falls from ~95%
   to 13-23%, i.e. roughly three quarters of the near-white detail is forced to
   pure white, while Epson holds 38.2%. Epson flattens _more_ background while
   keeping _more_ soft detail, which a global histogram threshold cannot do —
   it cannot tell a light grey torn-paper tab from paper.
3. **Greyscale-converted pages in this capture report 72 dpi** instead of 400.
   That is the density-stripping bug fixed in #143; these files predate that
   merge, so they double as a field confirmation the fix was needed.

## After #164 (neutral-preserving knee)

The same files re-measured with the shared-lift knee. The colour page — the
only three-channel raw capture in the set — now passes through the clip with
its chroma intact instead of 11x amplified, landing where the Epson reference
sits:

| Source                          | white% | at-risk% | chroma>24 | chroma>64 | verdict |
| ------------------------------- | ------ | -------- | --------- | --------- | ------- |
| ours, `document` (colour pg)    | 89.8   | 14.3     | 0.178%    | 0.056%    | COLOUR  |
| _same page pre-clip, for scale_ | 0.0    | 94.8     | 0.180%    | 0.050%    | COLOUR  |

No raw three-channel capture of the neutral back side exists (auto colour mode
converted it to single-channel in every no-post-process scan), so its GREY
verdict under the new clip cannot be measured from these files — that is the
hardware confirmation #164 asks the DS-575W reporter for. What can be checked:
re-processing the old clip's delivered output adds no further chroma (neutral
page 2.003% → 1.969%), and the synthetic soft-grey gradient page in
`src/postprocess/document.test.ts` — knee-band-heavy by construction, like the
#164 page — classifies GREY through the new clip.
