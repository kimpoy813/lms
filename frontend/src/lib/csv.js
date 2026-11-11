// Minimal CSV reading and writing (RFC 4180): quoted fields, doubled quotes, commas and line
// breaks inside quotes. Used for the account import and for downloads built in the browser.

/** Parse CSV text into an array of rows, each an array of strings. Accepts "," or ";" as the separator. */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\ufeff/, '');
  // Spreadsheets in some locales export with semicolons: use whichever appears first outside quotes on line one.
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === separator) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Rows → CSV text. Cells that a spreadsheet would run as a formula (= + - @) are prefixed with
 * an apostrophe so that opening the file can never execute anything.
 */
export function toCsv(rows) {
  const cell = (value) => {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
