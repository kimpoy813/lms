import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads plain rows and ignores a byte-order mark', () => {
    expect(parseCsv('\ufeffa,b,c\r\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('keeps commas, quotes and line breaks inside quoted fields', () => {
    expect(parseCsv('name,note\n"Dela Cruz, Juan","said ""hi""\nthen left"')).toEqual([['name', 'note'], ['Dela Cruz, Juan', 'said "hi"\nthen left']]);
  });
  it('keeps empty fields and a last line without a line break', () => {
    expect(parseCsv('a,,c\n,,')).toEqual([['a', '', 'c'], ['', '', '']]);
  });
  it('accepts semicolons when the header uses them', () => {
    expect(parseCsv('role;email\nSTUDENT;a@b.ph')).toEqual([['role', 'email'], ['STUDENT', 'a@b.ph']]);
  });
});

describe('toCsv', () => {
  it('quotes what needs quoting and round-trips through parseCsv', () => {
    const rows = [['name', 'note'], ['Dela Cruz, Juan', 'said "hi"\nbye'], ['plain', '']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('neutralises cells a spreadsheet would treat as a formula, but leaves numbers alone', () => {
    expect(toCsv([['=HYPERLINK("x")', '-5', '+63 917', '@cmd']])).toBe('"\'=HYPERLINK(""x"")",-5,\'+63 917,\'@cmd\r\n');
  });
});
