import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fillGradebookTemplate, GradebookTemplateError } from '../../src/lib/gradebookTemplate.js';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const columns = [
  { header: 'Student No.', value: (student) => student.studentNumber },
  { header: 'Name', value: (student) => `${student.lastName}, ${student.firstName}` },
  { header: 'Quiz 1 (50)', value: (student) => student.quiz },
  { header: 'Final %', value: (student) => student.percent },
  { header: 'Grade', value: (student) => student.grade },
];

const students = [
  { id: 's1', studentNumber: 'SN-001', firstName: 'Juan', lastName: 'Cruz', quiz: 45, percent: 90, grade: '1.75' },
  { id: 's2', studentNumber: 'SN-002', firstName: 'Maria', lastName: 'Santos', quiz: 40, percent: 80, grade: '2.00' },
];

async function excelTemplate() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Template');
  sheet.addRow(['Student Number', 'Student Name', 'Quiz 1 (50)', 'Final %', 'Grade']);
  sheet.addRow(['SN-001', 'An outdated name', 0, 0, 'old']);
  sheet.addRow(['EXTERNAL', 'Keep this row', 12, 70, 'external']);
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}

const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const wordRow = (values) => `<w:tr>${values.map((value) => `<w:tc><w:p><w:r><w:t>${escapeXml(value)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`;

function wordTemplate() {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WORD_NS}"><w:body><w:tbl>${[
    ['Student Number', 'Student Name', 'Quiz 1 (50)', 'Final %', 'Grade'],
    ['SN-001', 'An outdated name', '0', '0', 'old'],
    ['EXTERNAL', 'Keep this row', '12', '70', 'external'],
  ].map(wordRow).join('')}</w:tbl></w:body></w:document>`;
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'word/document.xml': strToU8(documentXml),
  }));
}

function wordTableRows(buffer) {
  const documentXml = strFromU8(unzipSync(new Uint8Array(buffer))['word/document.xml']);
  const rows = [...documentXml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)];
  return rows.map(([, row]) => [...row.matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map(([, cell]) =>
    [...cell.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(([, text]) => text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')).join(''),
  ));
}

describe('gradebook template population', () => {
  it('fills an Excel template by student number and appends students not already listed', async () => {
    const result = await fillGradebookTemplate(await excelTemplate(), '.xlsx', columns, students);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer);
    const sheet = workbook.getWorksheet('Template');

    expect(result).toMatchObject({ matched: 1, added: 1, target: 'Template' });
    expect(sheet.rowCount).toBe(4);
    expect(sheet.getRow(2).values.slice(1)).toEqual(['SN-001', 'Cruz, Juan', 45, 90, '1.75']);
    expect(sheet.getRow(3).values.slice(1)).toEqual(['EXTERNAL', 'Keep this row', 12, 70, 'external']);
    expect(sheet.getRow(4).values.slice(1)).toEqual(['SN-002', 'Santos, Maria', 40, 80, '2.00']);
  });

  it('fills a Word table and appends missing students as one row each', async () => {
    const result = await fillGradebookTemplate(wordTemplate(), '.docx', columns, students);

    expect(result).toMatchObject({ matched: 1, added: 1, target: 'Word table' });
    expect(wordTableRows(result.buffer)).toEqual([
      ['Student Number', 'Student Name', 'Quiz 1 (50)', 'Final %', 'Grade'],
      ['SN-001', 'Cruz, Juan', '45', '90', '1.75'],
      ['EXTERNAL', 'Keep this row', '12', '70', 'external'],
      ['SN-002', 'Santos, Maria', '40', '80', '2.00'],
    ]);
  });

  it('refuses ambiguous name-only matching rather than assigning a grade to the wrong student', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Template');
    sheet.addRow(['Name', 'Quiz 1 (50)']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const duplicateNames = [
      { ...students[0], firstName: 'Alex', lastName: 'Lee' },
      { ...students[1], firstName: 'Alex', lastName: 'Lee' },
    ];
    const nameColumns = columns.filter((column) => column.header !== 'Student No.');

    await expect(fillGradebookTemplate(buffer, '.xlsx', nameColumns, duplicateNames))
      .rejects.toThrow(/same name.*Student No/i);
  });

  it('rejects non-Office files and unsupported extensions', async () => {
    await expect(fillGradebookTemplate(Buffer.from('not a workbook'), '.xlsx', columns, students))
      .rejects.toBeInstanceOf(GradebookTemplateError);
    const buffer = await excelTemplate();
    await expect(fillGradebookTemplate(buffer, '.xls', columns, students))
      .rejects.toThrow(/Upload an Excel/);
  });
});
