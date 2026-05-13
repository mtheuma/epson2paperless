import type { Dialect, ParaAxes } from "../dialect.js";

// Captured PARA bodies, inlined as hex so they survive the tsc → dist
// build without an asset-copy step. The matching .bin files under
// xp-7100-fixtures/ exist only for test reference.

// prettier-ignore
const JPG_FLATBED = Buffer.from(
  "234642202352534d693030303033303023525353693030303033303023434f4c" +
  "4330323423464d544a504720234a50476430393023474d4d5547313823474d54" +
  "47524e2068313030000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000001020304050607090b0c0e1012131517191b" +
  "1d1f2022242627292b2c2e3031333536383a3b3d3e404143444647494a4c4d4f" +
  "505253555658595b5c5e5f606263656667696a6c6d6e70717274757778797b7c" +
  "7d7f80818384858788898a8c8d8e90919294959697999a9b9d9e9fa0a2a3a4a5" +
  "a7a8a9aaacadaeafb1b2b3b4b6b7b8b9bbbcbdbebfc1c2c3c4c7c8c9cacbcdce" +
  "cfd0d1d3d4d5d6d7d9dadbdcdddee0e1e2e3e4e6e7e8e9eaebedeeeff0f1f2f3" +
  "f5f6f7f8f9fafcfdfeffffffffffffffffffffffffffffffffffffffffffffff" +
  "ffffffffffffffff23474d545245442068313030000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000010203040506" +
  "07090b0d0f11131517191b1d1f2122242628292b2d2e3032333537383a3c3d3f" +
  "404243454648494b4c4e4f5152545557585a5b5d5e60616264656768696b6c6e" +
  "6f707273747677797a7b7d7e7f818283858687898a8b8c8e8f90929394969798" +
  "999b9c9d9fa0a1a2a4a5a6a7a9aaabacaeafb0b1b3b4b5b6b8b9babbbdbebfc0" +
  "c1c3c4c5c6c8c9cacbcccecfd0d1d2d4d5d6d7d8d9dadbdcdddee0e1e2e3e4e6" +
  "e7e8e9eaebedeeeff0f1f2f3f5f6f7f8f9fafcfdfeffffffffffffffffffffff" +
  "ffffffffffffffffffffffffffffffffffffffff23474d54424c552068313030" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000001020304050607090b0c0e10121416181a1c1e2021232527282a" +
  "2c2d2f3132343637393b3c3e3f4142444547484a4b4d4e505153545657595a5c" +
  "5d5f606163646667686a6b6d6e6f717273757678797a7c7d7e80818284858688" +
  "898a8b8d8e8f919293959697989a9b9c9e9fa0a1a3a4a5a6a8a9aaabadaeafb0" +
  "b2b3b4b5b7b8b9babcbdbebfc0c2c3c4c5c7c8c9cacbcdcecfd0d1d3d4d5d6d7" +
  "d9dadbdcdddee0e1e2e3e4e6e7e8e9eaebedeeeff0f1f2f3f5f6f7f8f9fafcfd" +
  "feffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" +
  "23434d58554d303868303039210184001f00810024000000235149544f464620" +
  "2341435169303030303030306930303030303030693030303235353069303030" +
  "333330302342535a6931303438353736",
  "hex",
);

// prettier-ignore
const JPG_SINGLE = Buffer.from(
  "234144462352534d693030303033303023525353693030303033303023434f4c" +
  "4330323423464d544a504720234a50476430393023474d4d5547313823474d54" +
  "47524e2068313030000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000001020304050607090b0c0e1012131517191b" +
  "1d1f2022242627292b2c2e3031333536383a3b3d3e404143444647494a4c4d4f" +
  "505253555658595b5c5e5f606263656667696a6c6d6e70717274757778797b7c" +
  "7d7f80818384858788898a8c8d8e90919294959697999a9b9d9e9fa0a2a3a4a5" +
  "a7a8a9aaacadaeafb1b2b3b4b6b7b8b9bbbcbdbebfc1c2c3c4c7c8c9cacbcdce" +
  "cfd0d1d3d4d5d6d7d9dadbdcdddee0e1e2e3e4e6e7e8e9eaebedeeeff0f1f2f3" +
  "f5f6f7f8f9fafcfdfeffffffffffffffffffffffffffffffffffffffffffffff" +
  "ffffffffffffffff23474d545245442068313030000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000010203040506" +
  "07090b0d0f11131517191b1d1f2122242628292b2d2e3032333537383a3c3d3f" +
  "404243454648494b4c4e4f5152545557585a5b5d5e60616264656768696b6c6e" +
  "6f707273747677797a7b7d7e7f818283858687898a8b8c8e8f90929394969798" +
  "999b9c9d9fa0a1a2a4a5a6a7a9aaabacaeafb0b1b3b4b5b6b8b9babbbdbebfc0" +
  "c1c3c4c5c6c8c9cacbcccecfd0d1d2d4d5d6d7d8d9dadbdcdddee0e1e2e3e4e6" +
  "e7e8e9eaebedeeeff0f1f2f3f5f6f7f8f9fafcfdfeffffffffffffffffffffff" +
  "ffffffffffffffffffffffffffffffffffffffff23474d54424c552068313030" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000001020304050607090b0c0e10121416181a1c1e2021232527282a" +
  "2c2d2f3132343637393b3c3e3f4142444547484a4b4d4e505153545657595a5c" +
  "5d5f606163646667686a6b6d6e6f717273757678797a7c7d7e80818284858688" +
  "898a8b8d8e8f919293959697989a9b9c9e9fa0a1a3a4a5a6a8a9aaabadaeafb0" +
  "b2b3b4b5b7b8b9babcbdbebfc0c2c3c4c5c7c8c9cacbcdcecfd0d1d3d4d5d6d7" +
  "d9dadbdcdddee0e1e2e3e4e6e7e8e9eaebedeeeff0f1f2f3f5f6f7f8f9fafcfd" +
  "feffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" +
  "23434d58554d303868303039210184001f00810024000000235149544f464620" +
  "2350414764303030234143516930303030303030693030303030303069303030" +
  "3235353069303030333330302342535a6931303438353736",
  "hex",
);

// prettier-ignore
const JPG_DUPLEX = Buffer.from(
  "2341444644504c582352534d6930303030333030235253536930303030333030" +
  "23434f4c4330323423464d544a504720234a50476430393023474d4d55473138" +
  "23474d5447524e20683130300000000000000000000000000000000000000000" +
  "00000000000000000000000000000000000001020304050607090b0c0e101213" +
  "1517191b1d1f2022242627292b2c2e3031333536383a3b3d3e40414344464749" +
  "4a4c4d4f505253555658595b5c5e5f606263656667696a6c6d6e707172747577" +
  "78797b7c7d7f80818384858788898a8c8d8e90919294959697999a9b9d9e9fa0" +
  "a2a3a4a5a7a8a9aaacadaeafb1b2b3b4b6b7b8b9bbbcbdbebfc1c2c3c4c7c8c9" +
  "cacbcdcecfd0d1d3d4d5d6d7d9dadbdcdddee0e1e2e3e4e6e7e8e9eaebedeeef" +
  "f0f1f2f3f5f6f7f8f9fafcfdfeffffffffffffffffffffffffffffffffffffff" +
  "ffffffffffffffffffffffff23474d5452454420683130300000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000102" +
  "0304050607090b0d0f11131517191b1d1f2122242628292b2d2e303233353738" +
  "3a3c3d3f404243454648494b4c4e4f5152545557585a5b5d5e60616264656768" +
  "696b6c6e6f707273747677797a7b7d7e7f818283858687898a8b8c8e8f909293" +
  "94969798999b9c9d9fa0a1a2a4a5a6a7a9aaabacaeafb0b1b3b4b5b6b8b9babb" +
  "bdbebfc0c1c3c4c5c6c8c9cacbcccecfd0d1d2d4d5d6d7d8d9dadbdcdddee0e1" +
  "e2e3e4e6e7e8e9eaebedeeeff0f1f2f3f5f6f7f8f9fafcfdfeffffffffffffff" +
  "ffffffffffffffffffffffffffffffffffffffffffffffff23474d54424c5520" +
  "6831303000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000001020304050607090b0c0e10121416181a1c1e202123" +
  "2527282a2c2d2f3132343637393b3c3e3f4142444547484a4b4d4e5051535456" +
  "57595a5c5d5f606163646667686a6b6d6e6f717273757678797a7c7d7e808182" +
  "84858688898a8b8d8e8f919293959697989a9b9c9e9fa0a1a3a4a5a6a8a9aaab" +
  "adaeafb0b2b3b4b5b7b8b9babcbdbebfc0c2c3c4c5c7c8c9cacbcdcecfd0d1d3" +
  "d4d5d6d7d9dadbdcdddee0e1e2e3e4e6e7e8e9eaebedeeeff0f1f2f3f5f6f7f8" +
  "f9fafcfdfeffffffffffffffffffffffffffffffffffffffffffffffffffffff" +
  "ffffffff23434d58554d303868303039210184001f0081002400000023514954" +
  "4f46462023504147643030302341435169303030303030306930303030303030" +
  "693030303235353069303030333330302342535a6931303438353736",
  "hex",
);

// prettier-ignore
const PDF_SINGLE = Buffer.from(
  "234144462352534d693030303033303023525353693030303033303023434f4c" +
  "4330323423464d544a504720234a50476430393023474d4d5547313823474d54" +
  "47524e2068313030000102030405060708090a0b0c0d0e0f1011121313141516" +
  "1718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30313233343536" +
  "3738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f50515253545556" +
  "5758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f70717273747576" +
  "7778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f90919293949596" +
  "9798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6" +
  "b7b8b9babbbcbdbebfc0c1c2c3c4c5c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7" +
  "d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7" +
  "f8f9fafbfcfdfeff23474d545245442068313030000102030405060708090a0b" +
  "0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c" +
  "2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c" +
  "4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c" +
  "6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c" +
  "8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabac" +
  "adaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcc" +
  "cdcecfd0d1d2d3d4d5d6d7d8d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaeb" +
  "ecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff23474d54424c552068313030" +
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
  "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f" +
  "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f" +
  "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f" +
  "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f" +
  "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf" +
  "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf" +
  "e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff" +
  "23434d58554d303868303039200000002000000020000000235149544f464620" +
  "2350414764303030234143516930303030303030693030303030303069303030" +
  "3235353069303030333330302342535a6931303438353736",
  "hex",
);

interface RegionOffsets {
  grnPayload: number;
  redPayload: number;
  bluPayload: number;
  cmxPayload: number;
}

// Marker offsets verified during analysis. Add 12 to skip the ASCII header
// ("#GMTxxx h100" / "#CMXUM08h009") and land on the payload byte.
// Flatbed and ADF simplex share marker offsets — the 8-byte body-size delta
// (944 vs 952) comes from #PAGd000 inserted AFTER the LUTs. ADF duplex
// inserts DPLX into the source token at offset 0, shifting everything +4.
const OFFSETS_SIMPLEX: RegionOffsets = {
  grnPayload: 72,
  redPayload: 340,
  bluPayload: 608,
  cmxPayload: 876,
};
const OFFSETS_ADF_DUPLEX: RegionOffsets = {
  grnPayload: 76,
  redPayload: 344,
  bluPayload: 612,
  cmxPayload: 880,
};

const LUT_LEN = 256;
const CMX_LEN = 12;

function pickBase(
  source: "flatbed" | "adf",
  duplex: boolean,
): { body: Buffer; offsets: RegionOffsets } {
  if (source === "flatbed") return { body: JPG_FLATBED, offsets: OFFSETS_SIMPLEX };
  if (duplex) return { body: JPG_DUPLEX, offsets: OFFSETS_ADF_DUPLEX };
  return { body: JPG_SINGLE, offsets: OFFSETS_SIMPLEX };
}

function extractRegions(
  src: Buffer,
  offsets: RegionOffsets,
): {
  grn: Buffer;
  red: Buffer;
  blu: Buffer;
  cmx: Buffer;
} {
  return {
    grn: src.subarray(offsets.grnPayload, offsets.grnPayload + LUT_LEN),
    red: src.subarray(offsets.redPayload, offsets.redPayload + LUT_LEN),
    blu: src.subarray(offsets.bluPayload, offsets.bluPayload + LUT_LEN),
    cmx: src.subarray(offsets.cmxPayload, offsets.cmxPayload + CMX_LEN),
  };
}

// PDF LUT/CMX regions are source-invariant across the captured axis set.
const PDF_REGIONS = extractRegions(PDF_SINGLE, OFFSETS_SIMPLEX);

/**
 * Epson XP-7100 (ESC/I-2 over plain TCP, PID 1147). Driver attempts TLS
 * first, printer rejects, falls back to plain TCP. Full hardware: flatbed
 * + ADF + duplex.
 *
 * PARA is action-aware: JPG vs PDF panel-action selects different gamma
 * LUT triplets and a different 12-byte CMX coefficient block. Everything
 * outside those regions is action-invariant.
 *
 * Five of six axis combinations come from captured fixtures. The sixth
 * (flatbed-PDF) is synthesised by splicing the captured PDF LUT triplet +
 * CMX into the captured flatbed-JPG body — every byte traces back to a
 * captured wire fixture, only the combination is constructed.
 */
export const xp7100Dialect: Dialect = {
  capaFingerprint: "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e",
  displayName: "XP-7100 (ESC/I-2 over plain TCP)",
  hardware: { flatbed: true, adf: true, duplex: true },
  sourceDetection: "stat-length",
  initPollIterations: 3,
  buildPara(axes: ParaAxes): Buffer {
    const { body, offsets } = pickBase(axes.source, axes.duplex);
    const out = Buffer.from(body); // copy — never mutate the inlined constants
    if (axes.action === "jpg") return out;
    const regions = PDF_REGIONS;
    regions.grn.copy(out, offsets.grnPayload);
    regions.red.copy(out, offsets.redPayload);
    regions.blu.copy(out, offsets.bluPayload);
    regions.cmx.copy(out, offsets.cmxPayload);
    return out;
  },
};
