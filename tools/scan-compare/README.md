# scan-compare

Measures scans with one consistent metric set so outputs from different sources
are directly comparable: our pipeline with and without `POST_PROCESS=document`,
a vendor reference (Epson Scan 2), and the same page re-scanned on other
hardware later.

Built for issue #146 (auto colour mode declining to convert under `document`)
and the torn-edge artefact reports on PR #143.

## Usage

```
npm run scan:compare -- <file...> [--document]
```

Accepts PDFs (every embedded JPEG is extracted and measured as a page) or image
files. `--document` additionally runs each page through the document profile and
prints the after-metrics beneath the before — the before/after view for judging
a change to the clip.

## Metrics

| Column      | Meaning                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `white%`    | Fraction of the page that is pure 255 — how hard the background is flattened.                                                                |
| `paper`     | Per-channel 95th-percentile white point, and the `cast` spread between channels.                                                             |
| `at-risk%`  | Non-white detail within `CLIP_BELOW_PAPER` of the paper white — detail the document profile forces to pure white (torn edges, soft shadows). |
| `knee%`     | Non-white detail inside the clip's soft-knee band, where the steep slope amplifies chroma and per-channel curves diverge on a cast.          |
| `chroma>24` | Fraction over the auto-colour classifier's broad floor, and `>64` over its strong floor, with the resulting verdict.                         |

`at-risk%` and `knee%` are shares of non-white detail, not of the page, so they
stay meaningful regardless of how much white space a page has.

## Interpreting a comparison

A vendor reference that preserves soft near-white detail will show a high
`at-risk%` — that is detail our clip would destroy, not a defect in theirs. A
rising `chroma>24` between a page and its `+ document` row means the clip is
manufacturing colour out of neutral content, which is what stops auto colour
mode converting a greyscale page.

Note that running `--document` over an already-processed vendor output is a
double-process and not a like-for-like pipeline comparison; for that, measure our
own raw scan of the same page.
