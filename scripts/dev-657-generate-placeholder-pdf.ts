// scripts/dev-657-generate-placeholder-pdf.ts
//
// Generates a placeholder CA buyer-representation agreement PDF used by DEV-713
// to seed a template in Reeve.Sign. The PDF is committed alongside this script
// so the template can be re-created from scratch if needed.
//
// Run: npx tsx scripts/dev-657-generate-placeholder-pdf.ts

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RED = rgb(0.78, 0.16, 0.16);
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.45, 0.45, 0.45);

async function main() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await pdf.embedFont(StandardFonts.Helvetica);

  const draftBanner = (page: import('@cantoo/pdf-lib').PDFPage) => {
    page.drawText('DRAFT / PLACEHOLDER — NOT A LEGAL BUYER REPRESENTATION AGREEMENT', {
      x: 36,
      y: 770,
      size: 9,
      font,
      color: RED,
    });
    page.drawText('Do not send to real consumers until legal review (DEV-657 follow-up)', {
      x: 36,
      y: 758,
      size: 8,
      font: fontReg,
      color: GRAY,
    });
  };

  const labeled = (page: import('@cantoo/pdf-lib').PDFPage, label: string, x: number, y: number) => {
    page.drawText(label, { x, y, size: 9, font, color: GRAY });
    page.drawLine({
      start: { x, y: y - 4 },
      end: { x: x + 260, y: y - 4 },
      thickness: 0.5,
      color: BLACK,
    });
  };

  // --- Page 1 ---
  const p1 = pdf.addPage([612, 792]); // US Letter
  draftBanner(p1);
  p1.drawText('California Buyer Representation Agreement', {
    x: 36,
    y: 720,
    size: 18,
    font,
    color: BLACK,
  });
  p1.drawText('(Exclusive — PLACEHOLDER text — replace before production)', {
    x: 36,
    y: 700,
    size: 10,
    font: fontReg,
    color: GRAY,
  });

  p1.drawText('1. PARTIES', { x: 36, y: 660, size: 12, font, color: BLACK });
  labeled(p1, '{{agent_name}}', 36, 638);
  labeled(p1, '{{agent_license_number}}', 36, 612);
  labeled(p1, '{{consumer_name}}', 36, 586);
  labeled(p1, '{{consumer_email}}', 36, 560);
  labeled(p1, '{{consumer_phone}}', 36, 534);

  p1.drawText('2. SCOPE', { x: 36, y: 490, size: 12, font, color: BLACK });
  labeled(p1, '{{property_type}}', 36, 468);
  labeled(p1, '{{search_area}}', 36, 442);
  labeled(p1, '{{term_days}}', 36, 416);

  p1.drawText('3. PLACEHOLDER LEGAL BODY', { x: 36, y: 380, size: 12, font, color: BLACK });
  p1.drawText('This document is a non-binding placeholder used for engineering smoke tests. It will', {
    x: 36,
    y: 360,
    size: 10,
    font: fontReg,
    color: BLACK,
  });
  p1.drawText('be replaced with a legally reviewed buyer-representation agreement before any', {
    x: 36,
    y: 346,
    size: 10,
    font: fontReg,
    color: BLACK,
  });
  p1.drawText('consumer-facing pilot. (DEV-657 / legal swap)', {
    x: 36,
    y: 332,
    size: 10,
    font: fontReg,
    color: BLACK,
  });

  // --- Page 2 ---
  const p2 = pdf.addPage([612, 792]);
  draftBanner(p2);

  p2.drawText('4. COMPENSATION', { x: 36, y: 720, size: 12, font, color: BLACK });
  labeled(p2, '{{commission_percent}} (percent)', 36, 698);

  p2.drawText('5. SIGNATURE', { x: 36, y: 640, size: 12, font, color: BLACK });
  p2.drawText('By signing below, Consumer acknowledges receipt of this placeholder document.', {
    x: 36,
    y: 618,
    size: 10,
    font: fontReg,
    color: BLACK,
  });
  labeled(p2, 'Consumer signature', 36, 568);
  labeled(p2, '{{signing_date}}', 320, 568);

  const bytes = await pdf.save();
  const out = join(__dirname, 'dev-657-buyer-rep-placeholder.pdf');
  writeFileSync(out, bytes);
  console.log(`Wrote ${out} (${bytes.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
