import { Badge } from '../../components/ui.jsx';
import { plural } from '../../lib/format.js';

/** Group classwork by module, then by lesson (or the explicit no-lesson bucket). */
export function groupByModule(items) {
  const groups = new Map();
  for (const item of items) {
    const moduleId = item.module?.id ?? (item.module?.title ? `title:${item.module.title}` : null);
    const key = moduleId ?? 'unassigned';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: item.module?.title ?? 'Not linked to a module',
        items: [],
        sections: new Map(),
      });
    }
    const group = groups.get(key);
    group.items.push(item);
    if (key === 'unassigned') continue;

    const lessonKey = item.lesson?.id ?? (item.lesson?.title ? `title:${item.lesson.title}` : null);
    const sectionKey = lessonKey ?? 'no-lesson';
    if (!group.sections.has(sectionKey)) {
      group.sections.set(sectionKey, {
        key: sectionKey,
        title: item.lesson?.title ?? 'Not linked to a lesson',
        items: [],
      });
    }
    group.sections.get(sectionKey).items.push(item);
  }
  return [...groups.values()].map((group) => ({ ...group, sections: [...group.sections.values()] }));
}

export function ModuleGroupHeading({ group, noun }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="h-5 w-1 shrink-0 rounded-full bg-brand-fill" aria-hidden="true" />
      <h2 className="min-w-0 truncate text-sm font-semibold text-ink">{group.title}</h2>
      <Badge>{plural(group.items.length, noun)}</Badge>
      <span className="h-px min-w-4 flex-1 bg-line" aria-hidden="true" />
    </div>
  );
}

export function LessonGroupHeading({ group, noun }) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-l-2 border-line pl-3">
      <h3 className="min-w-0 truncate text-[13px] font-semibold text-soft">{group.title}</h3>
      <Badge>{plural(group.items.length, noun)}</Badge>
    </div>
  );
}
