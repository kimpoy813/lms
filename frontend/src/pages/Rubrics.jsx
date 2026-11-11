// Rubrics: criteria with performance levels, reused across assignments.
import { useQuery } from '@tanstack/react-query';
import { Copy, MoreHorizontal, Pencil, Plus, Sparkles, Table2, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, ModalActions, PageHeader, QueryState, Textarea } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatScore, plural, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';

const STARTER_LEVELS = (max) => [
  { title: 'Excellent', points: max, description: '' },
  { title: 'Good', points: Math.round(max * 0.8 * 100) / 100, description: '' },
  { title: 'Fair', points: Math.round(max * 0.6 * 100) / 100, description: '' },
  { title: 'Needs work', points: Math.round(max * 0.3 * 100) / 100, description: '' },
];

export default function Rubrics() {
  const [dialog, setDialog] = useState(null);
  const query = useQuery({ queryKey: ['rubrics'], queryFn: () => api.get('/rubrics') });
  const copy = useAction((id) => api.post(`/rubrics/${id}/copy`), { invalidate: [['rubrics']], success: 'Rubric duplicated.' });
  const remove = useAction((id) => api.delete(`/rubrics/${id}`), { invalidate: [['rubrics']], success: 'Rubric deleted.', onSuccess: () => setDialog(null) });
  return (
    <>
      <PageHeader title="Rubrics" description="Describe what each score means once, then attach the rubric to any assignment. Students see it before they submit."
        actions={<><Button variant="secondary" icon={Sparkles} to="/ai?tool=rubric">Draft with AI</Button><Button icon={Plus} onClick={() => setDialog({ edit: null })}>New rubric</Button></>} />
      <QueryState query={query}>
        {(rubrics) => rubrics.length === 0 ? (
          <Card><EmptyState icon={Table2} title="No rubrics yet" description="A rubric lists criteria (for example Content, Organisation, Grammar) and the points for each level of performance." action={<Button icon={Plus} onClick={() => setDialog({ edit: null })}>New rubric</Button>} /></Card>
        ) : (
          <ul className="space-y-4">
            {rubrics.map((r) => (
              <li key={r.id}>
                <Card>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1 basis-56">
                      <h2 className="text-base font-semibold text-ink">{r.title}</h2>
                      <p className="text-[13px] text-faint">{formatScore(r.totalPoints)} points · {plural(r.criteria.length, 'criterion', 'criteria')} · updated {relativeTime(r.updatedAt)}</p>
                      {r.description && <p className="mt-1 text-sm text-soft">{r.description}</p>}
                    </div>
                    {r.assignmentCount > 0 && <Badge tone="info">Used in {plural(r.assignmentCount, 'assignment')}</Badge>}
                    <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} label={`Options for ${r.title}`} onClick={toggle} {...props} />}>
                      <MenuItem icon={Pencil} onClick={() => setDialog({ edit: r })}>Edit</MenuItem>
                      <MenuItem icon={Copy} onClick={() => copy.mutate(r.id)}>Duplicate</MenuItem>
                      <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog({ remove: r })}>Delete</MenuItem>
                    </Menu>
                  </div>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[36rem] border-collapse text-[13px]">
                      <tbody>
                        {r.criteria.map((c) => (
                          <tr key={c.id} className="border-t border-line align-top">
                            <th scope="row" className="w-44 py-2.5 pr-3 text-left font-semibold text-ink">{c.title}<span className="block font-normal text-faint">{formatScore(c.maxPoints)} pts</span></th>
                            {c.levels.map((l) => <td key={l.title} className="py-2.5 pr-3 text-soft"><span className="font-medium text-ink">{l.title} · {formatScore(l.points)}</span>{l.description && <span className="block">{l.description}</span>}</td>)}
                            {c.levels.length === 0 && <td className="py-2.5 text-faint">Scored from 0 to {formatScore(c.maxPoints)}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {dialog?.edit !== undefined && <RubricDialog rubric={dialog.edit} onClose={() => setDialog(null)} />}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => remove.mutate(dialog.remove.id)} loading={remove.isPending} title={`Delete “${dialog?.remove?.title}”?`} confirmLabel="Delete rubric">
        {dialog?.remove?.assignmentCount > 0 ? 'A rubric that is attached to assignments cannot be deleted. Remove it from those assignments first.' : 'The rubric is removed from your list.'}
      </ConfirmDialog>
    </>
  );
}

export function RubricDialog({ rubric, draft, onClose, onSaved }) {
  const source = rubric ?? draft;
  const [v, setV] = useState(() => ({
    title: source?.title ?? '', description: source?.description ?? '',
    criteria: source?.criteria?.map((c) => ({ title: c.title, description: c.description ?? '', maxPoints: c.maxPoints, levels: c.levels.map((l) => ({ title: l.title, points: l.points, description: l.description ?? '' })) })) ?? [{ title: '', description: '', maxPoints: 10, levels: STARTER_LEVELS(10) }],
  }));
  const [error, setError] = useState(null);
  const setCriterion = (i, patch) => setV((s) => ({ ...s, criteria: s.criteria.map((c, n) => (n === i ? { ...c, ...patch } : c)) }));
  const setLevel = (i, j, patch) => setCriterion(i, { levels: v.criteria[i].levels.map((l, n) => (n === j ? { ...l, ...patch } : l)) });
  const total = v.criteria.reduce((s, c) => s + (Number(c.maxPoints) || 0), 0);
  const save = useAction(() => {
    const body = { title: v.title.trim(), description: v.description.trim() || null, criteria: v.criteria.map((c) => ({ title: c.title.trim(), description: c.description.trim(), maxPoints: Number(c.maxPoints), levels: c.levels.filter((l) => l.title.trim()).map((l) => ({ title: l.title.trim(), points: Number(l.points) || 0, description: l.description.trim() })) })) };
    return rubric ? api.put(`/rubrics/${rubric.id}`, body) : api.post('/rubrics', body);
  }, {
    invalidate: [['rubrics']], success: rubric ? 'Rubric saved.' : 'Rubric created.',
    onSuccess: (saved) => { onSaved?.(saved); onClose(); },
    onError: (err) => { setError(err.fields ? Object.values(err.fields).join(' ') : err.message); return true; },
  });

  return (
    <Modal open onClose={onClose} title={rubric ? 'Edit rubric' : 'New rubric'} size="xl">
      <form onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }} className="space-y-5">
        {error && <Alert tone="bad">{error}</Alert>}
        {draft && <Alert tone="info" title="AI draft — review before saving">Check that the criteria and descriptions match what you will actually grade.</Alert>}
        {rubric?.assignmentCount > 0 && <Alert tone="warn">This rubric is attached to {plural(rubric.assignmentCount, 'assignment')}. If work has already been graded with it, the criteria can no longer change — duplicate it instead.</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} required maxLength={200} placeholder="e.g. Reflection essay rubric" /></Field>
          <Field label="Description" optional><Input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={1000} /></Field>
        </div>
        <ol className="space-y-4">
          {v.criteria.map((c, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className="rounded-xl border border-line">
              <div className="grid gap-3 border-b border-line bg-raised/60 p-3 sm:grid-cols-[1fr_7rem_auto] sm:items-end">
                <Field label={`Criterion ${i + 1}`}><Input value={c.title} onChange={(e) => setCriterion(i, { title: e.target.value })} placeholder="e.g. Content and insight" maxLength={120} required /></Field>
                <Field label="Points"><Input type="number" min="0.5" max="1000" step="any" value={c.maxPoints} onChange={(e) => setCriterion(i, { maxPoints: e.target.value })} /></Field>
                <IconButton icon={Trash2} variant="dangerGhost" label={`Remove criterion ${i + 1}`} disabled={v.criteria.length <= 1} onClick={() => setV((s) => ({ ...s, criteria: s.criteria.filter((_, n) => n !== i) }))} />
              </div>
              <div className="p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Levels of performance</p>
                <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {c.levels.map((l, j) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={j} className="rounded-lg border border-line p-2.5">
                      <div className="flex items-center gap-1.5">
                        <Input value={l.title} onChange={(e) => setLevel(i, j, { title: e.target.value })} placeholder="Level" aria-label={`Level ${j + 1} name`} maxLength={60} className="h-8 text-[13px] font-semibold" />
                        <Input type="number" min="0" max={c.maxPoints} step="any" value={l.points} onChange={(e) => setLevel(i, j, { points: e.target.value })} aria-label={`Level ${j + 1} points`} className="h-8 w-16 px-2 text-right text-[13px] tabular-nums" />
                        <button type="button" onClick={() => setCriterion(i, { levels: c.levels.filter((_, n) => n !== j) })} className="rounded p-1 text-faint hover:text-bad" aria-label={`Remove level ${l.title || j + 1}`}><X className="size-4" /></button>
                      </div>
                      <Textarea rows={2} value={l.description} onChange={(e) => setLevel(i, j, { description: e.target.value })} placeholder="What this level looks like" aria-label={`Description of ${l.title || `level ${j + 1}`}`} maxLength={500} className="mt-1.5 text-[13px]" />
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" icon={Plus} disabled={c.levels.length >= 8} onClick={() => setCriterion(i, { levels: [...c.levels, { title: '', points: 0, description: '' }] })}>Add a level</Button>
                  {c.levels.length === 0 && <Button variant="ghost" size="sm" onClick={() => setCriterion(i, { levels: STARTER_LEVELS(Number(c.maxPoints) || 10) })}>Use four standard levels</Button>}
                </div>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="secondary" size="sm" icon={Plus} disabled={v.criteria.length >= 30} onClick={() => setV((s) => ({ ...s, criteria: [...s.criteria, { title: '', description: '', maxPoints: 10, levels: STARTER_LEVELS(10) }] }))}>Add a criterion</Button>
          <p className="text-sm font-semibold text-ink">Total: {formatScore(total)} points</p>
        </div>
        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!v.title.trim()}>Save rubric</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
