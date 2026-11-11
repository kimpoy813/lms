import { describe, expect, it } from 'vitest';
import { haversineMeters, evaluateGeofence, isValidLatitude, isValidLongitude } from '../../src/lib/geo.js';
import { hashPassword, verifyPassword, passwordPolicyError, needsRehash } from '../../src/lib/password.js';
import { addDays, atTime, dateKey, parseDateKey, startOfDay, timeKey, weekdayOf, zonedTimeToUtc, isValidTimeZone } from '../../src/lib/time.js';
import { checkUpload, extensionOf, sanitizeFilename } from '../../src/lib/fileTypes.js';
import { csvCell, parseCsv, toCsv } from '../../src/lib/csv.js';
import { excerpt, plainText, sanitizeRichText } from '../../src/lib/sanitize.js';
import { round } from '../../src/lib/http.js';
import { isPublished, resolvePublication } from '../../src/lib/visibility.js';
import { normalizeCode, randomCode, randomDigits, safeEqual, sha256 } from '../../src/lib/tokens.js';

describe('haversine distance', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters(15.145, 120.5887, 15.145, 120.5887)).toBe(0);
  });

  it('matches known reference distances', () => {
    // One degree of latitude ≈ 111.195 km on the mean-radius sphere.
    expect(haversineMeters(0, 0, 1, 0)).toBeCloseTo(111_195, -1);
    // Manila (Rizal Park) → Angeles City: about 77 km.
    const d = haversineMeters(14.5826, 120.9787, 15.145, 120.5887);
    expect(d).toBeGreaterThan(74_000);
    expect(d).toBeLessThan(80_000);
  });

  it('is accurate at classroom scale', () => {
    // 0.00045° of latitude ≈ 50.04 m
    expect(haversineMeters(17.123456, 120.123456, 17.123456 + 0.00045, 120.123456)).toBeCloseTo(50.04, 1);
  });

  it('is symmetric and handles the antimeridian', () => {
    const a = haversineMeters(10, 179.9995, 10, -179.9995);
    const b = haversineMeters(10, -179.9995, 10, 179.9995);
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeLessThan(200);
  });

  it('validates coordinate ranges', () => {
    expect(isValidLatitude(90)).toBe(true);
    expect(isValidLatitude(90.0001)).toBe(false);
    expect(isValidLatitude(Number.NaN)).toBe(false);
    expect(isValidLatitude('15')).toBe(false);
    expect(isValidLongitude(-180)).toBe(true);
    expect(isValidLongitude(181)).toBe(false);
  });
});

describe('geofence evaluation', () => {
  const fence = { latitude: 17.123456, longitude: 120.123456, radiusMeters: 50, maxAccuracyMeters: 100 };
  const north = (meters) => fence.latitude + meters / 111_195;

  it('accepts a student 18 m and 42 m away, rejects one 130 m away (the brief\'s example)', () => {
    const a = evaluateGeofence(fence, { latitude: north(18), longitude: fence.longitude, accuracy: 12 });
    const b = evaluateGeofence(fence, { latitude: north(42), longitude: fence.longitude, accuracy: 12 });
    const c = evaluateGeofence(fence, { latitude: north(130), longitude: fence.longitude, accuracy: 12 });
    expect(a.ok).toBe(true);
    expect(a.distanceMeters).toBeCloseTo(18, 0);
    expect(b.ok).toBe(true);
    expect(c).toMatchObject({ ok: false, reason: 'OUTSIDE_RADIUS' });
    expect(c.distanceMeters).toBeCloseTo(130, 0);
  });

  it('treats the radius as inclusive', () => {
    const justInside = evaluateGeofence(fence, { latitude: north(49.9), longitude: fence.longitude, accuracy: 5 });
    const justOutside = evaluateGeofence(fence, { latitude: north(50.5), longitude: fence.longitude, accuracy: 5 });
    expect(justInside.ok).toBe(true);
    expect(justOutside.ok).toBe(false);
  });

  it('asks for a retry when the fix is too vague, before judging distance', () => {
    const r = evaluateGeofence(fence, { latitude: fence.latitude, longitude: fence.longitude, accuracy: 250 });
    expect(r).toMatchObject({ ok: false, reason: 'LOW_ACCURACY', accuracyMeters: 250 });
  });

  it('never infers presence from a missing or unusable location', () => {
    expect(evaluateGeofence(fence, null)).toMatchObject({ ok: false, reason: 'LOCATION_REQUIRED' });
    expect(evaluateGeofence(fence, {})).toMatchObject({ ok: false, reason: 'LOCATION_REQUIRED' });
    expect(evaluateGeofence(fence, { latitude: 95, longitude: 0, accuracy: 5 })).toMatchObject({ ok: false, reason: 'LOCATION_INVALID' });
    expect(evaluateGeofence(fence, { latitude: fence.latitude, longitude: fence.longitude })).toMatchObject({ ok: false, reason: 'LOW_ACCURACY' });
    expect(evaluateGeofence(fence, { latitude: fence.latitude, longitude: fence.longitude, accuracy: 0 })).toMatchObject({ ok: false, reason: 'LOW_ACCURACY' });
    expect(evaluateGeofence(fence, { latitude: fence.latitude, longitude: fence.longitude, accuracy: Number.NaN })).toMatchObject({ ok: false, reason: 'LOW_ACCURACY' });
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('Correct-Horse-42');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Correct-Horse-42', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-42', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('uses a fresh salt each time', async () => {
    expect(await hashPassword('Same-Password-1')).not.toBe(await hashPassword('Same-Password-1'));
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$99$8$1$AAAA$AAAA')).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
    expect(needsRehash('bcrypt$whatever')).toBe(true);
  });

  it('enforces the password policy', () => {
    expect(passwordPolicyError('short')).toMatch(/at least 10/);
    expect(passwordPolicyError('password123')).toMatch(/too common/);
    expect(passwordPolicyError('aaaaaaaaaaaa')).toMatch(/repeated/);
    expect(passwordPolicyError('maria.santos-2026', { email: 'maria.santos@school.edu' })).toMatch(/name or e-mail/);
    expect(passwordPolicyError('x'.repeat(129))).toMatch(/at most 128/);
    expect(passwordPolicyError('Correct-Horse-42', { email: 'a@b.co', firstName: 'Ana', lastName: 'Cruz' })).toBeNull();
  });
});

describe('timezone helpers', () => {
  it('computes the local calendar date of an instant', () => {
    // 2026-11-10 17:30 UTC is already 2026-11-11 01:30 in Manila (UTC+8).
    const instant = new Date('2026-11-10T17:30:00Z');
    expect(dateKey(instant, 'Asia/Manila')).toBe('2026-11-11');
    expect(timeKey(instant, 'Asia/Manila')).toBe('01:30');
    expect(dateKey(instant, 'UTC')).toBe('2026-11-10');
  });

  it('converts local wall-clock time to UTC', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 11, hour: 8 }, 'Asia/Manila').toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(startOfDay('2026-11-11', 'Asia/Manila').toISOString()).toBe('2026-11-10T16:00:00.000Z');
    expect(atTime('2026-11-11', '13:45', 'Asia/Manila').toISOString()).toBe('2026-11-11T05:45:00.000Z');
  });

  it('handles daylight-saving transitions', () => {
    // New York: EST (UTC-5) in January, EDT (UTC-4) in July.
    expect(zonedTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9 }, 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9 }, 'America/New_York').toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('does calendar arithmetic on date keys', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(weekdayOf('2026-11-11')).toBe(3); // Wednesday
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('11/11/2026')).toBeNull();
    expect(isValidTimeZone('Asia/Manila')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('upload type checking', () => {
  const pdf = Buffer.from('%PDF-1.7\n...');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);

  it('accepts allowed types whose content matches', () => {
    expect(checkUpload('notes.pdf', pdf)).toMatchObject({ ok: true, extension: 'pdf', mime: 'application/pdf', inline: true });
    expect(checkUpload('Photo.PNG', png)).toMatchObject({ ok: true, extension: 'png' });
    expect(checkUpload('slides.pptx', zip)).toMatchObject({ ok: true, extension: 'pptx', inline: false });
    expect(checkUpload('main.py', Buffer.from('print("hi")\n'))).toMatchObject({ ok: true, mime: 'text/plain; charset=utf-8' });
  });

  it('rejects disallowed extensions', () => {
    for (const name of ['run.exe', 'script.sh', 'page.html', 'image.svg', 'macro.docm', 'app.apk', 'x.php']) {
      expect(checkUpload(name, Buffer.from('anything'))).toMatchObject({ ok: false });
    }
    expect(checkUpload('noextension', pdf).ok).toBe(false);
    expect(checkUpload('.htaccess', pdf).ok).toBe(false);
  });

  it('rejects content that does not match the extension', () => {
    // An executable renamed to .pdf, HTML renamed to .png, a binary renamed to .txt
    expect(checkUpload('invoice.pdf', Buffer.from('MZ\x90\x00\x03')).ok).toBe(false);
    expect(checkUpload('logo.png', Buffer.from('<html><script>alert(1)</script>')).ok).toBe(false);
    expect(checkUpload('notes.txt', Buffer.from([0x4d, 0x5a, 0x00, 0x00])).ok).toBe(false);
    expect(checkUpload('report.docx', pdf).ok).toBe(false);
    expect(checkUpload('empty.pdf', Buffer.alloc(0)).ok).toBe(false);
  });

  it('only considers the last extension', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(checkUpload('photo.png.exe', png).ok).toBe(false);
    expect(checkUpload('evil.exe.png', png).ok).toBe(true); // it really is a PNG and is stored/served as one
  });

  it('neutralises dangerous file names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32.txt')).toBe('_.._windows_system32.txt');
    expect(sanitizeFilename('a\u0000b\r\n"c".pdf')).toBe('abc.pdf');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('...')).toBe('file');
    const long = sanitizeFilename(`${'x'.repeat(400)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(150);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(92.5)).toBe('92.5');
  });

  it('neutralises spreadsheet formulas in text cells', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    // genuine negative numbers stay numeric
    expect(csvCell(-5)).toBe('-5');
  });

  it('round-trips through the parser', () => {
    const csv = toCsv(
      [{ header: 'Name', value: (r) => r.name }, { header: 'Note', value: (r) => r.note }],
      [{ name: 'Cruz, Ana', note: 'said "ok"\nthen left' }, { name: 'Lim', note: '' }],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(parseCsv(csv)).toEqual([['Name', 'Note'], ['Cruz, Ana', 'said "ok"\nthen left'], ['Lim', '']]);
  });

  it('parses CRLF and skips blank lines', () => {
    expect(parseCsv('a,b\r\n\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('HTML sanitising', () => {
  it('removes scripts and event handlers', () => {
    const dirty = '<p onclick="steal()">Hi<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a></p>';
    const clean = sanitizeRichText(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:/i);
    expect(clean).toContain('<p>Hi');
  });

  it('keeps formatting, tables, code and safe links', () => {
    const html = '<h2>Title</h2><p><strong>bold</strong> <em>i</em></p><pre><code class="language-python">print(1)</code></pre><table><tbody><tr><td colspan="2">x</td></tr></tbody></table><a href="https://example.edu">link</a>';
    const clean = sanitizeRichText(html);
    expect(clean).toContain('<h2>Title</h2>');
    expect(clean).toContain('class="language-python"');
    expect(clean).toContain('colspan="2"');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
  });

  it('only allows video embeds from approved hosts', () => {
    expect(sanitizeRichText('<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>')).toContain('youtube-nocookie.com/embed/abc');
    expect(sanitizeRichText('<iframe src="https://evil.example/x"></iframe>')).toBe('');
    expect(sanitizeRichText('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).toBe('');
  });

  it('drops data: and javascript: image sources and style attributes', () => {
    const clean = sanitizeRichText('<img src="data:text/html;base64,PHNjcmlwdD4="><p style="position:fixed">x</p><img src="https://ok.example/a.png">');
    expect(clean).not.toContain('data:');
    expect(clean).not.toContain('style=');
    expect(clean).toContain('https://ok.example/a.png');
  });

  it('produces plain text and excerpts', () => {
    expect(plainText('<b>Ana</b> & <i>Ben</i>')).toBe('Ana & Ben');
    expect(plainText('  x  ', 1)).toBe('x');
    expect(excerpt('<p>Hello <b>world</b></p><p>again</p>', 11)).toBe('Hello worl…');
  });
});

describe('small utilities', () => {
  it('rounds half up without floating point surprises', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(89.495, 2)).toBe(89.5);
    expect(round(74.994, 2)).toBe(74.99);
    expect(round(null)).toBeNull();
  });

  it('decides publication from status and schedule', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    expect(isPublished({ status: 'PUBLISHED' }, now)).toBe(true);
    expect(isPublished({ status: 'DRAFT' }, now)).toBe(false);
    expect(isPublished({ status: 'SCHEDULED', publishAt: new Date('2026-11-10T23:59:00Z') }, now)).toBe(true);
    expect(isPublished({ status: 'SCHEDULED', publishAt: new Date('2026-11-11T00:01:00Z') }, now)).toBe(false);
    expect(resolvePublication({ status: 'SCHEDULED' }, null, now).error).toBeTruthy();
    expect(resolvePublication({ status: 'SCHEDULED', publishAt: new Date('2026-11-01T00:00:00Z') }, null, now).status).toBe('PUBLISHED');
    expect(resolvePublication({ status: 'SCHEDULED', publishAt: new Date('2026-12-01T00:00:00Z') }, null, now)).toMatchObject({ status: 'SCHEDULED', publishedAt: null });
  });

  it('generates and normalises codes', () => {
    expect(randomCode(7)).toMatch(/^[A-HJ-NP-Z2-9]{7}$/);
    expect(randomDigits(6)).toMatch(/^\d{6}$/);
    expect(normalizeCode(' ab-12 cd ')).toBe('AB12CD');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', undefined)).toBe(false);
    expect(sha256('a')).toHaveLength(64);
  });
});
