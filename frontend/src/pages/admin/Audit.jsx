// Administration → Audit log: who changed what, and when. Read-only.
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Download, ScrollText } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from '../../components/toast.jsx';
import { Badge, Button, Card, cn, EmptyState, Field, Input, PageHeader, Pagination, QueryState, SearchInput, Select, Table, Td, Th, Tr, useDebounced } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, fromLocalInput, titleCase } from '../../lib/format.js';

const ROLE_TONE = { ADMIN: 'brand', TEACHER: 'info', STUDENT: 'neutral' };
/** "attendance.correction.approve" → "Attendance · correction approve" */
const actionLabel = (action) => { const [area, ...rest] = String(action).split('.'); return rest.length ? `${titleCase(area)} · ${rest.join(' ').replace(/_/g, ' ')}` : titleCase(area); };
const entityLabel = (type) => String(type ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');

/** The keys whose values differ between two snapshots. */
function changes(before, after) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return keys.filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])).map((k) => [k, before?.[k], after?.[k]]);
}
const show = (value) => (value === undefined ? '—' : value === null ? 'empty' : typeof value === 'object' ? JSON.stringify(value) : String(value));

export default function AdminAudit() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);
  const term = useDebounced(search.trim());
  const filters = { entityType: params.get('entityType') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '', actorId: params.get('actorId') ?? '', classId: params.get('classId') ?? '' };
  const page = Number(params.get('page')) || 1;
  const patch = (changesToApply) => setParams((prev) => { const next = new URLSearchParams(prev); for (const [k, v] of Object.entries(changesToApply)) { if (v) next.set(k, v); else next.delete(k); } return next; }, { replace: true });
  const queryParams = {
    search: term || undefined, entityType: filters.entityType || undefined, actorId: filters.actorId || undefined, classId: filters.classId || undefined,
    from: filters.from ? fromLocalInput(`${filters.from}T00:00`) : undefined, // "To" includes the whole day: up to the last millisecond before the next midnight in school time.
    to: filters.to ? new Date(new Date(fromLocalInput(`${filters.to}T23:59`)).getTime() + 59_999).toISOString() : undefined,
  };
  const query = useQuery({ queryKey: ['admin', 'audit', queryParams, page], queryFn: () => api.list('/admin/audit-logs', { ...queryParams, page, pageSize: 30 }), placeholderData: (prev) => prev });
  const meta = query.data?.meta;
  const filtered = Boolean(term || filters.entityType || filters.from || filters.to || filters.actorId || filters.classId);

  const exportCsv = async () => {
    setExporting(true);
    try { await api.download('/admin/audit-logs/export', queryParams, 'audit-log.csv'); } catch (err) { toast.error(err.message); } finally { setExporting(false); }
  };

  return (
    <>
      <PageHeader title="Audit log" description="A permanent record of sign-ins and of changes to accounts, classes, grades and attendance. Entries cannot be edited or deleted."
        actions={<Button variant="secondary" icon={Download} loading={exporting} onClick={exportCsv}>Export CSV</Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <SearchInput value={search} onChange={(v) => { setSearch(v); if (page !== 1) patch({ page: null }); }} placeholder="Search by person, action or description…" className="w-full sm:w-80" />
        <Field label="Record type" className="w-48"><Select value={filters.entityType} onChange={(e) => patch({ entityType: e.target.value, page: null })}><option value="">All types</option>{(meta?.entityTypes ?? []).map((t) => <option key={t} value={t}>{entityLabel(t)}</option>)}</Select></Field>
        <Field label="From" className="w-40"><Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => patch({ from: e.target.value, page: null })} /></Field>
        <Field label="To" className="w-40"><Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => patch({ to: e.target.value, page: null })} /></Field>
        {filtered && <Button variant="ghost" onClick={() => { setSearch(''); setParams({}, { replace: true }); }}>Clear filters</Button>}
      </div>
      {(filters.actorId || filters.classId) && <p className="mb-3 text-sm text-soft">Showing entries {filters.actorId ? 'by one person' : ''}{filters.actorId && filters.classId ? ' and ' : ''}{filters.classId ? 'for one class' : ''}.</p>}

      <QueryState query={{ ...query, data: query.data?.data }}>
        {(rows) => rows.length === 0 ? <Card><EmptyState icon={ScrollText} title={filtered ? 'No entries match' : 'Nothing has been recorded yet'} /></Card> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Who</Th><Th>What happened</Th><Th className="max-lg:hidden">Record</Th><Th className="max-md:hidden">IP address</Th><Th><span className="sr-only">Details</span></Th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const diff = changes(r.before, r.after);
                const expandable = diff.length > 0;
                return (
                  <Fragment key={r.id}>
                    <Tr>
                      <Td className="whitespace-nowrap tabular-nums text-soft">{formatDateTime(r.createdAt)}</Td>
                      <Td>
                        {r.actor ? <button type="button" onClick={() => patch({ actorId: r.actor.id, page: null })} className="text-left" title="Show only this person’s entries"><span className="block font-medium text-ink hover:text-brand">{r.actor.name}</span></button> : <span className="text-faint">System</span>}
                        {r.actorRole && <Badge tone={ROLE_TONE[r.actorRole]} className="mt-0.5">{r.actorRole.toLowerCase()}</Badge>}
                      </Td>
                      <Td><span className="block text-ink">{r.summary}</span><span className="text-xs text-faint">{actionLabel(r.action)}</span></Td>
                      <Td className="text-soft max-lg:hidden">{entityLabel(r.entityType)}{r.classId && <Link to={`/classes/${r.classId}`} className="ml-1.5 text-xs font-medium text-brand hover:underline">class</Link>}</Td>
                      <Td className="tabular-nums text-faint max-md:hidden">{r.ipAddress ?? '—'}</Td>
                      <Td className="w-px">{expandable && <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-soft hover:bg-raised hover:text-ink">Changes<ChevronDown className={cn('size-4 transition-transform', open !== r.id && '-rotate-90')} aria-hidden="true" /></button>}</Td>
                    </Tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={6} className="border-b border-line bg-raised/40 px-4 py-3">
                          <table className="w-full max-w-3xl text-[13px]">
                            <thead><tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-faint"><th className="py-1 pr-4">Field</th><th className="py-1 pr-4">Before</th><th className="py-1">After</th></tr></thead>
                            <tbody>{diff.map(([key, was, now]) => <tr key={key} className="align-top"><td className="py-1 pr-4 font-medium text-ink">{key}</td><td className="break-all py-1 pr-4 text-soft">{show(was)}</td><td className="break-all py-1 text-ink">{show(now)}</td></tr>)}</tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </QueryState>
      <Pagination meta={meta} onPage={(p) => patch({ page: p > 1 ? String(p) : null })} />
    </>
  );
}
