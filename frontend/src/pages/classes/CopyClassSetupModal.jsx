// Modal to copy category weights, grading policy, syllabus, and learning outcomes
// either from the current class to other active classes, or into the current class from another class.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Alert, Badge, Button, Modal, Segmented, cn } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { plural } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { classColor } from './classColors.js';
import { classLabel } from './useClass.js';

const ITEMS = [
  {
    key: 'gradeWeights',
    label: 'Category weights & grading periods',
    hint: 'Mirrors periods and weighted categories. Any existing graded work is kept if its category matches.',
  },
  {
    key: 'gradePolicy',
    label: 'Grading policy',
    hint: 'Grading scale, transmutation base, rounding, missing-work rule, and late attendance credit.',
  },
  {
    key: 'syllabus',
    label: 'Syllabus',
    hint: 'Replaces the target class syllabus with the source class syllabus.',
  },
  {
    key: 'learningOutcomes',
    label: 'Learning outcomes',
    hint: 'Replaces the target class learning outcomes list.',
  },
];

export default function CopyClassSetupModal({
  open,
  onClose,
  cls,
  defaultMode = 'push',
  defaultSelected,
  hasUnsavedChanges = false,
  onImported,
}) {
  if (!open) return null;
  return (
    <CopyClassSetupDialog
      onClose={onClose}
      cls={cls}
      defaultMode={cls.status === 'ARCHIVED' ? 'push' : defaultMode}
      defaultSelected={defaultSelected}
      hasUnsavedChanges={hasUnsavedChanges}
      onImported={onImported}
    />
  );
}

function formatWeightsSummary(periods = []) {
  if (periods.length === 0) return 'No grading periods';
  return periods
    .map((p) => `${p.name} (${p.weight}%): ${(p.categories ?? []).map((c) => `${c.name} ${c.weight}%`).join(', ')}`)
    .join(' · ');
}

function CopyClassSetupDialog({
  onClose,
  cls,
  defaultMode,
  defaultSelected,
  hasUnsavedChanges,
  onImported,
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const client = useQueryClient();
  const currentArchived = cls.status === 'ARCHIVED';

  const [mode, setMode] = useState(defaultMode);
  const [options, setOptions] = useState(() => ({
    gradeWeights: defaultSelected?.gradeWeights ?? true,
    gradePolicy: defaultSelected?.gradePolicy ?? false,
    syllabus: defaultSelected?.syllabus ?? true,
    learningOutcomes: defaultSelected?.learningOutcomes ?? true,
  }));
  const [targetIds, setTargetIds] = useState([]);
  const [sourceId, setSourceId] = useState('');
  const [error, setError] = useState(null);

  const classesQuery = useQuery({
    queryKey: ['classes', { copySetupPicker: true, status: 'ALL', teacherId: isAdmin ? cls.teacher?.id ?? null : 'self' }],
    queryFn: () => api.get('/classes', { status: 'ALL', pageSize: 200, ...(isAdmin && cls.teacher?.id ? { teacherId: cls.teacher.id } : {}) }),
  });

  const allOtherClasses = (classesQuery.data ?? []).filter((c) => c.id !== cls.id);
  const activeOtherClasses = allOtherClasses.filter((c) => c.status === 'ACTIVE');

  const sourcePreviewClass = useQuery({
    queryKey: ['class', sourceId],
    queryFn: () => api.get(`/classes/${sourceId}`),
    enabled: mode === 'pull' && Boolean(sourceId),
  });
  const sourcePreviewGradebook = useQuery({
    queryKey: ['class', sourceId, 'gradebook'],
    queryFn: () => api.get(`/classes/${sourceId}/gradebook`),
    enabled: mode === 'pull' && Boolean(sourceId),
  });

  const selectedParts = ITEMS.filter((item) => options[item.key]);
  const anyOption = selectedParts.length > 0;

  const action = useAction(
    async () => {
      const fromId = mode === 'push' ? cls.id : sourceId;
      const toIds = mode === 'push' ? targetIds : [cls.id];
      return api.post(`/classes/${fromId}/copy-setup`, {
        targetClassIds: toIds,
        ...options,
      });
    },
    {
      success: (res) => {
        const names = selectedParts.map((i) => i.label.toLowerCase()).join(', ');
        if (mode === 'push') {
          const totalRemapped = (res?.targets ?? []).reduce((acc, t) => acc + (t.remappedItems ?? 0), 0);
          return totalRemapped > 0
            ? `Copied ${names} to ${plural(res.targets.length, 'class', 'classes')} (${plural(totalRemapped, 'existing graded item', 'existing graded items')} matched).`
            : `Copied ${names} to ${plural(res?.targets?.length ?? targetIds.length, 'class', 'classes')}.`;
        }
        const sourceCls = allOtherClasses.find((c) => c.id === sourceId);
        return `Imported ${names} from ${sourceCls ? classLabel(sourceCls) : 'the selected class'}.`;
      },
      onSuccess: async () => {
        const affectedIds = mode === 'push' ? targetIds : [cls.id];
        for (const id of affectedIds) {
          await Promise.all([
            client.invalidateQueries({ queryKey: ['class', id] }),
            client.invalidateQueries({ queryKey: ['class', id, 'gradebook'] }),
          ]);
        }
        client.invalidateQueries({ queryKey: ['classes'] });
        client.invalidateQueries({ queryKey: ['grades'] });
        if (mode === 'pull' && onImported) {
          await onImported(options);
        }
        onClose();
      },
      onError: (err) => {
        setError(err.message);
        return true;
      },
    },
  );

  const toggleOption = (key, checked) => {
    setError(null);
    setOptions((prev) => ({ ...prev, [key]: checked }));
  };

  const toggleTarget = (id, checked) => {
    setError(null);
    setTargetIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  };

  const allTargetsSelected = activeOtherClasses.length > 0 && targetIds.length === activeOtherClasses.length;
  const canSubmit = anyOption && (mode === 'push' ? targetIds.length > 0 : Boolean(sourceId)) && !action.isPending;

  return (
    <Modal
      open
      onClose={action.isPending ? undefined : onClose}
      title="Copy setup between classes"
      description={`Copy category weights, grading policy, syllabus, or learning outcomes ${mode === 'push' ? `from ${classLabel(cls)}` : `into ${classLabel(cls)}`}.`}
      size="lg"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={action.isPending}>Cancel</Button>
          <Button
            icon={mode === 'push' ? ArrowUpFromLine : ArrowDownToLine}
            loading={action.isPending}
            disabled={!canSubmit}
            onClick={() => {
              setError(null);
              action.mutate();
            }}
          >
            {mode === 'push'
              ? (targetIds.length > 0 ? `Copy to ${plural(targetIds.length, 'class', 'classes')}` : 'Select classes')
              : `Import into ${classLabel(cls)}`}
          </Button>
        </>
      )}
    >
      <div className="space-y-5">
        <Segmented
          label="Copy direction"
          value={mode}
          onChange={(next) => {
            if (next === 'pull' && currentArchived) return;
            setError(null);
            setMode(next);
          }}
          options={[
            { value: 'push', label: 'Copy to other classes' },
            {
              value: 'pull',
              label: 'Import from another class',
              title: currentArchived ? 'Restore this archived class before importing into it' : undefined,
            },
          ]}
        />

        {error && <Alert tone="bad">{error}</Alert>}

        {mode === 'push' && hasUnsavedChanges && (
          <Alert tone="info">
            You have unsaved edits on this page. Save them first if you want your newest changes included, otherwise your last saved version will be copied.
          </Alert>
        )}

        <fieldset className="space-y-2.5">
          <legend className="text-sm font-medium text-ink">What to copy</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {ITEMS.map((item) => {
              const checked = options[item.key];
              return (
                <label
                  key={item.key}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors',
                    checked ? 'border-brand bg-brand-soft/50' : 'border-line bg-surface hover:border-line-strong',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggleOption(item.key, e.target.checked)}
                    className="mt-0.5 size-4 shrink-0 rounded border-line-strong accent-[var(--brand-fill)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{item.label}</span>
                    <span className="mt-0.5 block text-xs text-faint">{item.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {!anyOption && <p className="text-xs text-warn">Select at least one item to copy.</p>}
        </fieldset>

        {classesQuery.isPending ? (
          <p className="py-3 text-sm text-faint">Loading classes…</p>
        ) : mode === 'push' ? (
          activeOtherClasses.length === 0 ? (
            <Alert tone="info">You have no other active classes to copy into right now.</Alert>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">Target classes (active)</span>
                {activeOtherClasses.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setTargetIds(allTargetsSelected ? [] : activeOtherClasses.map((c) => c.id))}
                    className="text-xs font-medium text-brand hover:underline"
                  >
                    {allTargetsSelected ? 'Clear all' : 'Select all'}
                  </button>
                )}
              </div>
              <ul className="max-h-52 space-y-2 overflow-y-auto pr-1">
                {activeOtherClasses.map((c) => {
                  const checked = targetIds.includes(c.id);
                  return (
                    <li key={c.id}>
                      <label
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors',
                          checked ? 'border-brand bg-brand-soft/60' : 'border-line bg-surface hover:border-line-strong',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleTarget(c.id, e.target.checked)}
                          className="size-[18px] shrink-0 rounded border-line-strong accent-[var(--brand-fill)]"
                        />
                        <span className={cn('size-2.5 shrink-0 rounded-full', classColor(c.color).bar)} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink">{classLabel(c)}</span>
                          <span className="block truncate text-xs text-faint">{c.course.title}{c.semester?.name ? ` · ${c.semester.name}` : ''}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )
        ) : allOtherClasses.length === 0 ? (
          <Alert tone="info">You have no other classes to import from yet.</Alert>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">Source class (active or archived)</p>
            <ul className="max-h-48 space-y-2 overflow-y-auto pr-1">
              {allOtherClasses.map((c) => {
                const selected = sourceId === c.id;
                return (
                  <li key={c.id}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors',
                        selected ? 'border-brand bg-brand-soft/60' : 'border-line bg-surface hover:border-line-strong',
                      )}
                    >
                      <input
                        type="radio"
                        name="copy-setup-source"
                        checked={selected}
                        onChange={() => {
                          setError(null);
                          setSourceId(c.id);
                        }}
                        className="size-[18px] shrink-0 accent-[var(--brand-fill)]"
                      />
                      <span className={cn('size-2.5 shrink-0 rounded-full', classColor(c.color).bar)} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium text-ink">{classLabel(c)}</span>
                          {c.status === 'ARCHIVED' && <Badge>Archived</Badge>}
                        </span>
                        <span className="block truncate text-xs text-faint">{c.course.title}{c.semester?.name ? ` · ${c.semester.name}` : ''}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            {sourceId && (
              <div className="rounded-xl border border-line bg-raised/50 p-3 text-xs text-soft">
                {sourcePreviewClass.isPending || sourcePreviewGradebook.isPending ? (
                  <p>Loading source preview…</p>
                ) : (
                  <div className="space-y-1">
                    {options.gradeWeights && (
                      <p>
                        <strong className="text-ink">Weights:</strong>{' '}
                        {formatWeightsSummary(sourcePreviewGradebook.data?.structure?.periods)}
                      </p>
                    )}
                    {(options.syllabus || options.learningOutcomes) && sourcePreviewClass.data && (
                      <p>
                        <strong className="text-ink">Content:</strong>{' '}
                        {options.syllabus ? (sourcePreviewClass.data.syllabusHtml ? 'Syllabus included' : 'Syllabus is empty') : null}
                        {options.syllabus && options.learningOutcomes ? ' · ' : null}
                        {options.learningOutcomes ? plural((sourcePreviewClass.data.learningOutcomes ?? []).length, 'learning outcome') : null}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
