// Grading periods, weighted categories and the policy that turns scores into a grade.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, LayoutTemplate, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, cn, ConfirmDialog, Field, IconButton, Input, Select, Switch } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { useAction } from '../../../lib/query.js';
import { useClass } from '../useClass.js';

const KINDS = { QUIZ: 'Quizzes', ASSIGNMENT: 'Assignments', ACTIVITY: 'Activities', LABORATORY: 'Laboratory', PROJECT: 'Projects', EXAM: 'Examinations', PARTICIPATION: 'Participation', ATTENDANCE: 'Attendance (automatic)', CUSTOM: 'Other' };
const sum = (list) => Math.round(list.reduce((a, x) => a + (Number(x.weight) || 0), 0) * 100) / 100;

export default function Setup({ data }) {
  const { cls, base } = useClass();
  const invalidate = [['class', cls.id, 'gradebook'], ['grades']];
  const readOnly = cls.status === 'ARCHIVED' || Boolean(data.class.finalizedAt);
  const [periods, setPeriods] = useState(() => data.structure.periods.map((p) => ({ id: p.id, name: p.name, weight: p.weight, locked: Boolean(p.lockedAt), categories: p.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, weight: c.weight, items: c.items.length })) })));
  const [error, setError] = useState(null);
  const [template, setTemplate] = useState(null);
  const templates = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'templates'], queryFn: () => api.get(`${base}/gradebook/templates`) });
  const scales = useQuery({ queryKey: ['catalog', 'grading-scales'], queryFn: () => api.get('/catalog/grading-scales') });

  const periodTotal = sum(periods);
  const problems = useMemo(() => {
    const list = [];
    if (periods.length > 0 && periodTotal !== 100) list.push(`The grading periods add up to ${periodTotal}%, not 100%.`);
    for (const p of periods) if (p.categories.length > 0 && sum(p.categories) !== 100) list.push(`The categories of “${p.name || 'unnamed period'}” add up to ${sum(p.categories)}%, not 100%.`);
    return list;
  }, [periods, periodTotal]);

  const updatePeriod = (i, patch) => setPeriods((list) => list.map((p, n) => (n === i ? { ...p, ...patch } : p)));
  const updateCategory = (i, j, patch) => setPeriods((list) => list.map((p, n) => (n === i ? { ...p, categories: p.categories.map((c, m) => (m === j ? { ...c, ...patch } : c)) } : p)));

  const save = useAction(() => api.put(`${base}/gradebook/structure`, {
    periods: periods.map((p) => ({ ...(p.id ? { id: p.id } : {}), name: p.name.trim(), weight: Number(p.weight) || 0, categories: p.categories.map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name.trim(), kind: c.kind, weight: Number(c.weight) || 0 })) })),
  }), {
    invalidate, success: 'Weights saved. Grades were recomputed.',
    onSuccess: (fresh) => { setError(null); setPeriods(fresh.structure.periods.map((p) => ({ id: p.id, name: p.name, weight: p.weight, locked: Boolean(p.lockedAt), categories: p.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, weight: c.weight, items: c.items.length })) }))); },
    onError: (err) => { setError(err.details?.errors?.join(' ') ?? err.message); return true; },
  });
  const applyTemplate = useAction((key) => api.post(`${base}/gradebook/structure/template`, { key }), {
    invalidate, success: 'Template applied.',
    onSuccess: (fresh) => { setTemplate(null); setError(null); setPeriods(fresh.structure.periods.map((p) => ({ id: p.id, name: p.name, weight: p.weight, locked: false, categories: p.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, weight: c.weight, items: 0 })) }))); },
    onError: () => setTemplate(null),
  });

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <div className="min-w-0 space-y-5 xl:col-span-2">
        <Card>
          <CardHeader icon={LayoutTemplate} title="Grading periods and categories" description="The final grade is the weighted average of the periods; each period is the weighted average of its categories."
            action={!readOnly && (templates.data ?? []).length > 0 ? (
              <Select aria-label="Start from a template" value="" onChange={(e) => e.target.value && setTemplate(templates.data.find((t) => t.key === e.target.value))} className="h-9 w-52 text-[13px]">
                <option value="">Start from a template…</option>
                {templates.data.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </Select>
            ) : null} />
          {error && <Alert tone="bad" className="mb-4">{error}</Alert>}
          <fieldset disabled={readOnly} className="space-y-4">
            {periods.map((p, i) => {
              const total = sum(p.categories);
              return (
                // eslint-disable-next-line react/no-array-index-key
                <div key={p.id ?? `new-${i}`} className="rounded-xl border border-line">
                  <div className="flex flex-wrap items-end gap-3 border-b border-line bg-raised/60 p-3">
                    <Field label="Grading period" className="min-w-0 flex-1 basis-40"><Input value={p.name} onChange={(e) => updatePeriod(i, { name: e.target.value })} placeholder="e.g. Midterm" maxLength={60} /></Field>
                    <Field label="Weight" className="w-28"><PercentInput value={p.weight} onChange={(weight) => updatePeriod(i, { weight })} /></Field>
                    {p.locked ? <Badge icon={Lock} className="mb-2.5">Locked</Badge> : <IconButton icon={Trash2} variant="dangerGhost" label={`Remove ${p.name || 'this period'}`} className="mb-0.5" onClick={() => setPeriods((list) => list.filter((_, n) => n !== i))} />}
                  </div>
                  <div className="space-y-2 p-3">
                    {p.categories.map((c, j) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <div key={c.id ?? `new-${j}`} className="grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[1fr_12rem_7rem_auto]">
                        <Input value={c.name} onChange={(e) => updateCategory(i, j, { name: e.target.value })} placeholder="Category name" aria-label="Category name" maxLength={60} />
                        <Select value={c.kind} onChange={(e) => updateCategory(i, j, { kind: e.target.value, name: c.name || KINDS[e.target.value].replace(' (automatic)', '') })} aria-label="Kind of work" className="max-sm:col-start-1">
                          {Object.entries(KINDS).filter(([k]) => k !== 'ATTENDANCE' || data.class.attendanceAllowed || c.kind === 'ATTENDANCE').map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                        </Select>
                        <PercentInput value={c.weight} onChange={(weight) => updateCategory(i, j, { weight })} label={`Weight of ${c.name}`} />
                        <IconButton icon={Trash2} size="sm" variant="dangerGhost" label={`Remove ${c.name || 'this category'}`} disabled={c.items > 0} title={c.items > 0 ? `Contains ${c.items} graded item(s) — move or delete them first` : undefined} className="max-sm:row-start-1 max-sm:col-start-2" onClick={() => updatePeriod(i, { categories: p.categories.filter((_, m) => m !== j) })} />
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <Button variant="ghost" size="sm" icon={Plus} onClick={() => updatePeriod(i, { categories: [...p.categories, { name: '', kind: 'CUSTOM', weight: Math.max(0, 100 - total), items: 0 }] })}>Add a category</Button>
                      <p className={cn('flex items-center gap-1.5 text-[13px] font-medium tabular-nums', total === 100 ? 'text-ok' : 'text-warn')}>{total === 100 ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <AlertTriangle className="size-4" aria-hidden="true" />}Categories: {total}% of 100%</p>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="secondary" size="sm" icon={Plus} disabled={periods.length >= 8} onClick={() => setPeriods((list) => [...list, { name: '', weight: Math.max(0, 100 - periodTotal), locked: false, categories: [] }])}>Add a grading period</Button>
              <p className={cn('flex items-center gap-1.5 text-sm font-semibold tabular-nums', periodTotal === 100 ? 'text-ok' : 'text-warn')}>{periodTotal === 100 ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <AlertTriangle className="size-4" aria-hidden="true" />}Periods: {periodTotal}% of 100%</p>
            </div>
          </fieldset>
          {problems.length > 0 && <Alert tone="warn" className="mt-4" title="Weights must add up to 100%"><ul className="list-disc pl-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul></Alert>}
          {!readOnly && <div className="mt-4 flex justify-end border-t border-line pt-4"><Button icon={Save} loading={save.isPending} disabled={problems.length > 0 || periods.length === 0 || periods.some((p) => !p.name.trim() || p.categories.some((c) => !c.name.trim()))} onClick={() => save.mutate()}>Save weights</Button></div>}
        </Card>
      </div>

      <div className="min-w-0 space-y-5">
        <Policy data={data} scales={scales.data ?? []} invalidate={invalidate} readOnly={readOnly} />
      </div>

      <ConfirmDialog open={Boolean(template)} onClose={() => setTemplate(null)} onConfirm={() => applyTemplate.mutate(template.key)} loading={applyTemplate.isPending} tone="primary" title={`Use “${template?.label}”?`} confirmLabel="Apply template">
        This replaces the current periods and categories. It is only possible while the gradebook has no graded items.
      </ConfirmDialog>
    </div>
  );
}

function PercentInput({ value, onChange, label = 'Weight in percent' }) {
  return (
    <div className="relative">
      <Input type="number" min="0" max="100" step="any" value={value} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} aria-label={label} className="pr-8 text-right tabular-nums" />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-faint">%</span>
    </div>
  );
}

function Policy({ data, scales, invalidate, readOnly }) {
  const { base } = useClass();
  const c = data.class;
  const [v, setV] = useState({ gradingScaleId: c.usesDefaultScale ? '' : c.gradingScale?.id ?? '', transmutationBase: c.transmutationBase, gradeRounding: c.gradeRounding, treatMissingAsZero: c.treatMissingAsZero, attendanceLateCredit: c.attendanceLateCredit });
  const save = useAction(() => api.patch(`${base}/gradebook/settings`, { gradingScaleId: v.gradingScaleId || null, transmutationBase: Number(v.transmutationBase) || 0, gradeRounding: Number(v.gradeRounding), treatMissingAsZero: v.treatMissingAsZero, attendanceLateCredit: Number(v.attendanceLateCredit) }), { invalidate, success: 'Grading policy saved. Grades were recomputed.' });
  const scale = scales.find((s) => s.id === v.gradingScaleId) ?? scales.find((s) => s.isDefault) ?? c.gradingScale;
  return (
    <Card>
      <CardHeader title="Grading policy" description="Applies to every student in this class." />
      <fieldset disabled={readOnly} className="space-y-4">
        <Field label="Grading scale" hint="Turns the percentage into the grade on the record.">
          <Select value={v.gradingScaleId} onChange={(e) => setV({ ...v, gradingScaleId: e.target.value })}>
            <option value="">Institution default</option>
            {scales.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {scale?.entries && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 rounded-xl bg-raised p-3 text-[13px]">
            {scale.entries.map((e) => <div key={e.label} className="flex justify-between gap-2"><dt className={cn('font-semibold tabular-nums', e.isPassing ? 'text-ink' : 'text-bad')}>{e.label}</dt><dd className="text-faint tabular-nums">{e.minPercent}%+</dd></div>)}
          </dl>
        )}
        <Field label="Transmutation base" hint="0 = none. With a base of 50, a raw score of 0% becomes 50% and 100% stays 100%.">
          <PercentInput value={v.transmutationBase} onChange={(n) => setV({ ...v, transmutationBase: n })} label="Transmutation base" />
        </Field>
        <Field label="Decimal places in grades">
          <Select value={v.gradeRounding} onChange={(e) => setV({ ...v, gradeRounding: e.target.value })}><option value="0">Whole numbers (87%)</option><option value="1">One (87.4%)</option><option value="2">Two (87.43%)</option></Select>
        </Field>
        <Switch checked={v.treatMissingAsZero} onChange={(on) => setV({ ...v, treatMissingAsZero: on })} label="Missing work counts as zero" description="Off: missing work is left out, like work that is not graded yet." />
        {c.attendanceAllowed ? (
          <Field label="Credit for a late arrival" hint="Used by the automatic attendance category. 0.5 = half a meeting.">
            <Input type="number" min="0" max="1" step="0.05" value={v.attendanceLateCredit} onChange={(e) => setV({ ...v, attendanceLateCredit: e.target.value })} />
          </Field>
        ) : <p className="rounded-xl bg-raised p-3 text-[13px] text-soft">Attendance is not part of grades at this institution. An administrator can change this policy under Settings.</p>}
        {!readOnly && <Button icon={Save} loading={save.isPending} onClick={() => save.mutate()} className="w-full">Save policy</Button>}
      </fieldset>
    </Card>
  );
}
