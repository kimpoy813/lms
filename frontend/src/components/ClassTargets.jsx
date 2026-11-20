// Multi-class target selection UI for posting quizzes, modules, lessons, assignments, and resources
// across multiple active classes taught by the teacher.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { classLabel } from '../pages/classes/useClass.js';
import { Alert, Badge, Button, Modal, Segmented, cn } from './ui.jsx';

export function useTargetableClasses(excludeClassId, teacherId) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const query = useQuery({
    queryKey: ['classes', { status: 'ACTIVE', targetPicker: true, teacherId: isAdmin ? teacherId ?? null : 'self' }],
    queryFn: () => api.get('/classes', { status: 'ACTIVE', pageSize: 100, ...(isAdmin && teacherId ? { teacherId } : {}) }),
  });
  const classes = useMemo(
    () => (query.data ?? []).filter((c) => c.status === 'ACTIVE' && c.id !== excludeClassId),
    [query.data, excludeClassId],
  );
  return { classes, isPending: query.isPending };
}

export function AlsoPostToClasses({
  excludeClassId,
  teacherId,
  value = [],
  onChange,
  label = 'Also post to other classes',
  hint,
  className,
}) {
  const { classes } = useTargetableClasses(excludeClassId, teacherId);
  if (classes.length === 0) return null;

  const selectedSet = new Set(value);
  const allSelected = value.length === classes.length;

  const toggleOne = (id, checked) => {
    const next = new Set(selectedSet);
    if (checked) next.add(id);
    else next.delete(id);
    onChange([...next]);
  };

  const toggleAll = () => {
    onChange(allSelected ? [] : classes.map((c) => c.id));
  };

  return (
    <fieldset className={cn('space-y-3 rounded-xl border border-line bg-raised/40 p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <legend className="flex items-center gap-2 px-0.5 text-sm font-medium text-ink">
          <Layers className="size-4 text-brand" aria-hidden="true" />
          <span>{label}</span>
          {value.length > 0 && <Badge tone="brand">+{plural(value.length, 'class', 'classes')}</Badge>}
        </legend>
        {classes.length > 1 && (
          <button
            type="button"
            onClick={toggleAll}
            className="text-xs font-medium text-brand hover:underline"
          >
            {allSelected ? 'Clear all' : 'Select all'}
          </button>
        )}
      </div>
      <div className="grid max-h-44 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
        {classes.map((c) => {
          const checked = selectedSet.has(c.id);
          return (
            <label
              key={c.id}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                checked ? 'border-brand bg-brand-soft/60' : 'border-line bg-surface hover:border-line-strong',
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => toggleOne(c.id, e.target.checked)}
                className="size-4 shrink-0 rounded border-line-strong accent-[var(--brand-fill)]"
              />
              {c.color && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{classLabel(c)}</span>
                <span className="block truncate text-xs text-faint">{c.course.title}</span>
              </span>
            </label>
          );
        })}
      </div>
      {hint && <p className="text-[12.5px] text-faint">{hint}</p>}
    </fieldset>
  );
}

/**
 * Reusable modal for posting an existing quiz, module, lesson, assignment, or resource to
 * one or more other active classes.
 */
export function PostToClassesModal(props) {
  if (!props.open) return null;
  return <PostToClassesDialog {...props} />;
}

function PostToClassesDialog({
  onClose,
  title = 'Post to other classes',
  description,
  excludeClassId,
  teacherId,
  allowPublishOption = true,
  defaultStatus = 'DRAFT',
  canPublish = true,
  publishDisabledReason,
  hint,
  successMessage,
  submitLabel,
  onSubmit,
}) {
  const client = useQueryClient();
  const { classes, isPending } = useTargetableClasses(excludeClassId, teacherId);
  const [selected, setSelected] = useState([]);
  const [status, setStatus] = useState(canPublish ? defaultStatus : 'DRAFT');
  const [error, setError] = useState(null);

  const action = useAction(
    () => onSubmit({ targetClassIds: selected, status: allowPublishOption ? (canPublish ? status : 'DRAFT') : undefined }),
    {
      success: (_, __) => {
        if (typeof successMessage === 'function') return successMessage(selected.length, status);
        return successMessage || `Posted to ${plural(selected.length, 'class', 'classes')}.`;
      },
      onSuccess: () => {
        for (const id of selected) client.invalidateQueries({ queryKey: ['class', id] });
        client.invalidateQueries({ queryKey: ['dashboard'] });
        client.invalidateQueries({ queryKey: ['calendar'] });
        onClose();
      },
      onError: (err) => {
        setError(err.message);
        return true;
      },
    },
  );

  const allSelected = classes.length > 0 && selected.length === classes.length;
  const toggleOne = (id, checked) => {
    setSelected((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  };

  return (
    <Modal
      open
      onClose={action.isPending ? undefined : onClose}
      title={title}
      description={description}
      size="md"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={action.isPending}>Cancel</Button>
          <Button
            loading={action.isPending}
            disabled={selected.length === 0}
            onClick={() => {
              setError(null);
              action.mutate();
            }}
          >
            {submitLabel ?? (selected.length > 0 ? `Post to ${plural(selected.length, 'class', 'classes')}` : 'Select classes')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        {isPending ? (
          <p className="py-4 text-sm text-faint">Loading your active classes…</p>
        ) : classes.length === 0 ? (
          <Alert tone="info">You have no other active classes right now.</Alert>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">Choose target classes</span>
              {classes.length > 1 && (
                <button
                  type="button"
                  onClick={() => setSelected(allSelected ? [] : classes.map((c) => c.id))}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  {allSelected ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>
            <ul className="max-h-60 space-y-2 overflow-y-auto pr-1">
              {classes.map((c) => {
                const checked = selected.includes(c.id);
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
                        onChange={(e) => toggleOne(c.id, e.target.checked)}
                        className="size-[18px] shrink-0 rounded border-line-strong accent-[var(--brand-fill)]"
                      />
                      {c.color && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} aria-hidden="true" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{classLabel(c)}</span>
                        <span className="block truncate text-xs text-faint">{c.course.title}{c.semester?.name ? ` · ${c.semester.name}` : ''}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {allowPublishOption && (
              <div className="space-y-1.5 border-t border-line pt-3">
                <p className="text-sm font-medium text-ink">Availability in selected classes</p>
                <Segmented
                  label="Availability in selected classes"
                  value={canPublish ? status : 'DRAFT'}
                  onChange={(next) => {
                    if (next === 'PUBLISHED' && !canPublish) return;
                    setStatus(next);
                  }}
                  options={[
                    { value: 'DRAFT', label: 'Save as draft' },
                    { value: 'PUBLISHED', label: 'Publish immediately', title: !canPublish ? publishDisabledReason : undefined },
                  ]}
                />
                {!canPublish && publishDisabledReason && (
                  <p className="text-xs text-warn">{publishDisabledReason}</p>
                )}
              </div>
            )}
            {hint && <p className="text-[13px] text-faint">{hint}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
