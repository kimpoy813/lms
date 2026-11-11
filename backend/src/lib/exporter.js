// One entry point for tabular downloads in CSV, Excel or PDF.
import { z } from 'zod';
import { sendCsv, toCsv } from './csv.js';
import { buildTablePdf } from './pdf.js';
import { buildXlsx } from './xlsx.js';

export const exportFormat = z.enum(['csv', 'xlsx', 'pdf']).default('csv');

export const safeFilename = (name) =>
  String(name)
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    // Never a hidden file or a ".." path segment (these names also become ZIP entry names).
    .replace(/^\.+/, '')
    .slice(0, 100) || 'export';

export function sendBuffer(res, buffer, filename, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}"`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buffer);
}

/**
 * @param {import('express').Response} res
 * @param {'csv'|'xlsx'|'pdf'} format
 * @param {{ filename: string, title: string, subtitle?: string, meta?: string[], columns: Array<{ header: string, value: (row: any) => unknown, width?: number, pdfWidth?: number, align?: string }>,
 *           rows: any[], landscape?: boolean, footer?: string, summary?: string[], sheetName?: string }} table
 */
export async function sendTable(res, format, table) {
  if (format === 'xlsx') {
    const buffer = buildXlsx([
      { name: table.sheetName ?? table.title, columns: table.columns, rows: table.rows, titleRows: [table.title, ...(table.subtitle ? [table.subtitle] : []), ...(table.meta ?? [])] },
    ]);
    return sendBuffer(res, buffer, `${table.filename}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  if (format === 'pdf') {
    const buffer = await buildTablePdf({ ...table, columns: table.columns.map((c) => ({ ...c, width: c.pdfWidth ?? 1 })) });
    return sendBuffer(res, buffer, `${table.filename}.pdf`, 'application/pdf');
  }
  return sendCsv(res, `${safeFilename(table.filename)}.csv`, toCsv(table.columns, table.rows));
}
