// Administration → Permissions: what teachers and students are allowed to do.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { Alert, Card, PageHeader, QueryState } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useAction } from '../../lib/query.js';

const ROLES = [['TEACHER', 'Teachers'], ['STUDENT', 'Students']];

export default function AdminPermissions() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => api.get('/admin/permissions') });
  const toggle = useAction(({ role, key, granted }) => api.put('/admin/permissions', { role, key, granted }), {
    success: 'Permission updated. It applies the next time each user loads a page.',
    onSuccess: (_r, { role, key, granted }) => client.setQueryData(['admin', 'permissions'], (list) => list.map((p) => (p.key === key ? { ...p, granted: granted ? [...new Set([...p.granted, role])] : p.granted.filter((r) => r !== role) } : p))),
  });
  const groups = useMemo(() => {
    const map = new Map();
    for (const p of query.data ?? []) { if (!map.has(p.category)) map.set(p.category, []); map.get(p.category).push(p); }
    return [...map.entries()];
  }, [query.data]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Permissions" description="Switch optional abilities on or off for a whole role. Administrators can always do everything." />
      <Alert tone="info" className="mb-5">These switches add to the built-in rules — they never remove them. A teacher can only ever manage their own classes, and a student can only ever see their own records, whatever is set here.</Alert>
      <QueryState query={query}>
        {() => (
          <Card padded={false} className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-faint">
                  <th scope="col" className="border-b border-line bg-raised/60 px-4 py-3 sm:px-5">Ability</th>
                  {ROLES.map(([role, label]) => <th key={role} scope="col" className="w-[4.75rem] border-b border-line bg-raised/60 px-1 py-3 text-center sm:w-28 sm:px-3">{label}</th>)}
                </tr>
              </thead>
              {groups.map(([category, permissions]) => (
                <tbody key={category}>
                  <tr><th colSpan={3} scope="colgroup" className="border-b border-line px-4 pb-2 pt-5 text-left text-[13px] font-semibold text-ink sm:px-5"><span className="inline-flex items-center gap-2"><ShieldCheck className="size-4 text-brand" aria-hidden="true" />{category}</span></th></tr>
                  {permissions.map((p) => (
                    <tr key={p.key} className="hover:bg-raised/40">
                      <td className="border-b border-line px-4 py-3 sm:px-5"><span className="block text-ink">{p.description}</span><code className="break-all text-[11px] text-faint">{p.key}</code></td>
                      {ROLES.map(([role, label]) => {
                        const applies = p.roles.includes(role);
                        const on = p.granted.includes(role);
                        const busy = toggle.isPending && toggle.variables?.key === p.key && toggle.variables?.role === role;
                        return (
                          <td key={role} className="border-b border-line px-1 py-3 text-center sm:px-3">
                            {applies ? (
                              <button type="button" role="switch" aria-checked={on} disabled={busy} aria-label={`${p.description} — ${label}`} onClick={() => toggle.mutate({ role, key: p.key, granted: !on })}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 ${on ? 'bg-brand-fill' : 'bg-line-strong'}`}>
                                <span className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                              </button>
                            ) : <span className="text-faint" title="Does not apply to this role">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </Card>
        )}
      </QueryState>
    </div>
  );
}
