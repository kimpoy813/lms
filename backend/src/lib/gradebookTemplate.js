// Fill a teacher-provided Excel or Word table with the class's current gradebook export.
// Uploaded bytes are parsed in memory, returned immediately, and never stored.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;
const HEADER_SCAN_ROWS = 30;
const MAX_CELL_TEXT = 32_000;

const normalizeHeader = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const HEADER_ALIASES = new Map([
  ['student number', 'student no'],
  ['student id', 'student no'],
  ['student number id', 'student no'],
  ['id number', 'student no'],
  ['id no', 'student no'],
  ['learner number', 'student no'],
  ['learner id', 'student no'],
  ['full name', 'name'],
  ['student name', 'name'],
  ['name of student', 'name'],
  ['learner name', 'name'],
  ['final grade', 'grade'],
  ['letter grade', 'grade'],
  ['grade equivalent', 'grade'],
  ['remarks', 'remark'],
  ['comments', 'remark'],
  ['enrollment status', 'status'],
  ['enrolment status', 'status'],
  ['final percentage', 'final'],
  ['overall percentage', 'final'],
]);

export class GradebookTemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GradebookTemplateError';
  }
}

function assertOfficeZip(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new GradebookTemplateError('This file is not a valid Excel or Word document.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstPossible = Math.max(0, bytes.length - 22 - 65_535);
  let endRecord = -1;
  for (let at = bytes.length - 22; at >= firstPossible; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      endRecord = at;
      break;
    }
  }
  if (endRecord < 0) throw new GradebookTemplateError('The uploaded document is not a valid Office file.');

  const commentLength = view.getUint16(endRecord + 20, true);
  if (endRecord + 22 + commentLength !== bytes.length) {
    throw new GradebookTemplateError('The uploaded document is not a valid Office file.');
  }
  const entryCount = view.getUint16(endRecord + 10, true);
  const directoryBytes = view.getUint32(endRecord + 12, true);
  const directoryOffset = view.getUint32(endRecord + 16, true);
  if (
    entryCount === 0xffff
    || directoryBytes === 0xffffffff
    || directoryOffset === 0xffffffff
    || entryCount > MAX_ARCHIVE_ENTRIES
    || directoryOffset + directoryBytes > endRecord
  ) {
    throw new GradebookTemplateError('This Office file is too large or uses an unsupported archive format.');
  }

  let totalUncompressed = 0;
  let at = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
      throw new GradebookTemplateError('The uploaded document is not a valid Office file.');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedBytes = view.getUint32(at + 20, true);
    const uncompressedBytes = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const entryCommentLength = view.getUint16(at + 32, true);
    if (
      (flags & 1) !== 0
      || ![0, 8].includes(method)
      || compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
    ) {
      throw new GradebookTemplateError('This Office file is encrypted or uses an unsupported archive format.');
    }
    totalUncompressed += uncompressedBytes;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES || totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new GradebookTemplateError('The expanded template is too large to process safely.');
    }
    at += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (at !== directoryOffset + directoryBytes) {
    throw new GradebookTemplateError('The uploaded document is not a valid Office file.');
  }
}

function columnLookup(columns) {
  const byHeader = new Map();
  for (const column of columns) {
    const key = normalizeHeader(column.header);
    if (key && !byHeader.has(key)) byHeader.set(key, column);
  }
  return byHeader;
}

function mappedColumn(header, byHeader) {
  const key = normalizeHeader(header);
  const direct = byHeader.get(key);
  if (direct) return direct;
  const canonical = HEADER_ALIASES.get(key);
  return canonical ? byHeader.get(canonical) ?? null : null;
}

function mapHeaders(headers, columns) {
  const byHeader = columnLookup(columns);
  const mappings = [];
  for (const [templateIndex, header] of headers.entries()) {
    const source = mappedColumn(header, byHeader);
    if (source) mappings.push({ templateIndex, source });
  }
  const identity = (source) => normalizeHeader(source.header);
  const studentNo = mappings.find((mapping) => identity(mapping.source) === 'student no');
  const name = mappings.find((mapping) => identity(mapping.source) === 'name');
  const gradeColumns = mappings.filter((mapping) => !['student no', 'name', 'status'].includes(identity(mapping.source)));
  if ((!studentNo && !name) || gradeColumns.length === 0) return null;
  return { mappings, studentNo, name, gradeColumns };
}

function studentNumberKey(value) {
  return normalizeHeader(value).replace(/\s+/g, '');
}

function studentNameKey(value) {
  return normalizeHeader(value).split(' ').filter(Boolean).sort().join(' ');
}

function buildStudentLookups(rows, mapping) {
  const studentNoColumn = mapping.studentNo?.source;
  const nameColumn = mapping.name?.source;
  const byStudentNo = new Map();
  const byName = new Map();
  const duplicateStudentNumbers = new Set();
  const ambiguousNames = new Set();
  for (const row of rows) {
    const studentNo = studentNoColumn ? studentNoColumn.value(row) : row.studentNumber;
    const name = nameColumn ? nameColumn.value(row) : `${row.lastName ?? ''}, ${row.firstName ?? ''}`;
    const idKey = studentNumberKey(studentNo);
    if (idKey) {
      const existing = byStudentNo.get(idKey);
      if (existing && existing.id !== row.id) duplicateStudentNumbers.add(idKey);
      else byStudentNo.set(idKey, row);
    }
    const nameKey = studentNameKey(name);
    if (nameKey) {
      const existing = byName.get(nameKey);
      if (existing && existing.id !== row.id) ambiguousNames.add(nameKey);
      else byName.set(nameKey, row);
    }
  }
  if (mapping.studentNo && duplicateStudentNumbers.size > 0) {
    throw new GradebookTemplateError('This class has duplicate student numbers. Correct them before filling a template so grades are matched safely.');
  }
  if (!mapping.studentNo && ambiguousNames.size > 0) {
    throw new GradebookTemplateError('This class has students with the same name. Add a Student No. (or Student Number) column so the template can match them safely.');
  }
  return { byStudentNo, byName, ambiguousNames };
}

function matchStudent({ studentNo, name, lookups }) {
  const idKey = studentNumberKey(studentNo);
  if (idKey) return lookups.byStudentNo.get(idKey) ?? null;
  const nameKey = studentNameKey(name);
  if (!nameKey) return null;
  if (lookups.ambiguousNames.has(nameKey)) {
    throw new GradebookTemplateError(`The name “${String(name).slice(0, 80)}” is shared by more than one student. Add a Student No. column to the template.`);
  }
  return lookups.byName.get(nameKey) ?? null;
}

function textOfExcelCell(cell) {
  if (cell?.text !== undefined && cell.text !== '') return String(cell.text);
  const value = cell?.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('');
    if ('text' in value) return String(value.text ?? '');
    if ('result' in value) return String(value.result ?? '');
  }
  return String(value);
}

function rowCellText(row, columnNumber) {
  return textOfExcelCell(row.getCell(columnNumber));
}

function rowHasAnyValue(row, maxColumn) {
  for (let column = 1; column <= maxColumn; column += 1) {
    const value = row.getCell(column).value;
    if (value !== null && value !== undefined && value !== '') return true;
  }
  return false;
}

function copyExcelRowStyle(from, to, maxColumn) {
  to.height = from.height;
  to.hidden = from.hidden;
  to.outlineLevel = from.outlineLevel;
  for (let column = 1; column <= maxColumn; column += 1) {
    const source = from.getCell(column);
    const target = to.getCell(column);
    if (source.style && Object.keys(source.style).length > 0) target.style = structuredClone(source.style);
  }
}

function findExcelTemplate(worksheet, columns) {
  const rowsToScan = HEADER_SCAN_ROWS;
  let best = null;
  for (let rowNumber = 1; rowNumber <= rowsToScan; rowNumber += 1) {
    const row = worksheet.findRow(rowNumber);
    if (!row) continue;
    const maxColumn = Math.min(Math.max(row.cellCount, worksheet.columnCount), MAX_COLUMNS);
    if (maxColumn === 0) continue;
    const headers = Array.from({ length: maxColumn }, (_, i) => textOfExcelCell(row.getCell(i + 1)));
    const mapping = mapHeaders(headers, columns);
    if (!mapping) continue;
    const score = mapping.mappings.length + (mapping.studentNo ? 2 : 0);
    if (!best || score > best.score) best = { rowNumber, maxColumn, mapping, score };
  }
  return best;
}

function setExcelRow(row, mapping, student) {
  for (const { templateIndex, source } of mapping.mappings) {
    const value = source.value(student);
    row.getCell(templateIndex + 1).value = value === null || value === undefined ? '' : value;
  }
}

async function fillExcel(buffer, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new GradebookTemplateError('This file could not be read as an Excel .xlsx workbook.');
  }
  if (workbook.worksheets.length === 0) throw new GradebookTemplateError('The Excel file has no worksheets.');

  let candidate = null;
  for (const worksheet of workbook.worksheets) {
    if (worksheet.rowCount > MAX_ROWS || worksheet.columnCount > MAX_COLUMNS) continue;
    const found = findExcelTemplate(worksheet, columns);
    if (found && (!candidate || found.score > candidate.score)) candidate = { worksheet, ...found };
  }
  if (!candidate) {
    throw new GradebookTemplateError('No matching grade table was found. Add a header row with Student No. (or Name) and at least one grade column using the same labels as the grade export.');
  }

  const { worksheet, rowNumber: headerRowNumber, maxColumn, mapping } = candidate;
  const lookups = buildStudentLookups(rows, mapping);
  const existingStudents = new Set();
  const blankRows = [];
  let lastUsedRow = headerRowNumber;

  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const idText = mapping.studentNo ? rowCellText(row, mapping.studentNo.templateIndex + 1) : '';
    const nameText = mapping.name ? rowCellText(row, mapping.name.templateIndex + 1) : '';
    const student = matchStudent({ studentNo: idText, name: nameText, lookups });
    if (student) {
      setExcelRow(row, mapping, student);
      existingStudents.add(student.id);
      lastUsedRow = Math.max(lastUsedRow, rowNumber);
    } else if (rowHasAnyValue(row, Math.max(maxColumn, worksheet.columnCount))) {
      lastUsedRow = Math.max(lastUsedRow, rowNumber);
    } else {
      blankRows.push(rowNumber);
    }
  }

  const styleSource = worksheet.findRow(headerRowNumber + 1);
  let nextRowNumber = lastUsedRow + 1;
  let added = 0;
  for (const student of rows) {
    if (existingStudents.has(student.id)) continue;
    const rowNumber = blankRows.shift() ?? nextRowNumber++;
    const row = worksheet.getRow(rowNumber);
    if (styleSource && !rowHasAnyValue(row, Math.max(maxColumn, worksheet.columnCount))) copyExcelRowStyle(styleSource, row, Math.max(maxColumn, worksheet.columnCount));
    setExcelRow(row, mapping, student);
    added += 1;
  }

  try {
    const output = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(output), matched: rows.length - added, added, target: worksheet.name };
  } catch {
    throw new GradebookTemplateError('The completed Excel workbook could not be created. Try saving the template again as .xlsx.');
  }
}

function directWordChildren(node, localName) {
  return Array.from(node?.childNodes ?? []).filter((child) =>
    child.nodeType === 1 && child.namespaceURI === WORD_NS && child.localName === localName,
  );
}

function wordCells(row) {
  return directWordChildren(row, 'tc');
}

function wordCellText(cell) {
  return Array.from(cell.getElementsByTagNameNS(WORD_NS, 't')).map((node) => node.textContent ?? '').join('');
}

function findWordTemplate(document, columns) {
  const tables = Array.from(document.getElementsByTagNameNS(WORD_NS, 'tbl'));
  let best = null;
  for (const table of tables) {
    const tableRows = directWordChildren(table, 'tr');
    if (tableRows.length > MAX_ROWS) continue;
    for (const [rowIndex, row] of tableRows.slice(0, HEADER_SCAN_ROWS).entries()) {
      const cells = wordCells(row);
      if (cells.length === 0 || cells.length > MAX_COLUMNS) continue;
      const mapping = mapHeaders(cells.map(wordCellText), columns);
      if (!mapping) continue;
      const score = mapping.mappings.length + (mapping.studentNo ? 2 : 0);
      if (!best || score > best.score) best = { table, tableRows, headerRowIndex: rowIndex, headerRow: row, mapping, score };
    }
  }
  return best;
}

function removeBold(runProperties) {
  for (const tag of ['b', 'bCs']) {
    for (const node of directWordChildren(runProperties, tag)) runProperties.removeChild(node);
  }
}

function replaceWordCellText(document, cell, value, { unbold = false } = {}) {
  let paragraph = directWordChildren(cell, 'p')[0];
  if (!paragraph) {
    paragraph = document.createElementNS(WORD_NS, 'w:p');
    cell.appendChild(paragraph);
  }
  const paragraphProperties = directWordChildren(paragraph, 'pPr')[0] ?? null;
  const originalRuns = Array.from(cell.getElementsByTagNameNS(WORD_NS, 'r'));
  const runProperties = originalRuns.length ? directWordChildren(originalRuns[0], 'rPr')[0] : null;
  for (const child of Array.from(paragraph.childNodes)) {
    if (child !== paragraphProperties) paragraph.removeChild(child);
  }
  for (const otherParagraph of directWordChildren(cell, 'p')) {
    if (otherParagraph !== paragraph) cell.removeChild(otherParagraph);
  }
  const run = document.createElementNS(WORD_NS, 'w:r');
  if (runProperties) {
    const props = runProperties.cloneNode(true);
    if (unbold) removeBold(props);
    run.appendChild(props);
  }
  const text = document.createElementNS(WORD_NS, 'w:t');
  text.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  const safeValue = String(value ?? '')
    // XML 1.0 forbids these characters; remove them before inserting user text.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .slice(0, MAX_CELL_TEXT);
  text.appendChild(document.createTextNode(safeValue));
  run.appendChild(text);
  paragraph.appendChild(run);
}

function wordRowHasText(row) {
  return wordCells(row).some((cell) => wordCellText(cell).trim() !== '');
}

function fillWordRow(document, row, mapping, student, { unbold = false } = {}) {
  const cells = wordCells(row);
  for (const { templateIndex, source } of mapping.mappings) {
    const cell = cells[templateIndex];
    if (cell) replaceWordCellText(document, cell, source.value(student), { unbold });
  }
}

function blankWordRow(document, sourceRow) {
  const row = sourceRow.cloneNode(true);
  for (const cell of wordCells(row)) replaceWordCellText(document, cell, '', { unbold: true });
  const rowProperties = directWordChildren(row, 'trPr')[0];
  if (rowProperties) {
    for (const repeatHeader of directWordChildren(rowProperties, 'tblHeader')) rowProperties.removeChild(repeatHeader);
  }
  return row;
}

function parseWordXml(xml) {
  const errors = [];
  let document;
  try {
    document = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') errors.push(message);
      },
    }).parseFromString(xml, 'application/xml');
  } catch {
    throw new GradebookTemplateError('The Word document contains invalid XML.');
  }
  if (errors.length > 0 || !document?.documentElement) throw new GradebookTemplateError('The Word document contains invalid XML.');
  return document;
}

function fillWord(buffer, columns, rows) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new GradebookTemplateError('This file could not be read as a Word .docx document.');
  }
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes) throw new GradebookTemplateError('This file has no Word document body. Save it as a .docx file and try again.');
  const document = parseWordXml(strFromU8(xmlBytes));
  const candidate = findWordTemplate(document, columns);
  if (!candidate) {
    throw new GradebookTemplateError('No matching Word table was found. Add a table with a header row containing Student No. (or Name) and at least one grade column using the same labels as the grade export.');
  }

  const { table, tableRows, headerRowIndex, headerRow, mapping } = candidate;
  const lookups = buildStudentLookups(rows, mapping);
  const existingStudents = new Set();
  const blankRows = [];
  for (const row of tableRows.slice(headerRowIndex + 1)) {
    const cells = wordCells(row);
    const idText = mapping.studentNo ? wordCellText(cells[mapping.studentNo.templateIndex]) : '';
    const nameText = mapping.name ? wordCellText(cells[mapping.name.templateIndex]) : '';
    const student = matchStudent({ studentNo: idText, name: nameText, lookups });
    if (student) {
      fillWordRow(document, row, mapping, student);
      existingStudents.add(student.id);
    } else if (!wordRowHasText(row)) {
      blankRows.push(row);
    }
  }

  const styleSource = tableRows[headerRowIndex + 1] ?? headerRow;
  let added = 0;
  for (const student of rows) {
    if (existingStudents.has(student.id)) continue;
    const row = blankRows.shift() ?? blankWordRow(document, styleSource);
    if (!row.parentNode) table.appendChild(row);
    fillWordRow(document, row, mapping, student, { unbold: row === styleSource || row.parentNode === null });
    existingStudents.add(student.id);
    added += 1;
  }

  try {
    files['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(document));
    return { buffer: Buffer.from(zipSync(files, { level: 6 })), matched: rows.length - added, added, target: 'Word table' };
  } catch {
    throw new GradebookTemplateError('The completed Word document could not be created. Try saving the template again as .docx.');
  }
}

/**
 * Fill the best-matching worksheet or Word table. Header labels are matched to the normal
 * gradebook export columns; student rows are matched by student number where available, otherwise
 * by a unique name. Unmatched students are placed in blank template rows or appended.
 *
 * @param {Buffer} buffer
 * @param {string} extension `.xlsx` or `.docx`
 * @param {Array<{header: string, value: (row: any) => unknown}>} columns
 * @param {any[]} rows
 */
export async function fillGradebookTemplate(buffer, extension, columns, rows) {
  assertOfficeZip(buffer);
  if (extension === '.xlsx') return fillExcel(buffer, columns, rows);
  if (extension === '.docx') return fillWord(buffer, columns, rows);
  throw new GradebookTemplateError('Upload an Excel .xlsx workbook or a Word .docx document.');
}
