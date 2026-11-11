// The class library: every file, link and video of the class in one place.
import { useQuery } from '@tanstack/react-query';
import { FolderOpen, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, Card, EmptyState, QueryState, SearchInput, Segmented } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { ResourceDialog, ResourceItem } from './ResourceParts.jsx';
import { useClass } from './useClass.js';

export default function Resources() {
  const { cls, canManage, base } = useClass();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('ALL');
  const [adding, setAdding] = useState(false);
  const query = useQuery({ queryKey: ['class', cls.id, 'resources'], queryFn: () => api.get(`${base}/resources`) });
  const modules = useQuery({ queryKey: ['class', cls.id, 'modules'], queryFn: () => api.get(`${base}/modules`), enabled: canManage });
  const term = search.trim().toLowerCase();

  const groups = useMemo(() => {
    const rows = (query.data ?? []).filter((r) => (type === 'ALL' || (type === 'SAVED' ? r.bookmarked : r.type === type)) && (!term || `${r.title} ${r.description ?? ''} ${r.file?.name ?? ''}`.toLowerCase().includes(term)));
    const byModule = new Map();
    for (const r of rows) {
      const key = r.module?.id ?? '';
      if (!byModule.has(key)) byModule.set(key, { title: r.module?.title ?? 'Class library', items: [] });
      byModule.get(key).items.push(r);
    }
    // General class files first, then by module.
    return [...byModule.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0)).map(([, g]) => g);
  }, [query.data, type, term]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search resources…" className="w-full sm:w-72" />
        <Segmented label="Kind" value={type} onChange={setType} options={[{ value: 'ALL', label: 'All' }, { value: 'FILE', label: 'Files' }, { value: 'LINK', label: 'Links' }, { value: 'EMBED', label: 'Videos' }, ...(canManage ? [] : [{ value: 'SAVED', label: 'Saved' }])]} />
        {canManage && <Button icon={Plus} className="ml-auto" onClick={() => setAdding(true)} disabled={cls.status === 'ARCHIVED'}>Add a resource</Button>}
      </div>
      <QueryState query={query}>
        {(all) => groups.length === 0 ? (
          <Card><EmptyState icon={FolderOpen} title={all.length === 0 ? 'No resources yet' : 'Nothing matches'} description={all.length === 0 ? (canManage ? 'Add the syllabus, reading materials, reference links or videos.' : 'Files and links shared by your teacher appear here.') : 'Try another search or filter.'} action={all.length === 0 && canManage ? <Button icon={Plus} onClick={() => setAdding(true)}>Add a resource</Button> : null} /></Card>
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.title}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{g.title}</h2>
                <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {g.items.map((r) => <ResourceItem key={r.id} resource={r} canManage={canManage} classId={cls.id} modules={modules.data ?? []} showPlacement={Boolean(r.lesson)} />)}
                </ul>
              </section>
            ))}
          </div>
        )}
      </QueryState>
      {adding && <ResourceDialog classId={cls.id} modules={modules.data ?? []} onClose={() => setAdding(false)} />}
    </>
  );
}
