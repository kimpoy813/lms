import { describe, expect, it } from 'vitest';
import { groupByModule } from './ModuleGroups.jsx';

describe('groupByModule', () => {
  it('nests lesson-linked items under their module and keeps separate no-lesson and unlinked groups', () => {
    const items = [
      { id: 'a1', module: { id: 'module-a', title: 'Topic A' }, lesson: { id: 'lesson-a', title: 'Lesson A' } },
      { id: 'b1', module: { id: 'module-b', title: 'Topic B' }, lesson: { id: 'lesson-b', title: 'Lesson B' } },
      { id: 'a2', module: { id: 'module-a', title: 'Topic A' }, lesson: null },
      { id: 'none', module: null, lesson: null },
    ];

    expect(groupByModule(items)).toEqual([
      {
        key: 'module-a',
        title: 'Topic A',
        items: [items[0], items[2]],
        sections: [
          { key: 'lesson-a', title: 'Lesson A', items: [items[0]] },
          { key: 'no-lesson', title: 'Not linked to a lesson', items: [items[2]] },
        ],
      },
      {
        key: 'module-b',
        title: 'Topic B',
        items: [items[1]],
        sections: [{ key: 'lesson-b', title: 'Lesson B', items: [items[1]] }],
      },
      { key: 'unassigned', title: 'Not linked to a module', items: [items[3]], sections: [] },
    ]);
  });

  it('keeps one lesson section for matching titles when a lesson id is unavailable', () => {
    const items = [
      { id: 'q1', module: { id: 'module', title: 'Unit' }, lesson: { title: 'Review' } },
      { id: 'q2', module: { id: 'module', title: 'Unit' }, lesson: { title: 'Review' } },
    ];
    expect(groupByModule(items)[0].sections).toEqual([{ key: 'title:Review', title: 'Review', items }]);
  });
});
