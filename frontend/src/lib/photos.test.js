import { describe, expect, it } from 'vitest';
import { describeReduction, fitWithin, isElongated, jpegName, MAX_EDGE, reducePhotos, shouldReduce } from './photos.js';

const MB = 1024 * 1024;
const file = (name, type, size) => ({ name, type, size });

describe('which files are reduced', () => {
  it('reduces photos above the size the server names, and nothing else', () => {
    expect(shouldReduce(file('IMG_2041.jpg', 'image/jpeg', 4.5 * MB), 1 * MB)).toBe(true);
    expect(shouldReduce(file('screen.png', 'image/png', 1.2 * MB), 1 * MB)).toBe(true);
    expect(shouldReduce(file('photo.webp', 'image/webp', 2 * MB), 1 * MB)).toBe(true);
    // Small enough already.
    expect(shouldReduce(file('small.jpg', 'image/jpeg', 300 * 1024), 1 * MB)).toBe(false);
    expect(shouldReduce(file('exact.jpg', 'image/jpeg', 1 * MB), 1 * MB)).toBe(false);
    // Not something a browser can re-encode without loss of meaning.
    expect(shouldReduce(file('handout.pdf', 'application/pdf', 9 * MB), 1 * MB)).toBe(false);
    expect(shouldReduce(file('clip.gif', 'image/gif', 9 * MB), 1 * MB)).toBe(false);
    expect(shouldReduce(file('logo.svg', 'image/svg+xml', 9 * MB), 1 * MB)).toBe(false);
    expect(shouldReduce(file('IMG_0001.HEIC', 'image/heic', 9 * MB), 1 * MB)).toBe(false);
  });

  it('never reduces when the server switched it off', () => {
    expect(shouldReduce(file('IMG_2041.jpg', 'image/jpeg', 40 * MB), 0)).toBe(false);
    expect(shouldReduce(file('IMG_2041.jpg', 'image/jpeg', 40 * MB), undefined)).toBe(false);
  });

  it('passes files that are not reduced through untouched, in order', async () => {
    const files = [file('a.pdf', 'application/pdf', 3 * MB), file('b.jpg', 'image/jpeg', 200 * 1024), file('c.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 2 * MB)];
    const result = await reducePhotos(files, { threshold: 1 * MB, limit: 4 * MB });
    expect(result.files).toEqual(files);
    expect(result.reduced).toEqual([]);
  });

  it('sends a photo as it is when the browser cannot read it', async () => {
    // No canvas and no image decoder exist in this test environment: decoding fails.
    const broken = file('IMG_2041.jpg', 'image/jpeg', 5 * MB);
    const result = await reducePhotos([broken], { threshold: 1 * MB, limit: 4 * MB });
    expect(result.files).toEqual([broken]);
    expect(result.reduced).toEqual([]);
  });
});

describe('size of a reduced photo', () => {
  it('fits the long side within the limit and keeps the proportions', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: MAX_EDGE, height: 1536 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1536, height: MAX_EDGE });
    expect(fitWithin(8000, 6000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(4096, 1)).toEqual({ width: MAX_EDGE, height: 1 });
  });

  it('leaves a long screenshot or a panorama alone: its writing would become too small to read', () => {
    expect(isElongated(4000, 3000)).toBe(false); // a camera photo
    expect(isElongated(1170, 2532)).toBe(false); // a phone screenshot
    expect(isElongated(3000, 1000)).toBe(false); // exactly three to one
    expect(isElongated(1170, 9200)).toBe(true); // a screenshot of a scrolled page
    expect(isElongated(12000, 2400)).toBe(true); // a panorama
  });

  it('never enlarges a picture', () => {
    expect(fitWithin(1080, 2400)).toEqual({ width: 922, height: MAX_EDGE });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(MAX_EDGE, MAX_EDGE)).toEqual({ width: MAX_EDGE, height: MAX_EDGE });
  });
});

describe('what the person is told', () => {
  it('names the reduced photo as a JPEG', () => {
    expect(jpegName('IMG_2041.PNG')).toBe('IMG_2041.jpg');
    expect(jpegName('homework page 1.jpeg')).toBe('homework page 1.jpg');
    expect(jpegName('scan.final.webp')).toBe('scan.final.jpg');
    expect(jpegName('noextension')).toBe('noextension.jpg');
    expect(jpegName('.png')).toBe('photo.jpg');
    expect(jpegName('')).toBe('photo.jpg');
  });

  it('says what happened to one photo, or to several', () => {
    expect(describeReduction([{ name: 'IMG_2041.jpg', from: 4.5 * MB, to: 610 * 1024 }])).toBe('“IMG_2041.jpg” was made smaller before sending: 4.5 MB → 610 KB.');
    expect(describeReduction([{ name: 'a.jpg', from: 4 * MB, to: 512 * 1024 }, { name: 'b.jpg', from: 6 * MB, to: 512 * 1024 }])).toBe('2 photos were made smaller before sending: 10.0 MB → 1.0 MB in all.');
  });
});
