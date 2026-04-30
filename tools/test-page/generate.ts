import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb } from "pdf-lib";

// A4 in pdf-lib points (1 pt = 1/72 inch).
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;

interface Swatch {
  r: number;
  g: number;
  b: number;
  label: string;
}

const SWATCHES: Swatch[] = [
  { r: 255, g: 0, b: 0, label: "FF0000" },
  { r: 0, g: 255, b: 0, label: "00FF00" },
  { r: 0, g: 0, b: 255, label: "0000FF" },
  { r: 0, g: 255, b: 255, label: "00FFFF" },
  { r: 255, g: 0, b: 255, label: "FF00FF" },
  { r: 255, g: 255, b: 0, label: "FFFF00" },
  { r: 192, g: 192, b: 192, label: "C0C0C0" },
  { r: 128, g: 128, b: 128, label: "808080" },
  { r: 64, g: 64, b: 64, label: "404040" },
  { r: 255, g: 128, b: 0, label: "FF8000" },
  { r: 128, g: 0, b: 255, label: "8000FF" },
  { r: 0, g: 160, b: 160, label: "00A0A0" },
];

function rgb255(r: number, g: number, b: number) {
  return rgb(r / 255, g / 255, b / 255);
}

function drawCrosshair(page: PDFPage, x: number, y: number, size = 12): void {
  page.drawLine({
    start: { x: x - size, y },
    end: { x: x + size, y },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  page.drawLine({
    start: { x, y: y - size },
    end: { x, y: y + size },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
}

function drawCornerMarks(page: PDFPage): void {
  drawCrosshair(page, MARGIN, PAGE_HEIGHT - MARGIN);
  drawCrosshair(page, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - MARGIN);
  drawCrosshair(page, MARGIN, MARGIN);
  drawCrosshair(page, PAGE_WIDTH - MARGIN, MARGIN);
}

function drawHorizontalLines(page: PDFPage, baseY: number, count: number): void {
  for (let i = 0; i < count; i++) {
    page.drawLine({
      start: { x: MARGIN + 20, y: baseY + i * 8 },
      end: { x: PAGE_WIDTH - MARGIN - 20, y: baseY + i * 8 },
      thickness: 0.3,
      color: rgb(0, 0, 0),
    });
  }
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  y: number,
  size: number,
  font: PDFFont,
): void {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (PAGE_WIDTH - width) / 2,
    y,
    size,
    font,
    color: rgb(0, 0, 0),
  });
}

function drawFront(page: PDFPage, helv: PDFFont, helvBold: PDFFont): void {
  drawCornerMarks(page);

  // Asymmetric corner marker — distinguishes a horizontal flip from rotation.
  page.drawText("F", {
    x: MARGIN + 8,
    y: PAGE_HEIGHT - MARGIN - 28,
    size: 24,
    font: helvBold,
    color: rgb255(255, 0, 0),
  });

  drawCenteredText(page, "FRONT — TOP", PAGE_HEIGHT - MARGIN - 55, 36, helvBold);

  // 3 columns x 4 rows = 12 swatches with their declared RGB labels.
  const swatchW = 120;
  const swatchH = 70;
  const colSpacing = 150;
  const rowSpacing = 105;
  const gridLeft = (PAGE_WIDTH - (3 * swatchW + 2 * (colSpacing - swatchW))) / 2;
  const gridTop = PAGE_HEIGHT - 200;

  for (let i = 0; i < SWATCHES.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = gridLeft + col * colSpacing;
    const y = gridTop - row * rowSpacing;
    const sw = SWATCHES[i];

    page.drawRectangle({
      x,
      y,
      width: swatchW,
      height: swatchH,
      color: rgb255(sw.r, sw.g, sw.b),
    });
    page.drawText(`#${sw.label}`, {
      x,
      y: y - 14,
      size: 11,
      font: helvBold,
      color: rgb(0, 0, 0),
    });
    page.drawText(`R=${sw.r}  G=${sw.g}  B=${sw.b}`, {
      x,
      y: y - 28,
      size: 8,
      font: helv,
      color: rgb(0.3, 0.3, 0.3),
    });
  }

  drawHorizontalLines(page, MARGIN + 80, 5);
  drawCenteredText(page, "FRONT — BOTTOM", MARGIN + 25, 24, helvBold);
}

function drawBack(page: PDFPage, helv: PDFFont, helvBold: PDFFont): void {
  drawCornerMarks(page);

  page.drawText("B", {
    x: MARGIN + 8,
    y: PAGE_HEIGHT - MARGIN - 28,
    size: 24,
    font: helvBold,
    color: rgb255(0, 0, 255),
  });

  drawCenteredText(page, "BACK — TOP", PAGE_HEIGHT - MARGIN - 55, 36, helvBold);

  const textX = MARGIN + 50;
  let y = PAGE_HEIGHT - 180;
  const lineGap = 32;

  page.drawText("Red text — anti-aliased coloured edges", {
    x: textX,
    y,
    size: 18,
    font: helvBold,
    color: rgb255(220, 0, 0),
  });
  y -= lineGap;
  page.drawText("Green text — anti-aliased coloured edges", {
    x: textX,
    y,
    size: 18,
    font: helvBold,
    color: rgb255(0, 140, 0),
  });
  y -= lineGap;
  page.drawText("Blue text — anti-aliased coloured edges", {
    x: textX,
    y,
    size: 18,
    font: helvBold,
    color: rgb255(0, 0, 220),
  });
  y -= lineGap * 1.5;

  const body =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
    "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
    "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi.";
  page.drawText(body, {
    x: textX,
    y,
    size: 11,
    font: helv,
    color: rgb(0.15, 0.15, 0.15),
    maxWidth: PAGE_WIDTH - 2 * textX,
    lineHeight: 15,
  });

  // Thin horizontal lines for skew detection at scan time.
  drawHorizontalLines(page, MARGIN + 80, 5);
  drawCenteredText(page, "BACK — BOTTOM", MARGIN + 25, 24, helvBold);
}

export async function generate(outputPath: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  drawFront(pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]), helv, helvBold);
  drawBack(pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]), helv, helvBold);

  const bytes = await pdf.save();
  fs.writeFileSync(outputPath, bytes);
  console.log(`Wrote ${outputPath} (${bytes.length} bytes, 2 A4 pages)`);
}

async function main(): Promise<void> {
  const outputPath = process.argv[2] ?? path.join(process.cwd(), "compatibility-test-page.pdf");
  await generate(outputPath);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
