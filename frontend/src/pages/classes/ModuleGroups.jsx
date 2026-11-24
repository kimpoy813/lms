import { Badge } from '../../components/ui.jsx';
import { plural } from '../../lib/format.js';

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
      });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
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
