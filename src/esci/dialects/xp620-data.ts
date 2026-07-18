// src/esci/dialects/xp620-data.ts
//
// AUTO-GENERATED-LITERAL data module. Bytes captured verbatim from
// tools/pcap-extract/captures/xp-620/flatbed.jsonl (host "h>p" IS-0x2000
// passthru frames), cross-checked against the source pcap at
// .reference/wireshark-captures/xp-620/jpeg-flatbed.pcapng.
//
// byte-transcribed verbatim from the XP-620 flatbed capture; do not
// hand-edit — the replay test pins it.

/** Fixed flatbed raster size at the captured 300 DPI (A4). */
export const XP_RASTER = { widthPx: 2481, heightPx: 3507 } as const;

// The passthru payload following each `ESC z` command is a 1-byte channel
// tag (0x52 'R' / 0x47 'G' / 0x42 'B') followed by a 256-byte gamma LUT.
// Bytes below are the 256-byte LUT body only (tag stripped).
export const XP_GAMMA_R = Buffer.from(
  "000000000000000000000000000000000000000000000000010203040507080a0d0f11131517191b1d1f21232526282a2b2d2f3032343537383a3b3d3e404143444647494a4c4d4e50515354555758595b5c5d5f60616364656668696a6c6d6e6f71727374767778797a7c7d7e7f80828384858688898a8b8c8d8f9091929394969798999a9b9c9d9fa0a1a2a3a4a5a6a8a9aaabacadaeafb0b1b2b4b5b6b7b8b9babbbcbdbebfc0c1c2c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "hex",
);

export const XP_GAMMA_G = Buffer.from(
  "000000000000000000000000000000000000000000000000010203040507080a0c0e1012131517191b1d1f2123242628292b2d2e303233353638393b3c3e3f4142444547484a4b4c4e4f515253555657595a5b5d5e5f616263646667686a6b6c6d6f70717274757677787a7b7c7d7e8081828384868788898a8b8d8e8f9091929495969798999a9b9d9e9fa0a1a2a3a4a6a7a8a9aaabacadaeafb0b2b3b4b5b6b7b8b9babbbcbdbebfc0c2c3c4c5c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "hex",
);

export const XP_GAMMA_B = Buffer.from(
  "000000000000000000000000000000000000000000000000010203040507080a0c0e10121416181a1c1e2022242527292a2c2e2f3133343637393a3c3d3f404243454648494b4c4d4f505253545657585a5b5c5e5f60626364656768696b6c6d6e7071727375767778797b7c7d7e7f81828384858788898a8b8c8e8f9091929395969798999a9b9c9e9fa0a1a2a3a4a5a7a8a9aaabacadaeafb0b1b3b4b5b6b7b8b9babbbcbdbebfc0c1c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "hex",
);

// The 64-byte parameter block sent as the passthru command immediately after
// `FS W`'s own ack. Fixed for XP-620 (300 DPI flatbed, 2481x3507px) — unlike
// WF-3620 this is not computed per-mode, so the bytes are pinned verbatim.
export const XP_FSW_BLOCK = Buffer.from(
  "2c0100002c0100000000000000000000b1090000b30d000013080000220400000100000000000000000100000000000000000000000000000000000000000000",
  "hex",
);

// The 38-byte payload of the IS-0x2200 packet sent immediately after `FS G`'s
// reply. Fixed for XP-620 (format-independent in the capture).
export const XP_STREAM_CONFIG = Buffer.from(
  "0000001e0000000000000067000000000003dc87000000010003dc8706000000010000916006",
  "hex",
);
