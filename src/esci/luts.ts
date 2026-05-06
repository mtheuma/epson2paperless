// Gamma LUTs captured from the WF-3620 driver. The driver hardcodes these
// rather than computing per-scan, so we do likewise. Bytes are reproduced
// verbatim from .reference/wireshark-captures/wf-3620/flatbed-single-page-jpeg.pcap
// — payload bytes 1..256 of the `52 / 47 / 42 + LUT` packets (the leading
// tag is added by the FS Z command builder, not by the LUT itself).

export const GAMMA_LUT_R = Buffer.from(
  "000102030405060708090a0b0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f" +
    "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f" +
    "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f" +
    "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f" +
    "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
    "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d8d9dadbdcddde" +
    "dfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
  "hex",
);

export const GAMMA_LUT_G = Buffer.from(
  "000102030405060708090a0b0c0d0e0f10111213131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f" +
    "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f" +
    "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f" +
    "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f" +
    "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
    "c0c1c2c3c4c5c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
    "e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
  "hex",
);

export const GAMMA_LUT_B = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f" +
    "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f" +
    "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f" +
    "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f" +
    "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
    "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
    "e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
  "hex",
);
