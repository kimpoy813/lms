// Upload allow-list and content sniffing.
//
// A file is accepted only when (1) its extension is on the allow-list AND (2) its first bytes
// match what that extension claims to be. The MIME type we store and later serve is derived from
// the extension — the browser-supplied Content-Type is ignored.

const ZIP = 'zip';
const OLE = 'ole';
const TEXT = 'text';

/** extension → { mime, sniff, inline } — `inline` types may be previewed in the browser. */
export const FILE_TYPES = {
  // Documents
  pdf: { mime: 'application/pdf', sniff: 'pdf', inline: true, label: 'PDF' },
  doc: { mime: 'application/msword', sniff: OLE, label: 'Word' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sniff: ZIP, label: 'Word' },
  ppt: { mime: 'application/vnd.ms-powerpoint', sniff: OLE, label: 'PowerPoint' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sniff: ZIP, label: 'PowerPoint' },
  xls: { mime: 'application/vnd.ms-excel', sniff: OLE, label: 'Excel' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sniff: ZIP, label: 'Excel' },
  odt: { mime: 'application/vnd.oasis.opendocument.text', sniff: ZIP, label: 'Document' },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation', sniff: ZIP, label: 'Presentation' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', sniff: ZIP, label: 'Spreadsheet' },
  rtf: { mime: 'application/rtf', sniff: 'rtf', label: 'Document' },
  txt: { mime: 'text/plain; charset=utf-8', sniff: TEXT, inline: true, label: 'Text' },
  md: { mime: 'text/plain; charset=utf-8', sniff: TEXT, inline: true, label: 'Text' },
  csv: { mime: 'text/csv; charset=utf-8', sniff: TEXT, label: 'CSV' },
  // Images
  png: { mime: 'image/png', sniff: 'png', inline: true, label: 'Image' },
  jpg: { mime: 'image/jpeg', sniff: 'jpeg', inline: true, label: 'Image' },
  jpeg: { mime: 'image/jpeg', sniff: 'jpeg', inline: true, label: 'Image' },
  gif: { mime: 'image/gif', sniff: 'gif', inline: true, label: 'Image' },
  webp: { mime: 'image/webp', sniff: 'webp', inline: true, label: 'Image' },
  // Archives
  zip: { mime: 'application/zip', sniff: ZIP, label: 'ZIP archive' },
  // Audio / video
  mp4: { mime: 'video/mp4', sniff: 'ftyp', inline: true, label: 'Video' },
  webm: { mime: 'video/webm', sniff: 'webm', inline: true, label: 'Video' },
  mp3: { mime: 'audio/mpeg', sniff: 'mp3', inline: true, label: 'Audio' },
  m4a: { mime: 'audio/mp4', sniff: 'ftyp', inline: true, label: 'Audio' },
  wav: { mime: 'audio/wav', sniff: 'wav', inline: true, label: 'Audio' },
  // Source code and data — always downloaded as plain text, never rendered by the browser.
  py: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Source code' },
  java: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Source code' },
  c: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Source code' },
  cpp: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Source code' },
  h: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Source code' },
  hpp: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Source code' },
  js: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Source code' },
  sql: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Source code' },
  json: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Data' },
  ipynb: { mime: 'text/plain; charset=utf-8', sniff: TEXT, label: 'Notebook' },
};

export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

const startsWith = (buf, bytes, offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

const SNIFFERS = {
  pdf: (b) => startsWith(b, ascii('%PDF-')),
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  webp: (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  wav: (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WAVE'), 8),
  [ZIP]: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]),
  [OLE]: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  rtf: (b) => startsWith(b, ascii('{\\rtf')),
  ftyp: (b) => startsWith(b, ascii('ftyp'), 4),
  webm: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  mp3: (b) => startsWith(b, ascii('ID3')) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  // Text: no NUL bytes in the sample (binary files almost always contain them).
  [TEXT]: (b) => !b.includes(0),
};

/** Lower-cased extension without the dot, or '' when there is none. */
export function extensionOf(filename) {
  const name = String(filename ?? '');
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

/**
 * Validate an upload by name and leading bytes.
 * @param {string} filename original file name
 * @param {Buffer} head     first bytes of the file (at least 16; 4096 recommended)
 * @returns {{ ok: true, extension: string, mime: string, inline: boolean } | { ok: false, reason: string }}
 */
export function checkUpload(filename, head) {
  const extension = extensionOf(filename);
  if (!extension) return { ok: false, reason: 'The file has no extension, so its type cannot be verified.' };
  const type = FILE_TYPES[extension];
  if (!type) return { ok: false, reason: `Files of type ".${extension}" are not allowed.` };
  if (!head || head.length === 0) return { ok: false, reason: 'The file is empty.' };
  if (!SNIFFERS[type.sniff](head)) {
    return { ok: false, reason: `The file content does not match its ".${extension}" extension.` };
  }
  return { ok: true, extension, mime: type.mime, inline: Boolean(type.inline) };
}

/** Make an original file name safe to store and to echo in a Content-Disposition header. */
export function sanitizeFilename(name) {
  const base = String(name ?? 'file')
    .normalize('NFKC')
    .replace(/[/\\]/g, '_') // no path separators
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/^\.+/, '') // no leading dots (hidden files, "..")
    .replace(/\s+/g, ' ')
    .trim();
  const safe = base.length > 0 ? base : 'file';
  if (safe.length <= 150) return safe;
  const ext = extensionOf(safe);
  return ext ? `${safe.slice(0, 149 - ext.length)}.${ext}` : safe.slice(0, 150);
}
