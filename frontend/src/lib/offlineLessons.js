// Offline lesson and attachment caching for low-connectivity study.
// Keeps lesson JSON in localStorage (scoped per user) and private file bytes in a dedicated
// CacheStorage bucket without relaxing sw.js's network-only guard for /api/* requests.
import { fileUrl } from './api.js';

const OFFLINE_CACHE = 'edusphere-offline-lessons-v1';
const STORAGE_PREFIX = 'edusphere.offlineLessons';
const MAX_CACHE_FILE_BYTES = 15 * 1024 * 1024;

function storageKey(userId) {
  return `${STORAGE_PREFIX}.${userId || 'anon'}`;
}

function readStore(userId) {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(userId, map) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(map));
  } catch {
    // localStorage quota exceeded — caller can still handle gracefully
    throw new Error('Device storage is full. Remove an older offline lesson and try again.');
  }
}

function collectEmbeddedImageUrls(html = '') {
  const urls = [];
  for (const match of String(html).matchAll(/src=["'](\/api\/files\/[^"'\s]+)["']/g)) {
    urls.push(match[1]);
  }
  return urls;
}

function lessonAssetUrls(lesson) {
  const urls = new Set(collectEmbeddedImageUrls(lesson?.contentHtml));
  for (const r of lesson?.resources ?? []) {
    if (r.type === 'FILE' && r.file?.id && (r.file.sizeBytes ?? 0) <= MAX_CACHE_FILE_BYTES) {
      urls.add(fileUrl(r.file.id, { inline: true }));
      urls.add(fileUrl(r.file.id, { inline: false }));
    }
  }
  return [...urls];
}

export function listOfflineLessons(userId) {
  const store = readStore(userId);
  return Object.values(store).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

export function isLessonSavedOffline(userId, lessonId) {
  return Boolean(readStore(userId)[lessonId]);
}

export function getOfflineLesson(userId, lessonId) {
  return readStore(userId)[lessonId] ?? null;
}

export async function saveLessonOffline(userId, { mod, lesson }) {
  const urls = lessonAssetUrls(lesson);
  let cachedFiles = 0;
  if (typeof caches !== 'undefined' && urls.length > 0) {
    const cache = await caches.open(OFFLINE_CACHE);
    for (const url of urls) {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.ok) {
          await cache.put(url, res);
          cachedFiles += 1;
        }
      } catch {
        // Best-effort per attachment; lesson text is still saved.
      }
    }
  }
  const store = readStore(userId);
  const entry = {
    lessonId: lesson.id,
    moduleId: mod.id,
    moduleTitle: mod.title,
    classId: mod.classId ?? lesson.classId ?? null,
    title: lesson.title,
    savedAt: new Date().toISOString(),
    cachedFiles,
    assetUrls: urls,
    mod: {
      id: mod.id,
      title: mod.title,
      description: mod.description,
      objectives: mod.objectives,
      status: mod.status,
      publishAt: mod.publishAt,
      lessons: (mod.lessons ?? []).map((l) => ({
        id: l.id,
        title: l.title,
        kind: l.kind,
        completed: l.completed,
        locked: l.locked,
        status: l.status,
      })),
    },
    lesson,
  };
  store[lesson.id] = entry;
  writeStore(userId, store);
  return entry;
}

export async function removeOfflineLesson(userId, lessonId) {
  const store = readStore(userId);
  const removed = store[lessonId];
  if (!removed) return;
  delete store[lessonId];
  writeStore(userId, store);
  if (typeof caches === 'undefined' || !removed.assetUrls?.length) return;
  const stillNeeded = new Set(Object.values(store).flatMap((entry) => entry.assetUrls ?? []));
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all(
    removed.assetUrls.filter((u) => !stillNeeded.has(u)).map((u) => cache.delete(u).catch(() => false)),
  );
}

export async function openOfflineFile(url, filename = 'attachment') {
  if (typeof caches === 'undefined') return false;
  const cache = await caches.open(OFFLINE_CACHE);
  const match = await cache.match(url);
  if (!match) return false;
  const blob = await match.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  return true;
}
