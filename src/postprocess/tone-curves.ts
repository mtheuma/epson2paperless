// src/postprocess/tone-curves.ts
//
// AUTO-GENERATED-LITERAL data module. Per-dialect perceptual tone curves that
// map a scanner's white-point-normalized output to how the printed page
// actually looks. Each curve is three 256-entry per-channel LUTs (R, G, B),
// indexed by the post-clip pixel value, transcribed from a real raw->Epson
// oracle pair for that printer family. Applied as stage 2 of the `document`
// profile, AFTER the adaptive white-point clip (stage 1). A dialect with no
// curve gets stage 1 only (clean white background, no tone match).
//
// et4950-family: derived 2026-07-08 from the ET-4956 compatibility-test-page
// raw-vs-ScanSmart pair (.reference/scan-quality-oracle/); reproduces Epson's
// rendering to ~7 grey/colour levels across the 12 swatches.
//
// Top-end reshape (issue #158): the 12 swatches leave the domain above ~248
// unconstrained, and the original interpolation there never reached pure
// white (post-clip 255 paper came out 253/255/255) with a visible 241 -> 253
// step on R. Entries 248..255 of each channel are a monotone ramp from the
// swatch-constrained value at 247 up to exactly 255 at 255; entries <= 247
// are byte-identical to the capture-derived fit. Invariants pinned in
// tone-curves.test.ts.

export type ToneCurveName = "et4950-family";

/** Three per-channel 256-entry LUTs [R, G, B], indexed by post-clip value. */
export const TONE_CURVES: Readonly<Record<ToneCurveName, readonly [Buffer, Buffer, Buffer]>> = {
  "et4950-family": [
    Buffer.from(
      "17171717171e1f222627292b2e30323436383c3f424547494a4c4d4d4e4e4e4e4e4e4e4e4e4e4e565c6266696b6d6e6f71727374757678797a7c7d7f808183848587888a8c8d8f9193959698999b9c9d9d9e9f9fa0a0a0a1a1a1a1a1a2a2a2a2a3a3a3a4a4a5a6a6a7a7a9a9abadaeb0b2b4b6b9bdc0c3c5c7ccd0d2d5d5d8dadcdedee0e0e2e3e4e4e5e5e6e6e6e7e7e8e8e8e8e9e9e9e9eaeaeaeaeaebebebecececececececececececededededededededededededededededededededededededededeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeefefefefefefefefefefefefefefefefeff0f0f0f0f0f0f0f0f0f0f0f0f0f2f4f6f8f9fbfdff",
      "hex",
    ),
    Buffer.from(
      "1414151d1d1f222226282a2c2f313436393c3f42444647484949494a4a4d4f525557595b5d5e60626365666869696a6b6b6c6c6d6f7175787c7f8183858687888a8b8c8d8f90929394969798999a9b9b9c9c9d9d9e9e9fa0a0a0a1a1a2a2a3a3a4a4a5a5a6a8a9aaacaeafb1b2b3b4b5b5b6b7b7b7b8b8b9babbbcbdbebfc1c3c5c6c9ccced0d2d4d5d7d8d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9dadbdcdddddedededfdfdfdfdfdfe0e0e0e0e0e1e1e1e1e1e1e1e1e1e2e2e2e3e3e3e3e3e3e4e4e4e4e4e4e5e5e5e5e6e6e6e6e6e6e7e7e7e7e8e8e8e9e9e9e9eaeaeaeaebebebebecececededeeeeeeeeeeeff0f0f1f3f5f6f8fafcfdff",
      "hex",
    ),
    Buffer.from(
      "2222222222232727292b2c2f3133353638393b3e414447494c4e4f515151515151515151525557585a5b5c5d5e60616466686b6d6e7070717272727272727272727375777b7f83898e93979a9fa0a3a4a6a7a7a8a9a9a9aaaaaaaaaaaaaaaaababacacadaeaeafb0b1b2b2b4b4b5b7b8b9babbbcbdbebfbfc0c0c1c1c2c2c2c3c3c4c4c5c5c6c6c7c7c8c8c8c9cacacbcbcdcdced0d1d2d5d6d9dbdde0e2e5e7e9ecedeff0f1f2f3f4f4f5f5f5f6f6f6f6f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f8f9fafbfcfdfeff",
      "hex",
    ),
  ],
};
