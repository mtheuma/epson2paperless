import sharp from "sharp";

export interface OverlayBox {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface OverlayOpts {
  crosshairs: { x: number; y: number }[];
  boxes: OverlayBox[];
}

/** Composite an SVG of sample boxes + detected crosshairs over a base image. */
export async function renderOverlay(baseImage: Buffer, opts: OverlayOpts): Promise<Buffer> {
  const meta = await sharp(baseImage).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const boxes = opts.boxes
    .map(
      (b) =>
        `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#00FF00" stroke-width="2"/>` +
        `<text x="${b.x}" y="${b.y - 2}" font-size="12" fill="#00AA00">${b.label}</text>`,
    )
    .join("");
  const marks = opts.crosshairs
    .map(
      (c) =>
        `<circle cx="${c.x}" cy="${c.y}" r="6" fill="none" stroke="#FF00FF" stroke-width="2"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes}${marks}</svg>`;
  return sharp(baseImage)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}
