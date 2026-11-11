// Turn sanitised lesson HTML into simple blocks, and blocks into a Word document.
// The same blocks feed lib/pdf.js (buildDocumentPdf), so PDF and DOCX exports stay identical.
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { Parser } from 'htmlparser2';

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote', 'tr', 'figcaption']);
const HEADING = { h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };

/** @returns {Array<{ type: 'h2'|'h3'|'p'|'li'|'code'|'note', text: string }>} */
export function htmlToBlocks(html) {
  const blocks = [];
  let current = null;
  const stack = [];
  let ordered = [];
  const flush = () => {
    if (current) {
      const text = current.type === 'code' ? current.text.replace(/\s+$/, '') : current.text.replace(/[ \t\u00a0]+/g, ' ').trim();
      if (text) blocks.push({ type: current.type, text });
    }
    current = null;
  };
  const open = (type, prefix = '') => {
    flush();
    current = { type, text: prefix };
  };
  const parser = new Parser(
    {
      onopentag(name) {
        stack.push(name);
        if (name === 'ol') ordered.push(0);
        if (name === 'ul') ordered.push(null);
        if (HEADING[name]) open(HEADING[name]);
        else if (name === 'li') {
          const top = ordered.length - 1;
          if (top >= 0 && ordered[top] !== null) {
            ordered[top] += 1;
            open('li', `${ordered[top]}. `);
          } else open('li');
        } else if (name === 'pre') open('code');
        else if (name === 'blockquote') open('note');
        else if (name === 'br') {
          if (current) current.text += current.type === 'code' ? '\n' : ' ';
        } else if (name === 'td' || name === 'th') {
          if (current && current.text.trim()) current.text += '  |  ';
        } else if (BLOCK_TAGS.has(name) && !(current && (current.type === 'li' || current.type === 'note') && name === 'p')) open('p');
      },
      ontext(text) {
        if (stack.includes('script') || stack.includes('style')) return;
        if (!current) {
          if (!text.trim()) return;
          current = { type: 'p', text: '' };
        }
        current.text += current.type === 'code' ? text : text.replace(/\s+/g, ' ');
      },
      onclosetag(name) {
        stack.pop();
        if (name === 'ol' || name === 'ul') ordered.pop();
        if (BLOCK_TAGS.has(name) || HEADING[name]) flush();
      },
    },
    { decodeEntities: true },
  );
  parser.write(String(html ?? ''));
  parser.end();
  flush();
  return blocks;
}

/** @returns {Promise<Buffer>} a .docx file */
export async function buildDocumentDocx({ title, subtitle, blocks, footer }) {
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  if (subtitle) children.push(new Paragraph({ children: [new TextRun({ text: subtitle, color: '666666', size: 21 })], spacing: { after: 240 } }));
  for (const b of blocks) {
    const text = b.text ?? '';
    switch (b.type) {
      case 'h1':
        children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 } }));
        break;
      case 'h2':
        children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 } }));
        break;
      case 'h3':
        children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 180, after: 80 } }));
        break;
      case 'li':
        children.push(/^\d+\. /.test(text) ? new Paragraph({ text, indent: { left: 360 }, spacing: { after: 60 } }) : new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 60 } }));
        break;
      case 'code':
        for (const line of text.split('\n')) children.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 19 })], shading: { fill: 'F3F4F6' }, spacing: { after: 0 } }));
        children.push(new Paragraph({ text: '' }));
        break;
      case 'note':
        children.push(new Paragraph({ children: [new TextRun({ text, italics: true, color: '555555' })], indent: { left: 360 }, spacing: { after: 120 } }));
        break;
      case 'rule':
        children.push(new Paragraph({ text: '', border: { bottom: { color: 'CCCCCC', style: 'single', size: 6, space: 1 } }, spacing: { after: 160 } }));
        break;
      default:
        children.push(new Paragraph({ text, spacing: { after: 120 } }));
    }
  }
  if (footer) children.push(new Paragraph({ children: [new TextRun({ text: footer, color: '888888', size: 17 })], alignment: AlignmentType.CENTER, spacing: { before: 400 } }));
  const doc = new Document({ creator: 'EduSphere', title, styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }, sections: [{ children }] });
  return Packer.toBuffer(doc);
}
