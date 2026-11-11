// CSV generation and parsing (RFC 4180).

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Escape one cell. Text that a spreadsheet would interpret as a formula is prefixed with an
 * apostrophe so exported student-supplied text can never execute as a formula ("CSV injection").
 * Real numbers are written unchanged.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (value instanceof Date) return value.toISOString();
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {Array<{ header: string, value: (row: any) => unknown }>} columns
 * @param {any[]} rows
 * @returns {string} CSV text with a UTF-8 BOM so Excel detects the encoding
 */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** Parse CSV text into an array of rows (arrays of strings). Handles quotes and embedded newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = String(text ?? '').replace(/^\ufeff/, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.send(csv);
}
