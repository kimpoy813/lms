// Grading periods, weighted categories and the policy that turns scores into a grade.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, LayoutTemplate, Lock, Plus, Save, SlidersHorizontal, Trash2, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, cn, ConfirmDialog, Field, IconButton, Input, Select, Switch } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { useAction } from '../../../lib/query.js';
import CopyClassSetupModal from '../CopyClassSetupModal.jsx';
import { useClass } from '../useClass.js';

const KINDS = { QUIZ: 'Quizzes', ASSIGNMENT: 'Assignments', ACTIVITY: 'Activities', LABORATORY: 'Laboratory', PROJECT: 'Projects', EXAM: 'Examinations', PARTICIPATION: 'Participation', ATTENDANCE: 'Attendance (automatic)', CUSTOM: 'Other' };
const sum = (list) => Math.round(list.reduce((a, x) => a + (Number(x.weight) || 0), 0) * 100) / 100;
const toEditablePeriods = (periods) => periods.map((p) => ({
  id: p.id, name: p.name, weight: p.weight, locked: Boolean(p.lockedAt),
  categories: p.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, weight: c.weight, items: c.items.length })),
}));

export default function Setup({ data }) {
  const { cls, base } = useClass();
  const client = useQueryClient();
  const invalidate = [['class', cls.id, 'gradebook'], ['grades']];
  const readOnly = cls.status === 'ARCHIVED' || Boolean(data.class.finalizedAt);
  const [periods, setPeriods] = useState(() => toEditablePeriods(data.structure.periods));
  const [error, setError] = useState(null);
  const [template, setTemplate] = useState(null);
  const [copySetupOpen, setCopySetupOpen] = useState(false);
  const [policySyncKey, setPolicySyncKey] = useState(0);
  const templates = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'templates'], queryFn: () => api.get(`${base}/gradebook/templates`) });
  const scales = useQuery({ queryKey: ['catalog', 'grading-scales'], queryFn: () => api.get('/catalog/grading-scales') });

  const hasUnsavedWeights = useMemo(() => {
    const simplify = (list) => list.map((p) => ({
      id: p.id ?? null, name: p.name.trim(), weight: Number(p.weight) || 0,
      categories: p.categories.map((c) => ({ id: c.id ?? null, name: c.name.trim(), kind: c.kind, weight: Number(c.weight) || 0 })),
    }));
    return JSON.stringify(simplify(periods)) !== JSON.stringify(simplify(data.structure.periods));
  }, [periods, data.structure.periods]);

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
    onSuccess: (fresh) => { setError(null); setPeriods(toEditablePeriods(fresh.structure.periods)); },
    onError: (err) => { setError(err.details?.errors?.join(' ') ?? err.message); return true; },
  });
  const applyTemplate = useAction((key) => api.post(`${base}/gradebook/structure/template`, { key }), {
    invalidate, success: 'Template applied.',
    onSuccess: (fresh) => { setTemplate(null); setError(null); setPeriods(toEditablePeriods(fresh.structure.periods)); },
    onError: () => setTemplate(null),
  });

  return (
    <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_26rem]">
      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader
            icon={LayoutTemplate}
            title="Grading periods and categories"
            description="The final grade is the weighted average of the periods; each period is the weighted average of its categories."
            action={(
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <Button variant="secondary" icon={Copy} className="w-full sm:w-auto" onClick={() => setCopySetupOpen(true)}>
                  {readOnly ? 'Copy to another class…' : 'Copy / Import…'}
                </Button>
                {!readOnly && (templates.data ?? []).length > 0 && (
                  <Select
                    aria-label="Start from a template"
                    value=""
                    onChange={(e) => e.target.value && setTemplate(templates.data.find((t) => t.key === e.target.value))}
                    className="w-full sm:w-56"
                  >
                    <option value="">Start from a template…</option>
                    {templates.data.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </Select>
                )}
              </div>
            )}
          />
          {error && <Alert tone="bad" className="mb-4">{error}</Alert>}
          <fieldset disabled={readOnly} className="space-y-5">
            {periods.map((p, i) => {
              const total = sum(p.categories);
              return (
                <div key={p.id ?? `new-${i}`} className="overflow-hidden rounded-xl border border-line bg-surface">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 border-b border-line bg-raised/60 p-4 sm:flex sm:items-end sm:gap-4">
                    <Field label="Grading period" className="col-span-2 min-w-0 sm:flex-1">
                      <Input value={p.name} onChange={(e) => updatePeriod(i, { name: e.target.value })} placeholder="e.g. Midterm" maxLength={60} />
                    </Field>
                    <Field label="Weight" className="w-36 max-w-full">
                      <PercentInput value={p.weight} onChange={(weight) => updatePeriod(i, { weight })} />
                    </Field>
                    {p.locked ? (
                      <div className="flex h-10 items-center justify-self-end">
                        <Badge icon={Lock}>Locked</Badge>
                      </div>
                    ) : (
                      <IconButton
                        icon={Trash2}
                        variant="dangerGhost"
                        label={`Remove ${p.name || 'this period'}`}
                        className="justify-self-end"
                        onClick={() => setPeriods((list) => list.filter((_, n) => n !== i))}
                      />
                    )}
                  </div>
                  <div className="space-y-3 p-4">
                    {p.categories.length > 0 ? (
                      <>
                        <div className="hidden text-xs font-medium text-faint sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(11.5rem,1fr)_8.5rem_2.5rem] sm:gap-3 sm:px-0.5">
                          <span>Category</span>
                          <span>Type</span>
                          <span className="pr-1 text-right">Weight</span>
                          <span className="sr-only">Actions</span>
                        </div>
                        {p.categories.map((c, j) => (
                          <div
                            key={c.id ?? `new-${j}`}
                            className="space-y-2.5 rounded-xl border border-line bg-raised/30 p-3 sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(11.5rem,1fr)_8.5rem_2.5rem] sm:items-center sm:gap-3 sm:space-y-0 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0"
                          >
                            <div className="flex items-center gap-2 sm:contents">
                              <Input
                                value={c.name}
                                onChange={(e) => updateCategory(i, j, { name: e.target.value })}
                                placeholder="Category name"
                                aria-label="Category name"
                                maxLength={60}
                                className="min-w-0 flex-1 sm:order-1"
                              />
                              <IconButton
                                icon={Trash2}
                                variant="dangerGhost"
                                label={`Remove ${c.name || 'this category'}`}
                                disabled={c.items > 0}
                                title={c.items > 0 ? `Contains ${c.items} graded item(s) — move or delete them first` : undefined}
                                className="sm:order-4"
                                onClick={() => updatePeriod(i, { categories: p.categories.filter((_, m) => m !== j) })}
                              />
                            </div>
                            <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2.5 sm:contents">
                              <Select
                                value={c.kind}
                                onChange={(e) => updateCategory(i, j, { kind: e.target.value, name: c.name || KINDS[e.target.value].replace(' (automatic)', '') })}
                                aria-label="Kind of work"
                                className="sm:order-2"
                              >
                                {Object.entries(KINDS).filter(([k]) => k !== 'ATTENDANCE' || data.class.attendanceAllowed || c.kind === 'ATTENDANCE').map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                              </Select>
                              <div className="sm:order-3">
                                <PercentInput value={c.weight} onChange={(weight) => updateCategory(i, j, { weight })} label={`Weight of ${c.name || 'category'}`} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-xs text-faint">
                        No categories yet. Add at least one category totaling 100%.
                      </p>
                    )}
                    <div className={cn('flex flex-wrap items-center justify-between gap-3 pt-1', p.categories.length > 0 && 'border-t border-line/60 pt-3')}>
                      <Button variant="ghost" size="sm" icon={Plus} onClick={() => updatePeriod(i, { categories: [...p.categories, { name: '', kind: 'CUSTOM', weight: Math.max(0, 100 - total), items: 0 }] })}>Add a category</Button>
                      <p className={cn('flex items-center gap-1.5 text-[13px] font-medium tabular-nums', total === 100 ? 'text-ok' : 'text-warn')}>
                        {total === 100 ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <AlertTriangle className="size-4" aria-hidden="true" />}
                        Categories: {total}% of 100%
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <Button variant="secondary" icon={Plus} disabled={periods.length >= 8} onClick={() => setPeriods((list) => [...list, { name: '', weight: Math.max(0, 100 - periodTotal), locked: false, categories: [] }])}>Add a grading period</Button>
              <p className={cn('flex items-center gap-1.5 text-sm font-semibold tabular-nums', periodTotal === 100 ? 'text-ok' : 'text-warn')}>
                {periodTotal === 100 ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <AlertTriangle className="size-4" aria-hidden="true" />}
                Periods: {periodTotal}% of 100%
              </p>
            </div>
          </fieldset>
          {problems.length > 0 && <Alert tone="warn" className="mt-4" title="Weights must add up to 100%"><ul className="list-disc pl-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul></Alert>}
          {!readOnly && (
            <div className="mt-5 flex justify-end border-t border-line pt-4">
              <Button icon={Save} loading={save.isPending} disabled={problems.length > 0 || periods.length === 0 || periods.some((p) => !p.name.trim() || p.categories.some((c) => !c.name.trim()))} onClick={() => save.mutate()} className="w-full sm:w-auto">Save weights</Button>
            </div>
          )}
        </Card>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2 2xl:grid-cols-1 2xl:content-start">
        <Policy key={policySyncKey} data={data} scales={scales.data ?? []} invalidate={invalidate} readOnly={readOnly} />
        <RankingPolicy data={data} invalidate={invalidate} archived={cls.status === 'ARCHIVED'} />
      </div>

      <CopyClassSetupModal
        open={copySetupOpen}
        onClose={() => setCopySetupOpen(false)}
        cls={cls}
        defaultSelected={{ gradeWeights: true, gradePolicy: false, syllabus: false, learningOutcomes: false }}
        hasUnsavedChanges={hasUnsavedWeights}
        onImported={async ({ gradeWeights, gradePolicy }) => {
          const fresh = await client.fetchQuery({
            queryKey: ['class', cls.id, 'gradebook'],
            queryFn: () => api.get(`${base}/gradebook`),
          });
          if (gradeWeights) {
            setError(null);
            setPeriods(toEditablePeriods(fresh.structure.periods));
          }
          if (gradePolicy) setPolicySyncKey((k) => k + 1);
        }}
      />

      <ConfirmDialog open={Boolean(template)} onClose={() => setTemplate(null)} onConfirm={() => applyTemplate.mutate(template.key)} loading={applyTemplate.isPending} tone="primary" title={`Use “${template?.label}”?`} confirmLabel="Apply template">
        This replaces the current periods and categories. It is only possible while the gradebook has no graded items.
      </ConfirmDialog>
    </div>
  );
}

function PercentInput({ value, onChange, label, className }) {
  return (
    <div className={cn('relative', className)}>
      <Input
        type="number"
        inputMode="decimal"
        min="0"
        max="100"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        aria-label={label}
        className="pr-9 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-faint">%</span>
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
      <CardHeader icon={SlidersHorizontal} title="Grading policy" description="Applies to every student in this class." />
      <fieldset disabled={readOnly} className="space-y-5">
        <Field label="Grading scale" hint="Turns the percentage into the grade on the record.">
          <Select value={v.gradingScaleId} onChange={(e) => setV({ ...v, gradingScaleId: e.target.value })}>
            <option value="">Institution default</option>
            {scales.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {scale?.entries && (
          <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 rounded-xl border border-line bg-raised/60 px-4 py-3 text-[13px] sm:grid-cols-3 2xl:grid-cols-2">
            {scale.entries.map((e) => (
              <div key={e.label} className="flex justify-between gap-2">
                <dt className={cn('font-semibold tabular-nums', e.isPassing ? 'text-ink' : 'text-bad')}>{e.label}</dt>
                <dd className="text-faint tabular-nums">{e.minPercent}%+</dd>
              </div>
            ))}
          </dl>
        )}
        <Field label="Transmutation base" hint="0 = none. With a base of 50, a raw score of 0% becomes 50% and 100% stays 100%.">
          <PercentInput value={v.transmutationBase} onChange={(n) => setV({ ...v, transmutationBase: n })} label="Transmutation base" className="w-36" />
        </Field>
        <Field label="Decimal places in grades">
          <Select value={v.gradeRounding} onChange={(e) => setV({ ...v, gradeRounding: e.target.value })} className="sm:max-w-xs 2xl:max-w-none">
            <option value="0">Whole numbers (87%)</option>
            <option value="1">One (87.4%)</option>
            <option value="2">Two (87.43%)</option>
          </Select>
        </Field>
        <div className="rounded-xl border border-line bg-raised/40 p-3.5">
          <Switch checked={v.treatMissingAsZero} onChange={(on) => setV({ ...v, treatMissingAsZero: on })} label="Missing work counts as zero" description="Off: missing work is left out, like work that is not graded yet." />
        </div>
        {c.attendanceAllowed ? (
          <Field label="Credit for a late arrival" hint="Used by the automatic attendance category. 0.5 = half a meeting.">
            <Input type="number" min="0" max="1" step="0.05" value={v.attendanceLateCredit} onChange={(e) => setV({ ...v, attendanceLateCredit: e.target.value })} className="w-36" />
          </Field>
        ) : <p className="rounded-xl border border-line bg-raised/50 p-3.5 text-[13px] text-soft">Attendance is not part of grades at this institution. An administrator can change this policy under Settings.</p>}
        {!readOnly && (
          <div className="flex justify-end border-t border-line pt-4">
            <Button icon={Save} loading={save.isPending} onClick={() => save.mutate()} className="w-full sm:w-auto">Save policy</Button>
          </div>
        )}
      </fieldset>
    </Card>
  );
}

function RankingPolicy({ data, invalidate, archived }) {
  const { base } = useClass();
  const c = data.class;
  const save = useAction((patch) => api.patch(`${base}/gradebook/ranking-settings`, patch), {
    invalidate: [...invalidate, ['class']],
    success: (_, patch) => (
      patch.gradeRankingEnabled !== undefined
        ? (patch.gradeRankingEnabled ? 'Anonymous class ranking enabled.' : 'Anonymous class ranking hidden.')
        : (patch.gradeRankingShowScores ? 'Grades shown beside ranking codes.' : 'Only rank order and codes shown.')
    ),
  });
  return (
    <Card>
      <CardHeader icon={Trophy} title="Grade release ranking" description="Controlled separately from grade computation so you can turn it on or off anytime." />
      <div className="space-y-3">
        <div className="rounded-xl border border-line bg-raised/40 p-3.5">
          <Switch
            checked={Boolean(c.gradeRankingEnabled)}
            disabled={archived || save.isPending}
            onChange={(on) => save.mutate({ gradeRankingEnabled: on })}
            label="Show anonymous ranking on grade release"
            description="Students see standings using private per-class codes instead of names."
          />
        </div>
        <div className={cn('rounded-xl border border-line bg-raised/40 p-3.5 transition-opacity', !c.gradeRankingEnabled && 'opacity-65')}>
          <Switch
            checked={c.gradeRankingShowScores !== false}
            disabled={archived || !c.gradeRankingEnabled || save.isPending}
            onChange={(on) => save.mutate({ gradeRankingShowScores: on })}
            label="Show grades alongside ranking codes"
            description="Off: displays rank and secret codes without classmate percentages."
          />
        </div>
      </div>
    </Card>
  );
}
