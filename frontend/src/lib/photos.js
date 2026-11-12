// Photos are made smaller in the browser before they are sent.
//
// A picture taken with a phone is several megabytes. A site hosted where one request may carry
// only a few megabytes would refuse it, and one that keeps its files in the database would soon be
// full — while a page of handwriting stays perfectly readable at 2048 pixels on the long side, at
// about a tenth of the size. The server says from which size photos are to be reduced
// (REDUCE_PHOTOS_OVER_MB; nothing is touched below it), and the person is told when it happened.
//
// Only what a browser can both read and write is reduced: JPEG, PNG and WebP. Everything else,
// and any picture the browser fails to decode, is sent exactly as it is.

import { formatBytes } from './format.js';

/** Longest side of a reduced photo, in pixels. */
export const MAX_EDGE = 2048;
/** [longest side, JPEG quality] — the usual result, then one for the rare photo that is still too heavy. */
const ATTEMPTS = [[MAX_EDGE, 0.82], [1600, 0.72]];
const REDUCIBLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Is this a picture that can be made smaller, and is it large enough to be worth it? */
export function shouldReduce(file, threshold) {
  return threshold > 0 && REDUCIBLE.has(file?.type) && file.size > threshold;
}

/** The width and height that fit within `maxEdge` on the long side. A picture is never enlarged. */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** "IMG_2041.PNG" → "IMG_2041.jpg": a reduced photo is saved as JPEG. */
export function jpegName(name) {
  const base = String(name ?? '').replace(/\.[^./\\]*$/, '');
  return `${base || 'photo'}.jpg`;
}

/** One sentence for the person who chose the files. `reduced` is [{ name, from, to }] in bytes. */
export function describeReduction(reduced) {
  if (reduced.length === 1) {
    const [photo] = reduced;
    return `“${photo.name}” was made smaller before sending: ${formatBytes(photo.from)} → ${formatBytes(photo.to)}.`;
  }
  const sum = (key) => reduced.reduce((total, photo) => total + photo[key], 0);
  return `${reduced.length} photos were made smaller before sending: ${formatBytes(sum('from'))} → ${formatBytes(sum('to'))} in all.`;
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // 'from-image' turns the picture the way the camera held it (EXIF orientation).
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older browsers reject the option or the format; an <img> may still manage.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function draw(source, { width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  // JPEG has no transparency: see-through parts of a PNG become white paper, not black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

const toJpeg = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

/**
 * The same picture as a smaller JPEG — or the file itself when that would gain nothing.
 * `limit` (bytes) is the most the server accepts: when the usual result is still above it, a
 * smaller one is made.
 */
export async function reducePhoto(file, { limit = 0 } = {}) {
  const source = await decode(file);
  try {
    const width = source.naturalWidth ?? source.width;
    const height = source.naturalHeight ?? source.height;
    if (!width || !height) return file;
    let best = null;
    for (const [edge, quality] of ATTEMPTS) {
      const blob = await toJpeg(draw(source, fitWithin(width, height, edge)), quality);
      if (!blob) break;
      best = blob;
      if (!limit || blob.size <= limit) break;
    }
    if (!best || best.size >= file.size) return file;
    return new File([best], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    source.close?.();
  }
}

/**
 * Goes through the chosen files and reduces the photos above `threshold` bytes.
 * Resolves to { files, reduced }: the files to send, in the same order, and what was reduced.
 */
export async function reducePhotos(files, { threshold = 0, limit = 0 } = {}) {
  const out = [];
  const reduced = [];
  for (const file of files) {
    if (!shouldReduce(file, threshold)) {
      out.push(file);
      continue;
    }
    try {
      const smaller = await reducePhoto(file, { limit });
      if (smaller !== file) reduced.push({ name: file.name, from: file.size, to: smaller.size });
      out.push(smaller);
    } catch {
      // Not a picture this browser can read (or it ran out of memory): the server decides.
      out.push(file);
    }
  }
  return { files: out, reduced };
}
