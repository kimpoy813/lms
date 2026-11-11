// PDF helpers built on pdfkit: a paginated table report and a simple "document" renderer.
import PDFDocument from 'pdfkit';

const MARGIN = 36;
const COLORS = { text: '#111827', muted: '#6b7280', line: '#d1d5db', header: '#eef2ff', zebra: '#f9fafb', accent: '#4338ca' };

// The built-in PDF fonts only cover WinAnsi (Latin-1 plus a few symbols). Anything else would be
// drawn as garbage, so unsupported characters are transliterated or replaced.
const REPLACEMENTS = { '\u2192': '->', '\u2190': '<-', '\u2265': '>=', '\u2264': '<=', '\u2260': '!=', '\u2713': 'v', '\u2714': 'v', '\u2717': 'x', '\u00a0': ' ', '\u2212': '-', '\u2011': '-', '\u2010': '-', '\u00d7': 'x' };
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export function pdfSafe(value) {
  const text = String(value ?? '');
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0);
    if (ch === '\n' || ch === '\t' || (code >= 32 && code <= 126) || (code >= 161 && code <= 255) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else {
      // Try to keep the base letter of accented characters outside Latin-1.
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += base.length === 1 && base.charCodeAt(0) < 127 ? base : '?';
    }
  }
  return out;
}

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function pageFooters(doc, footerText) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - MARGIN + 8;
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted);
    // lineBreak:false + explicit position keeps pdfkit from adding pages while drawing footers.
    doc.text(pdfSafe(footerText ?? ''), MARGIN, y, { lineBreak: false });
    const label = `Page ${i + 1} of ${range.count}`;
    doc.text(label, doc.page.width - MARGIN - doc.widthOfString(label), y, { lineBreak: false });
  }
}

/**
 * Render a table report.
 * @param {{ title: string, subtitle?: string, meta?: string[], columns: Array<{ header: string, value: (row: any) => unknown, width?: number, align?: 'left'|'right'|'center' }>,
 *           rows: any[], landscape?: boolean, footer?: string, summary?: string[] }} report
 * @returns {Promise<Buffer>}
 */
export async function buildTablePdf(report) {
  const doc = new PDFDocument({ size: 'A4', layout: report.landscape ? 'landscape' : 'portrait', margin: MARGIN, bufferPages: true, info: { Title: pdfSafe(report.title) } });
  const done = collect(doc);
  const usable = doc.page.width - MARGIN * 2;
  const totalWeight = report.columns.reduce((s, c) => s + (c.width ?? 1), 0);
  const widths = report.columns.map((c) => ((c.width ?? 1) / totalWeight) * usable);
  const fontSize = report.columns.length > 9 ? 7 : report.columns.length > 6 ? 8 : 9;
  const pad = 4;

  doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.text).text(pdfSafe(report.title), { width: usable });
  if (report.subtitle) doc.moveDown(0.15).font('Helvetica').fontSize(10).fillColor(COLORS.muted).text(pdfSafe(report.subtitle), { width: usable });
  for (const line of report.meta ?? []) doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text(pdfSafe(line), { width: usable });
  doc.moveDown(0.6);

  const bottom = () => doc.page.height - MARGIN - 14;
  const drawRow = (cells, { header = false, zebra = false } = {}) => {
    doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    const texts = cells.map((c) => pdfSafe(c === null || c === undefined ? '' : c));
    const height = Math.max(...texts.map((t, i) => doc.heightOfString(t, { width: widths[i] - pad * 2 }))) + pad * 2;
    if (doc.y + height > bottom()) {
      doc.addPage();
      if (!header) drawRow(report.columns.map((c) => c.header), { header: true });
    }
    const y = doc.y;
    if (header || zebra) doc.rect(MARGIN, y, usable, height).fill(header ? COLORS.header : COLORS.zebra);
    doc.fillColor(COLORS.text).font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    let x = MARGIN;
    texts.forEach((t, i) => {
      doc.text(t, x + pad, y + pad, { width: widths[i] - pad * 2, align: report.columns[i].align ?? 'left' });
      x += widths[i];
    });
    doc.moveTo(MARGIN, y + height).lineTo(MARGIN + usable, y + height).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    doc.x = MARGIN;
    doc.y = y + height;
  };

  drawRow(report.columns.map((c) => c.header), { header: true });
  if (report.rows.length === 0) {
    doc.moveDown(0.8).font('Helvetica-Oblique').fontSize(10).fillColor(COLORS.muted).text('No records.', MARGIN, doc.y, { width: usable });
  }
  report.rows.forEach((row, i) => drawRow(report.columns.map((c) => c.value(row)), { zebra: i % 2 === 1 }));

  if (report.summary?.length) {
    doc.moveDown(0.8);
    for (const line of report.summary) {
      if (doc.y + 14 > bottom()) doc.addPage();
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.text).text(pdfSafe(line), MARGIN, doc.y, { width: usable });
    }
  }
  pageFooters(doc, report.footer);
  doc.end();
  return done;
}

/**
 * Render a simple structured document (used for learning-module and record exports).
 * blocks: { type: 'h1'|'h2'|'h3'|'p'|'li'|'code'|'note'|'rule', text?: string }
 * @returns {Promise<Buffer>}
 */
export async function buildDocumentPdf({ title, subtitle, blocks, footer }) {
  const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true, info: { Title: pdfSafe(title) } });
  const done = collect(doc);
  const width = doc.page.width - 108;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(COLORS.text).text(pdfSafe(title), { width });
  if (subtitle) doc.moveDown(0.2).font('Helvetica').fontSize(10.5).fillColor(COLORS.muted).text(pdfSafe(subtitle), { width });
  doc.moveDown(0.8);
  for (const block of blocks) {
    const text = pdfSafe(block.text ?? '');
    switch (block.type) {
      case 'h1':
        doc.moveDown(0.6).font('Helvetica-Bold').fontSize(15).fillColor(COLORS.accent).text(text, { width });
        doc.moveDown(0.25);
        break;
      case 'h2':
        doc.moveDown(0.4).font('Helvetica-Bold').fontSize(12.5).fillColor(COLORS.text).text(text, { width });
        doc.moveDown(0.2);
        break;
      case 'h3':
        doc.moveDown(0.3).font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text).text(text, { width });
        doc.moveDown(0.1);
        break;
      case 'li':
        doc.font('Helvetica').fontSize(10.5).fillColor(COLORS.text).text(`${block.marker ?? '•'}  ${text}`, { width: width - 14, indent: 0, paragraphGap: 2, lineGap: 1.5 });
        break;
      case 'code':
        doc.moveDown(0.2).font('Courier').fontSize(9).fillColor(COLORS.text).text(text, { width, lineGap: 1 });
        doc.moveDown(0.3);
        break;
      case 'note':
        doc.moveDown(0.2).font('Helvetica-Oblique').fontSize(9.5).fillColor(COLORS.muted).text(text, { width, lineGap: 1.5 });
        doc.moveDown(0.2);
        break;
      case 'rule':
        doc.moveDown(0.4);
        doc.moveTo(54, doc.y).lineTo(54 + width, doc.y).lineWidth(0.5).strokeColor(COLORS.line).stroke();
        doc.moveDown(0.4);
        break;
      default:
        doc.font('Helvetica').fontSize(10.5).fillColor(COLORS.text).text(text, { width, align: 'left', paragraphGap: 5, lineGap: 2 });
    }
  }
  pageFooters(doc, footer);
  doc.end();
  return done;
}
