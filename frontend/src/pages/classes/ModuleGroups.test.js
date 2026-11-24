import { describe, expect, it } from 'vitest';
import { groupByModule } from './ModuleGroups.jsx';

describe('groupByModule', () => {
  it('groups items by module, keeps their order, and collects unlinked items separately', () => {
    const items = [
      { id: 'a1', module: { id: 'module-a', title: 'Topic A' } },
      { id: 'b1', module: { id: 'module-b', title: 'Topic B' } },
      { id: 'a2', module: { id: 'module-a', title: 'Topic A' } },
      { id: 'none', module: null },
    ];

    expect(groupByModule(items)).toEqual([
      { key: 'module-a', title: 'Topic A', items: [items[0], items[2]] },
      { key: 'module-b', title: 'Topic B', items: [items[1]] },
      { key: 'unassigned', title: 'Not linked to a module', items: [items[3]] },
    ]);
  });
});
