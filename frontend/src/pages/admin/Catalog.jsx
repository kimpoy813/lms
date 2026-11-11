// Administration → Academic catalogue: departments, programs, terms, courses, sections and grading scales.
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Building2, CalendarRange, GraduationCap, MoreHorizontal, Pencil, Plus, Scale, Star, Trash2, Users, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, ModalActions, PageHeader, QueryState, SearchInput, Select, Table, Tabs, Td, Textarea, Th, Tr } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateKey, plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';

const useList = (name, enabled = true) => useQuery({ queryKey: ['catalog', name], queryFn: () => api.get(`/catalog/${name}`), enabled });
const active = (row) => (row.isActive ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>);

/**
 * Each simple entity is described by its columns and form fields.
 * field: { name, label, type?: 'text'|'number'|'textarea'|'checkbox'|'select', options?: listName, required?, hint?, placeholder?, wide? }
 */
const ENTITIES = {
  departments: {
    label: 'Departments', one: 'department', icon: Building2, title: (r) => r.name,
    columns: [['Code', (r) => <span className="font-semibold">{r.code}</span>], ['Name', (r) => r.name], ['Programs', (r) => r.programCount, 'num'], ['Courses', (r) => r.courseCount, 'num'], ['Teachers', (r) => r.teacherCount, 'num'], ['Status', active]],
    fields: [{ name: 'code', label: 'Code', required: true, placeholder: 'e.g. CCS' }, { name: 'name', label: 'Name', required: true, placeholder: 'e.g. College of Computer Studies', wide: true }, { name: 'description', label: 'Description', type: 'textarea', wide: true }, { name: 'isActive', label: 'Active', type: 'checkbox', initial: true }],
    search: (r) => `${r.code} ${r.name}`,
  },
  programs: {
    label: 'Programs', one: 'program', icon: GraduationCap, title: (r) => r.name,
    columns: [['Code', (r) => <span className="font-semibold">{r.code}</span>], ['Name', (r) => r.name], ['Department', (r) => r.department?.code ?? '—'], ['Years', (r) => r.durationYears ?? '—', 'num'], ['Students', (r) => r.studentCount, 'num'], ['Sections', (r) => r.sectionCount, 'num'], ['Status', active]],
    fields: [{ name: 'code', label: 'Code', required: true, placeholder: 'e.g. BSIT' }, { name: 'departmentId', label: 'Department', type: 'select', options: 'departments', required: true }, { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Bachelor of Science in Information Technology', wide: true }, { name: 'durationYears', label: 'Length (years)', type: 'number', min: 1, max: 10 }, { name: 'isActive', label: 'Active', type: 'checkbox', initial: true }, { name: 'description', label: 'Description', type: 'textarea', wide: true }],
    search: (r) => `${r.code} ${r.name}`,
  },
  courses: {
    label: 'Courses', one: 'course', icon: BookOpen, title: (r) => `${r.code} — ${r.title}`,
    columns: [['Code', (r) => <span className="font-semibold">{r.code}</span>], ['Title', (r) => r.title], ['Units', (r) => r.units, 'num'], ['Department', (r) => r.department?.code ?? '—'], ['Classes', (r) => r.classCount, 'num'], ['Status', active]],
    fields: [{ name: 'code', label: 'Course code', required: true, placeholder: 'e.g. IT 101' }, { name: 'units', label: 'Units', type: 'number', min: 0, max: 12, step: 0.5, initial: 3 }, { name: 'title', label: 'Title', required: true, placeholder: 'e.g. Introduction to Computing', wide: true }, { name: 'departmentId', label: 'Department', type: 'select', options: 'departments' }, { name: 'isActive', label: 'Active', type: 'checkbox', initial: true }, { name: 'description', label: 'Description', type: 'textarea', wide: true }],
    search: (r) => `${r.code} ${r.title}`,
  },
  sections: {
    label: 'Sections', one: 'section', icon: Users, title: (r) => r.name,
    columns: [['Name', (r) => <span className="font-semibold">{r.name}</span>], ['Program', (r) => r.program?.code ?? '—'], ['Year level', (r) => r.yearLevel ?? '—', 'num'], ['Students', (r) => r.studentCount, 'num'], ['Classes', (r) => r.classCount, 'num'], ['Status', active]],
    fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'e.g. BSIT 1A' }, { name: 'programId', label: 'Program', type: 'select', options: 'programs' }, { name: 'yearLevel', label: 'Year level', type: 'number', min: 1, max: 10 }, { name: 'isActive', label: 'Active', type: 'checkbox', initial: true }],
    search: (r) => r.name,
  },
};

const TABS = [
  { value: 'terms', label: 'School years', icon: CalendarRange },
  { value: 'departments', label: 'Departments', icon: Building2 },
  { value: 'programs', label: 'Programs', icon: GraduationCap },
  { value: 'courses', label: 'Courses', icon: BookOpen },
  { value: 'sections', label: 'Sections', icon: Users },
  { value: 'scales', label: 'Grading scales', icon: Scale },
];

export default function AdminCatalog() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'terms';
  return (
    <>
      <PageHeader title="Academic catalogue" description="The building blocks teachers choose from when they create a class." />
      <Tabs className="mb-5" tabs={TABS} value={tab} onChange={(next) => setParams({ tab: next }, { replace: true })} />
      {tab === 'terms' && <Terms />}
      {tab === 'scales' && <Scales />}
      {ENTITIES[tab] && <Entity key={tab} name={tab} config={ENTITIES[tab]} />}
    </>
  );
}

// ── Simple entities ──────────────────────────────────────────────────────────
function Entity({ name, config }) {
  const query = useList(name);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const remove = useAction((id) => api.delete(`/catalog/${name}/${id}`), { invalidate: [['catalog']], success: `The ${config.one} was deleted.`, onSuccess: () => setDialog(null), onError: () => { setDialog(null); return false; } });
  const term = search.trim().toLowerCase();
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={`Search ${config.label.toLowerCase()}…`} className="w-full sm:w-72" />
        <Button icon={Plus} onClick={() => setDialog({ edit: null })}>New {config.one}</Button>
      </div>
      <QueryState query={query}>
        {(rows) => {
          const shown = term ? rows.filter((r) => config.search(r).toLowerCase().includes(term)) : rows;
          if (shown.length === 0) return <Card><EmptyState icon={config.icon} title={term ? 'Nothing matches' : `No ${config.label.toLowerCase()} yet`} action={!term && <Button icon={Plus} onClick={() => setDialog({ edit: null })}>New {config.one}</Button>} /></Card>;
          return (
            <Table>
              <thead><tr>{config.columns.map(([label, , kind]) => <Th key={label} className={kind === 'num' ? 'text-right' : undefined}>{label}</Th>)}<Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <Tr key={r.id}>
                    {config.columns.map(([label, render, kind]) => <Td key={label} className={kind === 'num' ? 'text-right tabular-nums text-soft' : undefined}>{render(r)}</Td>)}
                    <Td className="w-px">
                      <Menu trigger={({ toggle, props }) => <IconButton size="sm" icon={MoreHorizontal} label={`Options for ${config.title(r)}`} onClick={toggle} {...props} />}>
                        <MenuItem icon={Pencil} onClick={() => setDialog({ edit: r })}>Edit</MenuItem>
                        <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog({ remove: r })}>Delete</MenuItem>
                      </Menu>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          );
        }}
      </QueryState>
      {dialog?.edit !== undefined && <EntityDialog name={name} config={config} row={dialog.edit} onClose={() => setDialog(null)} />}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => remove.mutate(dialog.remove.id)} loading={remove.isPending} title={`Delete ${dialog?.remove ? config.title(dialog.remove) : ''}?`} confirmLabel="Delete">
        A {config.one} that is already used by classes, students or other records cannot be deleted — mark it inactive instead, so that it is no longer offered for new classes.
      </ConfirmDialog>
    </>
  );
}

function EntityDialog({ name, config, row, onClose }) {
  const needs = [...new Set(config.fields.filter((f) => f.options).map((f) => f.options))];
  const departments = useList('departments', needs.includes('departments'));
  const programs = useList('programs', needs.includes('programs'));
  const options = { departments: departments.data ?? [], programs: programs.data ?? [] };
  const [v, setV] = useState(() => Object.fromEntries(config.fields.map((f) => [f.name, row?.[f.name] ?? f.initial ?? (f.type === 'checkbox' ? false : '')])));
  const [errors, setErrors] = useState({});
  const save = useAction(() => {
    const body = {};
    for (const f of config.fields) {
      const value = v[f.name];
      if (f.type === 'checkbox') body[f.name] = Boolean(value);
      else if (f.type === 'number') { if (value !== '' && value !== null) body[f.name] = Number(value); else if (!f.required && row) body[f.name] = null; } else if (f.type === 'select') { if (value) body[f.name] = value; else if (!f.required) body[f.name] = null; } else if (String(value).trim()) body[f.name] = String(value).trim();
      else if (!f.required) body[f.name] = null;
    }
    // Units have a default on the server and cannot be null.
    if (name === 'courses' && body.units === null) delete body.units;
    return row ? api.patch(`/catalog/${name}/${row.id}`, body) : api.post(`/catalog/${name}`, body);
  }, {
    invalidate: [['catalog']], success: `The ${config.one} was saved.`, onSuccess: onClose,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });
  return (
    <Modal open onClose={onClose} title={row ? `Edit ${config.one}` : `New ${config.one}`}>
      <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          {config.fields.map((f, i) => {
            if (f.type === 'checkbox') return <Checkbox key={f.name} className="self-end pb-2" label={f.label} checked={Boolean(v[f.name])} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} />;
            const common = { value: v[f.name] ?? '', onChange: (e) => setV({ ...v, [f.name]: e.target.value }), required: f.required };
            return (
              <Field key={f.name} label={f.label} optional={!f.required} error={errors[f.name]} hint={f.hint} className={f.wide ? 'sm:col-span-2' : undefined}>
                {f.type === 'textarea' ? <Textarea rows={2} {...common} maxLength={1000} />
                  : f.type === 'select' ? <Select {...common}><option value="">{f.required ? 'Choose…' : '—'}</option>{options[f.options].map((o) => <option key={o.id} value={o.id}>{o.code} — {o.name}</option>)}</Select>
                    : <Input {...common} type={f.type === 'number' ? 'number' : 'text'} min={f.min} max={f.max} step={f.step} placeholder={f.placeholder} data-autofocus={i === 0 ? '' : undefined} />}
              </Field>
            );
          })}
        </div>
        <ModalActions><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></ModalActions>
      </form>
    </Modal>
  );
}

// ── School years and semesters ───────────────────────────────────────────────
function Terms() {
  const query = useList('academic-years');
  const [dialog, setDialog] = useState(null);
  const remove = useAction(({ kind, id }) => api.delete(`/catalog/${kind}/${id}`), { invalidate: [['catalog']], success: 'Deleted.', onSuccess: () => setDialog(null), onError: () => { setDialog(null); return false; } });
  const makeCurrent = useAction(({ kind, id }) => api.patch(`/catalog/${kind}/${id}`, { isCurrent: true }), { invalidate: [['catalog'], ['dashboard']], success: 'Updated. New classes default to the current term.' });
  return (
    <>
      <div className="mb-4 flex justify-end"><Button icon={Plus} onClick={() => setDialog({ kind: 'academic-years', row: null })}>New school year</Button></div>
      <QueryState query={query}>
        {(years) => years.length === 0 ? <Card><EmptyState icon={CalendarRange} title="No school years yet" description="Add the school year and its semesters first: classes belong to a semester." action={<Button icon={Plus} onClick={() => setDialog({ kind: 'academic-years', row: null })}>New school year</Button>} /></Card> : (
          <ul className="space-y-4">
            {years.map((y) => (
              <li key={y.id}>
                <Card>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1 basis-48">
                      <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink">{y.name}{y.isCurrent && <Badge tone="ok" icon={Star}>Current</Badge>}</h2>
                      <p className="text-[13px] text-faint">{formatDateKey(y.startDate)} – {formatDateKey(y.endDate)}</p>
                    </div>
                    <Button size="sm" variant="secondary" icon={Plus} onClick={() => setDialog({ kind: 'semesters', row: null, yearId: y.id })}>Add a semester</Button>
                    <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} label={`Options for ${y.name}`} onClick={toggle} {...props} />}>
                      {!y.isCurrent && <MenuItem icon={Star} onClick={() => makeCurrent.mutate({ kind: 'academic-years', id: y.id })}>Make this the current year</MenuItem>}
                      <MenuItem icon={Pencil} onClick={() => setDialog({ kind: 'academic-years', row: y })}>Edit</MenuItem>
                      <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog({ remove: { kind: 'academic-years', id: y.id, name: y.name } })}>Delete</MenuItem>
                    </Menu>
                  </div>
                  {y.semesters.length === 0 ? <p className="mt-3 text-sm text-faint">No semesters yet.</p> : (
                    <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
                      {y.semesters.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 text-sm">
                          <span className="min-w-0 flex-1 basis-40 font-medium text-ink">{s.name}{s.isCurrent && <Badge tone="ok" className="ml-2">Current</Badge>}</span>
                          <span className="text-soft">{formatDateKey(s.startDate)} – {formatDateKey(s.endDate)}</span>
                          <span className="w-20 text-right text-faint">{plural(s.classCount, 'class', 'classes')}</span>
                          <Menu trigger={({ toggle, props }) => <IconButton size="sm" icon={MoreHorizontal} label={`Options for ${s.name}`} onClick={toggle} {...props} />}>
                            {!s.isCurrent && <MenuItem icon={Star} onClick={() => makeCurrent.mutate({ kind: 'semesters', id: s.id })}>Make this the current semester</MenuItem>}
                            <MenuItem icon={Pencil} onClick={() => setDialog({ kind: 'semesters', row: s, yearId: y.id })}>Edit</MenuItem>
                            <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog({ remove: { kind: 'semesters', id: s.id, name: s.name } })}>Delete</MenuItem>
                          </Menu>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {dialog?.kind && <TermDialog {...dialog} onClose={() => setDialog(null)} />}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => remove.mutate(dialog.remove)} loading={remove.isPending} title={`Delete ${dialog?.remove?.name}?`} confirmLabel="Delete">A term that has classes cannot be deleted.</ConfirmDialog>
    </>
  );
}

function TermDialog({ kind, row, yearId, onClose }) {
  const isYear = kind === 'academic-years';
  const [v, setV] = useState({ name: row?.name ?? '', startDate: row?.startDate ?? '', endDate: row?.endDate ?? '', isCurrent: row?.isCurrent ?? false });
  const [errors, setErrors] = useState({});
  const save = useAction(() => {
    const body = { name: v.name.trim(), startDate: v.startDate, endDate: v.endDate, isCurrent: v.isCurrent, ...(isYear ? {} : { academicYearId: row?.academicYearId ?? yearId }) };
    return row ? api.patch(`/catalog/${kind}/${row.id}`, body) : api.post(`/catalog/${kind}`, body);
  }, { invalidate: [['catalog'], ['dashboard']], success: 'Saved.', onSuccess: onClose, onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; } });
  return (
    <Modal open onClose={onClose} size="sm" title={`${row ? 'Edit' : 'New'} ${isYear ? 'school year' : 'semester'}`}>
      <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }} className="space-y-4">
        <Field label="Name" error={errors.name}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required maxLength={80} placeholder={isYear ? 'e.g. AY 2027–2028' : 'e.g. First Semester'} data-autofocus /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Starts" error={errors.startDate}><Input type="date" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} required /></Field>
          <Field label="Ends" error={errors.endDate}><Input type="date" value={v.endDate} min={v.startDate || undefined} onChange={(e) => setV({ ...v, endDate: e.target.value })} required /></Field>
        </div>
        <Checkbox label={`This is the current ${isYear ? 'school year' : 'semester'}`} description="Only one can be current; the previous one is unmarked." checked={v.isCurrent} onChange={(e) => setV({ ...v, isCurrent: e.target.checked })} />
        <ModalActions><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></ModalActions>
      </form>
    </Modal>
  );
}

// ── Grading scales ───────────────────────────────────────────────────────────
function Scales() {
  const query = useList('grading-scales');
  const [dialog, setDialog] = useState(null);
  const remove = useAction((id) => api.delete(`/catalog/grading-scales/${id}`), { invalidate: [['catalog']], success: 'Grading scale deleted.', onSuccess: () => setDialog(null), onError: () => { setDialog(null); return false; } });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-soft">A grading scale turns a percentage into the grade written on the report — for example 1.00 to 5.00. Each class uses one scale.</p>
        <Button icon={Plus} onClick={() => setDialog({ edit: null })}>New grading scale</Button>
      </div>
      <QueryState query={query}>
        {(scales) => scales.length === 0 ? <Card><EmptyState icon={Scale} title="No grading scales yet" /></Card> : (
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {scales.map((s) => (
              <li key={s.id}>
                <Card className="h-full">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink">{s.name}{s.isDefault && <Badge tone="brand">Default for new classes</Badge>}</h2>
                      <p className="text-[13px] text-faint">{s.description ?? 'No description'} · used by {plural(s.classCount, 'class', 'classes')}</p>
                    </div>
                    <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} label={`Options for ${s.name}`} onClick={toggle} {...props} />}>
                      <MenuItem icon={Pencil} onClick={() => setDialog({ edit: s })}>Edit</MenuItem>
                      <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog({ remove: s })}>Delete</MenuItem>
                    </Menu>
                  </div>
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {s.entries.map((e) => <li key={e.minPercent} className="rounded-lg border border-line px-2 py-1 text-xs tabular-nums"><span className={e.isPassing ? 'font-semibold text-ink' : 'font-semibold text-bad'}>{e.label}</span> <span className="text-faint">from {e.minPercent}%</span></li>)}
                  </ul>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {dialog?.edit !== undefined && <ScaleDialog scale={dialog.edit} onClose={() => setDialog(null)} />}
      <ConfirmDialog open={Boolean(dialog?.remove)} onClose={() => setDialog(null)} onConfirm={() => remove.mutate(dialog.remove.id)} loading={remove.isPending} title={`Delete “${dialog?.remove?.name}”?`} confirmLabel="Delete">A scale that classes use cannot be deleted.</ConfirmDialog>
    </>
  );
}

function ScaleDialog({ scale, onClose }) {
  const [v, setV] = useState(() => ({ name: scale?.name ?? '', description: scale?.description ?? '', isDefault: scale?.isDefault ?? false, entries: scale?.entries.map((e) => ({ ...e })) ?? [{ minPercent: 75, label: 'Passed', remark: 'Passed', isPassing: true }, { minPercent: 0, label: 'Failed', remark: 'Failed', isPassing: false }] }));
  const [error, setError] = useState(null);
  const setEntry = (i, patch) => setV((s) => ({ ...s, entries: s.entries.map((e, n) => (n === i ? { ...e, ...patch } : e)) }));
  const save = useAction(() => {
    const body = { name: v.name.trim(), description: v.description.trim() || null, isDefault: v.isDefault, entries: v.entries.map((e) => ({ minPercent: Number(e.minPercent), label: String(e.label).trim(), remark: String(e.remark ?? '').trim(), isPassing: Boolean(e.isPassing) })) };
    return scale ? api.put(`/catalog/grading-scales/${scale.id}`, body) : api.post('/catalog/grading-scales', body);
  }, { invalidate: [['catalog']], success: 'Grading scale saved.', onSuccess: onClose, onError: (err) => { setError(err.fields ? Object.values(err.fields).join(' ') : err.message); return true; } });
  const sorted = [...v.entries].every((e, i, list) => i === 0 || Number(list[i - 1].minPercent) > Number(e.minPercent));
  return (
    <Modal open onClose={onClose} size="lg" title={scale ? 'Edit grading scale' : 'New grading scale'}>
      <form onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }} className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        {scale?.classCount > 0 && <Alert tone="warn">{plural(scale.classCount, 'class', 'classes')} use this scale. Changing it changes the grades those classes show, unless their grades are already finalised.</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required maxLength={120} /></Field>
          <Field label="Description" optional><Input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={500} /></Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink">Grades, from highest to lowest</legend>
          <p className="mb-2 text-[13px] text-faint">A student gets the first grade whose minimum percentage they reach. The last row should start at 0%.</p>
          <div className="space-y-2">
            {v.entries.map((e, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} className="grid grid-cols-[5.5rem_5.5rem_1fr_auto_auto] items-center gap-2">
                <label className="relative"><span className="sr-only">Minimum percentage of grade {i + 1}</span><Input type="number" min="0" max="100" step="any" value={e.minPercent} onChange={(ev) => setEntry(i, { minPercent: ev.target.value })} className="pr-7 text-right tabular-nums" /><span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-faint">%</span></label>
                <Input value={e.label} onChange={(ev) => setEntry(i, { label: ev.target.value })} aria-label={`Grade ${i + 1}`} placeholder="Grade" maxLength={20} required />
                <Input value={e.remark ?? ''} onChange={(ev) => setEntry(i, { remark: ev.target.value })} aria-label={`Remark for grade ${i + 1}`} placeholder="Remark, e.g. Very good" maxLength={60} />
                <Checkbox label="Passing" checked={Boolean(e.isPassing)} onChange={(ev) => setEntry(i, { isPassing: ev.target.checked })} />
                <IconButton size="sm" icon={X} label={`Remove grade ${e.label || i + 1}`} disabled={v.entries.length <= 2} onClick={() => setV((s) => ({ ...s, entries: s.entries.filter((_, n) => n !== i) }))} />
              </div>
            ))}
          </div>
          <Button size="sm" variant="secondary" icon={Plus} className="mt-2" disabled={v.entries.length >= 30} onClick={() => setV((s) => ({ ...s, entries: [...s.entries, { minPercent: 0, label: '', remark: '', isPassing: false }] }))}>Add a grade</Button>
          {!sorted && <p className="mt-2 text-[13px] text-warn">The minimum percentages should go down from one row to the next.</p>}
        </fieldset>
        <Checkbox label="Use this scale for new classes by default" checked={v.isDefault} onChange={(e) => setV({ ...v, isDefault: e.target.checked })} />
        <ModalActions><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending} disabled={!v.name.trim()}>Save scale</Button></ModalActions>
      </form>
    </Modal>
  );
}
