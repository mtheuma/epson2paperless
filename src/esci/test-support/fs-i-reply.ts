/**
 * An 80-byte FS I reply with `product` in the 16-byte field at offset 46
 * (padded with `pad`) and `firmware` at offset 62 — the layout every legacy
 * capture uses. Everything else is zero.
 */
export function buildFsIReply(product: string, firmware: string, pad = " "): Buffer {
  const buf = Buffer.alloc(80);
  buf.write(product.padEnd(16, pad), 46, "latin1");
  buf.write(firmware, 62, "latin1");
  return buf;
}
