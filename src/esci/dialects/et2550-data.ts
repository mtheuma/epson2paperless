// src/esci/dialects/et2550-data.ts
//
// AUTO-GENERATED-LITERAL data module. Bytes captured verbatim from
// tools/pcap-extract/captures/et-2550/flatbed.jsonl (host "h>p" IS-0x2000
// passthru frames), sourced from the issue #166 reporter capture at
// .reference/wireshark-captures/et-2550/et2550-flatbed-jpg_v6.pcapng.
//
// Do not hand-edit — the replay test pins these byte-for-byte.

/** Fixed flatbed raster at the captured 300 DPI: 8.5in x 11.7in full glass. */
export const ET_RASTER = { widthPx: 2550, heightPx: 3509 } as const;

// The passthru payload following each `ESC z` is a 1-byte channel tag
// (0x52 'R' / 0x47 'G' / 0x42 'B') then a 256-byte gamma LUT. Bytes below are
// the 256-byte LUT body only (tag stripped).
//
// G and B are identity; R is identity except a contiguous +1 band over indices
// 54..140. That shape matches the WF-3620 LUTs (R is +1 over 12..215, G is -1
// over 20..198, B identity), so it is characteristic of this driver family
// rather than anything specific to how the capture was taken.
export const ET_GAMMA_R = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
  "hex",
);

export const ET_GAMMA_G = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
  "hex",
);

export const ET_GAMMA_B = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
  "hex",
);

/** 64-byte `FS W` parameter block: 300 dpi, 2550x3509, source byte 0x00
 *  (flatbed). Identical across the capture's JPG and PDF scans, so the block
 *  is format-independent and byte 28 (0x08) is not a format selector. */
export const ET_FSW_BLOCK = Buffer.from(
  "2c0100002c0100000000000000000000f6090000b50d000013080000080400010000000000000000000000000000000000000000000000000000000000000000",
  "hex",
);

/** 38-byte payload of the IS-0x2200 packet sent after `FS G` replies.
 *  Derived by the driver from that reply (chunk size and count, each +1 for the
 *  per-chunk status byte), but pinned here: only one geometry was captured, so
 *  a derivation cannot be validated. Same compromise as XP_STREAM_CONFIG. */
export const ET_STREAM_CONFIG = Buffer.from(
  "0000001e00000000000001b6000000000000ef11000000010000ef1106000000010000956b06",
  "hex",
);
