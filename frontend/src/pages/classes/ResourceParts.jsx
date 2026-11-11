// Learning resources (files, links, embedded videos) — shared by the lesson pages and the class library.
import { Bookmark, BookmarkCheck, Download, ExternalLink, EyeOff, FileText, Link2, MoreHorizontal, Pencil, PlayCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { FileUpload } from '../../components/Files.jsx';
import { Badge, Button, cn, ConfirmDialog, Field, IconButton, Input, Menu, MenuItem, Modal, Segmented, Select, Switch, Textarea } from '../../components/ui.jsx';
import { api, fileUrl } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** One resource row. Students can open, download (when allowed) and bookmark; teachers can edit. */
export function ResourceItem({ resource: r, canManage, classId, modules, showPlacement = false }) {
  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const invalidate = [['class', classId], ['bookmarks']];
  const bookmark = useAction(() => (r.bookmarked ? api.delete('/bookmarks', { resourceId: r.id }) : api.post('/bookmarks', { resourceId: r.id })), { invalidate });
  const remove = useAction(() => api.delete(`/resources/${r.id}`), { invalidate, success: 'Resource removed.', onSuccess: () => setRemoving(false) });
  const toggle = useAction(() => api.patch(`/resources/${r.id}`, { isPublished: !r.isPublished }), { invalidate, success: r.isPublished ? 'Hidden from students.' : 'Visible to students.' });

  const Icon = r.type === 'FILE' ? FileText : r.type === 'EMBED' ? PlayCircle : Link2;
  const href = r.type === 'FILE' ? fileUrl(r.file?.id) : r.url;
  const inlineFile = r.type === 'FILE' && /^(image\/|application\/pdf|video\/|audio\/|text\/plain)/.test(r.file?.mimeType ?? '');
  const placement = showPlacement ? [r.module?.title, r.lesson?.title].filter(Boolean).join(' › ') : null;

  return (
    <li className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', r.type === 'EMBED' ? 'bg-bad-soft text-bad' : r.type === 'LINK' ? 'bg-info-soft text-info' : 'bg-brand-soft text-brand')}><Icon className="size-[18px]" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            {r.type === 'EMBED'
              ? <button type="button" onClick={() => setPlaying((v) => !v)} className="truncate text-left text-sm font-medium text-ink hover:text-brand hover:underline" aria-expanded={playing}>{r.title}</button>
              : r.type === 'FILE' && !inlineFile
                ? <span className="truncate text-sm font-medium text-ink">{r.title}</span>
                : <a href={href} target="_blank" rel="noopener noreferrer" className="truncate text-sm font-medium text-ink hover:text-brand hover:underline">{r.title}</a>}
            {canManage && r.isPublished === false && <Badge tone="warn" icon={EyeOff}>Hidden</Badge>}
          </p>
          <p className="truncate text-xs text-faint">
            {[r.type === 'FILE' ? `${r.file?.name ?? 'File'} · ${formatBytes(r.file?.sizeBytes)}` : r.type === 'EMBED' ? 'Video' : hostOf(r.url), placement, r.description].filter(Boolean).join(' · ')}
          </p>
        </div>
        {r.type === 'LINK' && <a href={href} target="_blank" rel="noopener noreferrer" className="grid size-8 shrink-0 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink" aria-label={`Open ${r.title} in a new tab`}><ExternalLink className="size-4" /></a>}
        {r.type === 'FILE' && (r.allowDownload || canManage) && <a href={fileUrl(r.file?.id, { inline: false })} download={r.file?.name} className="grid size-8 shrink-0 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink" aria-label={`Download ${r.title}`} title="Download"><Download className="size-4" /></a>}
        {!canManage && <IconButton icon={r.bookmarked ? BookmarkCheck : Bookmark} size="sm" label={r.bookmarked ? 'Remove bookmark' : 'Bookmark'} aria-pressed={Boolean(r.bookmarked)} className={r.bookmarked ? 'text-brand' : ''} onClick={() => bookmark.mutate()} />}
        {canManage && (
          <Menu trigger={({ toggle: open, props }) => <IconButton icon={MoreHorizontal} size="sm" label={`Actions for ${r.title}`} onClick={open} {...props} />}>
            <MenuItem icon={Pencil} onClick={() => setEditing(true)}>Edit</MenuItem>
            <MenuItem icon={EyeOff} onClick={() => toggle.mutate()}>{r.isPublished ? 'Hide from students' : 'Show to students'}</MenuItem>
            <MenuItem icon={Trash2} tone="danger" onClick={() => setRemoving(true)}>Remove</MenuItem>
          </Menu>
        )}
      </div>
      {playing && r.type === 'EMBED' && (
        <div className="border-t border-line p-3">
          <div className="aspect-video overflow-hidden rounded-lg bg-black">
            <iframe src={r.url} title={r.title} className="size-full" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" loading="lazy" />
          </div>
        </div>
      )}
      {editing && <ResourceDialog classId={classId} resource={r} modules={modules} onClose={() => setEditing(false)} />}
      <ConfirmDialog open={removing} onClose={() => setRemoving(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} title="Remove this resource?" confirmLabel="Remove">
        “{r.title}” will no longer be available to students.
      </ConfirmDialog>
    </li>
  );
}

/** Add or edit a resource. `placement` pre-selects where it goes: { moduleId, lessonId }. */
export function ResourceDialog({ classId, resource, placement = {}, modules = [], onClose }) {
  const editing = Boolean(resource);
  const [type, setType] = useState(resource?.type ?? 'FILE');
  const [files, setFiles] = useState([]);
  const [values, setValues] = useState({
    title: resource?.title ?? '', description: resource?.description ?? '', url: resource?.url ?? '',
    moduleId: resource?.moduleId ?? placement.moduleId ?? '', lessonId: resource?.lessonId ?? placement.lessonId ?? '',
    allowDownload: resource?.allowDownload ?? true, isPublished: resource?.isPublished ?? true,
  });
  const [errors, setErrors] = useState({});
  const set = (name, value) => setValues((v) => ({ ...v, [name]: value }));

  const save = useAction(() => {
    const common = { title: values.title.trim() || files[0]?.name || '', description: values.description.trim() || null, moduleId: values.moduleId || null, lessonId: values.lessonId || null, allowDownload: values.allowDownload, isPublished: values.isPublished };
    if (editing) return api.patch(`/resources/${resource.id}`, { ...common, ...(resource.type !== 'FILE' ? { url: values.url.trim() } : {}) });
    return api.post(`/classes/${classId}/resources`, { ...common, type, ...(type === 'FILE' ? { fileId: files[0]?.id } : { url: values.url.trim() }) });
  }, {
    invalidate: [['class', classId]],
    success: editing ? 'Resource updated.' : 'Resource added.',
    onSuccess: onClose,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  const currentType = editing ? resource.type : type;
  const ready = currentType === 'FILE' ? editing || files.length > 0 : values.url.trim().length > 3 && values.title.trim();
  const lessons = modules.find((m) => m.id === values.moduleId)?.lessons ?? [];

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit resource' : 'Add a resource'} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!ready} onClick={() => save.mutate()}>{editing ? 'Save' : 'Add resource'}</Button></>}>
      <div className="space-y-4">
        {!editing && (
          <Segmented label="Kind of resource" value={type} onChange={(t) => { setType(t); setErrors({}); }} className="w-full [&>button]:flex-1"
            options={[{ value: 'FILE', label: 'File' }, { value: 'LINK', label: 'Web link' }, { value: 'EMBED', label: 'Video' }]} />
        )}
        {currentType === 'FILE' && !editing && (
          <Field error={errors.fileId}>
            <FileUpload value={files} onChange={(list) => { setFiles(list.slice(-1)); if (!values.title && list[0]) set('title', list.at(-1).name.replace(/\.[^.]+$/, '')); }} max={1} label="Choose a file" hint="PDF, Word, PowerPoint, Excel, images or ZIP" />
          </Field>
        )}
        {currentType !== 'FILE' && (
          <Field label={currentType === 'EMBED' ? 'YouTube or Vimeo link' : 'Web address'} required error={errors.url} hint={currentType === 'EMBED' ? 'The video plays inside EduSphere without tracking cookies.' : null}>
            <Input value={values.url} onChange={(e) => set('url', e.target.value)} placeholder={currentType === 'EMBED' ? 'https://www.youtube.com/watch?v=…' : 'https://…'} inputMode="url" autoCapitalize="none" />
          </Field>
        )}
        <Field label="Title" required={currentType !== 'FILE'} error={errors.title}><Input value={values.title} onChange={(e) => set('title', e.target.value)} maxLength={200} /></Field>
        <Field label="Description" optional error={errors.description}><Textarea rows={2} value={values.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} /></Field>
        {modules.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Module" optional error={errors.moduleId}>
              <Select value={values.moduleId} onChange={(e) => setValues((v) => ({ ...v, moduleId: e.target.value, lessonId: '' }))}>
                <option value="">Class library (no module)</option>
                {modules.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </Select>
            </Field>
            <Field label="Lesson" optional error={errors.lessonId}>
              <Select value={values.lessonId} onChange={(e) => set('lessonId', e.target.value)} disabled={!values.moduleId}>
                <option value="">Whole module</option>
                {lessons.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {currentType === 'FILE' && <Switch checked={values.allowDownload} onChange={(on) => set('allowDownload', on)} label="Students may download this file" description="When off, students can only view it in the browser (PDF and images)." />}
        <Switch checked={values.isPublished} onChange={(on) => set('isPublished', on)} label="Visible to students" />
      </div>
    </Modal>
  );
}
