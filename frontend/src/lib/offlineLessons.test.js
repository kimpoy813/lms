import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOfflineLesson, getOfflineModuleBook, isLessonSavedOffline, listOfflineLessons, removeOfflineLesson, saveLessonOffline } from './offlineLessons.js';

describe('offlineLessons storage & cache helpers', () => {
  let cacheMap;

  beforeEach(() => {
    window.localStorage.clear();
    cacheMap = new Map();
    globalThis.caches = {
      open: vi.fn().mockResolvedValue({
        put: vi.fn(async (url, res) => { cacheMap.set(url, res); }),
        match: vi.fn(async (url) => cacheMap.get(url)),
        delete: vi.fn(async (url) => cacheMap.delete(url)),
      }),
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['file']) }));
  });

  it('saves, reads, lists, and cleans up offline lessons and shared assets', async () => {
    const mod = { id: 'm1', classId: 'c1', title: 'Week 1', objectives: [], lessons: [{ id: 'l1', title: 'Lesson 1', kind: 'LESSON' }, { id: 'l2', title: 'Lesson 2', kind: 'LESSON' }] };
    const lesson1 = {
      id: 'l1',
      title: 'Lesson 1',
      contentHtml: '<p>See <img src="/api/files/f-shared/view"></p>',
      visual: { title: 'Lesson pathway', description: 'Follow the idea.', steps: ['Start', 'Connect', 'Apply'] },
      selfCheck: { prompt: 'What comes next?', options: ['Connect', 'Finish', 'Skip'], correctIndex: 0, explanation: 'Connect each step.' },
      resources: [{ id: 'r1', type: 'FILE', file: { id: 'f1', name: 'notes.pdf', sizeBytes: 1024 } }],
    };
    const lesson2 = {
      id: 'l2',
      title: 'Lesson 2',
      contentHtml: '<p>Also <img src="/api/files/f-shared/view"></p>',
      resources: [],
    };

    await saveLessonOffline('u1', { mod, lesson: lesson1 });
    await saveLessonOffline('u1', { mod, lesson: lesson2 });

    expect(isLessonSavedOffline('u1', 'l1')).toBe(true);
    expect(getOfflineLesson('u1', 'l1').lesson.title).toBe('Lesson 1');
    expect(getOfflineLesson('u1', 'l1').lesson).toMatchObject({
      visual: { title: 'Lesson pathway', steps: ['Start', 'Connect', 'Apply'] },
      selfCheck: { prompt: 'What comes next?', options: ['Connect', 'Finish', 'Skip'], correctIndex: 0 },
    });
    const offlineBook = getOfflineModuleBook('u1', 'm1');
    expect(offlineBook.book.chapters[0]).toMatchObject({
      visual: { title: 'Lesson pathway' },
      selfCheck: { prompt: 'What comes next?', correctIndex: 0 },
    });
    expect(listOfflineLessons('u1')).toHaveLength(2);
    expect(cacheMap.has('/api/files/f-shared/view')).toBe(true);
    expect(cacheMap.has('/api/files/f1')).toBe(true);

    // Removing lesson 1 removes f1, but retains f-shared because lesson 2 still needs it.
    await removeOfflineLesson('u1', 'l1');
    expect(isLessonSavedOffline('u1', 'l1')).toBe(false);
    expect(cacheMap.has('/api/files/f1')).toBe(false);
    expect(cacheMap.has('/api/files/f-shared/view')).toBe(true);
  });
});
