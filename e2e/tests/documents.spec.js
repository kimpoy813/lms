// Files and documents, end to end: what is uploaded comes back unchanged, exports open, and a
// test paper in PDF form can be read. These paths depend on files that ship beside the code
// (fonts for PDF export, the PDF reader), so they are worth checking on every kind of deployment.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import PDFDocument from 'pdfkit';
import { apiAs, demoClass, unique } from '../helpers.js';

let teacher;
let cls;

test.beforeAll(async ({ baseURL }) => {
  teacher = await apiAs('teacher', baseURL);
  cls = await demoClass(teacher, 'IT 101');
});

test.afterAll(async () => {
  await teacher?.dispose();
});

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** A real PDF with the given lines of text. */
function pdfWith(lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(12);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

test('an uploaded file comes back byte for byte, whole and in part', async () => {
  // Larger than one megabyte, so that it spans the pieces some storage back-ends read it in.
  const content = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(1_300_000)]);
  const upload = await teacher.sendFile('/files', 'files', { name: 'lecture-notes.pdf', mimeType: 'application/pdf', buffer: content });
  expect(upload.status()).toBe(201);
  const [{ id, sizeBytes }] = (await upload.json()).data;
  try {
    expect(sizeBytes).toBe(content.length);
    const whole = await teacher.raw('GET', `/files/${id}`);
    expect(whole.status()).toBe(200);
    expect(sha(await whole.body())).toBe(sha(content));

    const part = await teacher.raw('GET', `/files/${id}`, { headers: { Range: 'bytes=1048000-1049999' } });
    expect(part.status()).toBe(206);
    expect((await part.body()).equals(content.subarray(1_048_000, 1_050_000))).toBe(true);
  } finally {
    expect((await teacher.raw('DELETE', `/files/${id}`)).status()).toBe(204);
  }
});

test('a file larger than the site accepts is refused', async () => {
  const { runtime } = await teacher.get('/auth/session');
  const tooLarge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(runtime.maxUploadBytes + 1024)]);
  const upload = await teacher.sendFile('/files', 'files', { name: 'too-large.pdf', mimeType: 'application/pdf', buffer: tooLarge });
  expect(upload.status()).toBe(413);
});

test('the gradebook and the attendance record export as PDF and as a spreadsheet', async () => {
  for (const report of ['gradebook', 'attendance']) {
    const pdf = await teacher.raw('GET', `/classes/${cls.id}/${report}/export?format=pdf`);
    expect(pdf.status(), `${report} as PDF`).toBe(200);
    const bytes = await pdf.body();
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1500);

    const sheet = await teacher.raw('GET', `/classes/${cls.id}/${report}/export?format=xlsx`);
    expect(sheet.status(), `${report} as a spreadsheet`).toBe(200);
    expect((await sheet.body()).subarray(0, 2).toString()).toBe('PK');
  }
});

test('a test paper in PDF form is read into questions', async () => {
  const bank = await teacher.post('/question-banks', { title: unique('Imported paper') });
  try {
    const paper = await pdfWith([
      '1. Which keyword declares a constant in JavaScript?', 'A. var', 'B. let', 'C. const', 'Answer: C', '',
      '2. An array index starts at 1.', 'Answer: False',
    ]);
    const preview = await teacher.sendFile(`/question-banks/${bank.id}/import/preview`, 'file', { name: 'quiz-1.pdf', mimeType: 'application/pdf', buffer: paper });
    expect(preview.status()).toBe(200);
    const { data } = await preview.json();
    expect(data.source).toBe('quiz-1.pdf');
    expect(data.summary).toMatchObject({ found: 2, ready: 2 });
    expect(data.questions[0].text ?? data.questions[0].prompt ?? JSON.stringify(data.questions[0])).toContain('constant');
  } finally {
    await teacher.delete(`/question-banks/${bank.id}`);
  }
});
