// Announcements: the feed, one post with its comments, and the form to write one.
// Shared by the institution-wide page and each class's Announcements tab.
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Megaphone, MessageCircle, MoreHorizontal, Pencil, Pin, Plus, Send, Trash2, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext.jsx';
import { FileList, FileUpload } from '../../components/Files.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import { PublishFields, StatusBadge } from '../../components/Publish.jsx';
import RichText, { isEmptyHtml } from '../../components/RichText.jsx';
import { Avatar, Badge, Button, Card, Checkbox, cn, ConfirmDialog, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, ModalActions, Pagination, QueryState, Segmented, Select, Switch, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, plural, relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';

const PRIORITY = { URGENT: { label: 'Urgent', tone: 'bad' }, HIGH: { label: 'Important', tone: 'warn' }, LOW: { label: 'FYI', tone: 'neutral' } };

/**
 * @param {{ classId?: string, canPost: boolean, classes?: Array<{id: string, label: string}>, readOnly?: boolean }} props
 * classId — show one class's announcements; omit for everything the user may read.
 * classes — for teachers on the global page: the classes they can post to.
 */
export default function AnnouncementFeed({ classId, canPost, classes, readOnly = false }) {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const openId = params.get('open');
  const creating = canPost && params.get('new') === '1';
  const key = ['announcements', { classId: classId ?? null, page }];
  const query = useQuery({ queryKey: key, queryFn: () => api.list('/announcements', { classId, page }), placeholderData: (prev) => prev });
  const closeDialog = () => { setEditing(null); if (creating) setParams((p) => { p.delete('new'); return p; }, { replace: true }); };

  return (
    <>
      {canPost && !readOnly && (
        <div className="mb-4 flex justify-end">
          <Button icon={Plus} onClick={() => setParams((p) => { p.set('new', '1'); return p; })}>New announcement</Button>
        </div>
      )}
      <QueryState query={{ ...query, data: query.data?.data }}>
        {(list) => list.length === 0 ? (
          <Card><EmptyState icon={Megaphone} title="No announcements yet" description={canPost ? 'Post reminders, schedule changes and news. Students are notified.' : 'News and reminders from your teachers and the school appear here.'} action={canPost && !readOnly ? <Button icon={Plus} onClick={() => setParams((p) => { p.set('new', '1'); return p; })}>Write the first one</Button> : null} /></Card>
        ) : (
          <ul className="mx-auto max-w-3xl space-y-4">
            {list.map((a) => <li key={a.id}><Post a={a} open={a.id === openId} showClass={!classId} onEdit={() => setEditing(a)} readOnly={readOnly} /></li>)}
          </ul>
        )}
      </QueryState>
      <div className="mx-auto max-w-3xl"><Pagination meta={query.data?.meta} onPage={setPage} /></div>
      {(creating || editing) && <AnnouncementDialog announcement={editing} classId={classId} classes={classes} onClose={closeDialog} />}
    </>
  );
}

function Post({ a, open, showClass, onEdit, readOnly }) {
  const node = useRef(null);
  const [showComments, setShowComments] = useState(open);
  const [confirm, setConfirm] = useState(false);
  const remove = useAction(() => api.delete(`/announcements/${a.id}`), { invalidate: [['announcements'], ['dashboard']], success: 'Announcement deleted.', onSuccess: () => setConfirm(false) });
  const pin = useAction(() => api.patch(`/announcements/${a.id}`, { isPinned: !a.isPinned }), { invalidate: [['announcements']] });
  const priority = PRIORITY[a.priority];

  // Arriving from a notification or the dashboard: bring the post into view.
  useEffect(() => {
    if (open) node.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [open]);

  return (
    <Card ref={node} as="article" className={cn('scroll-mt-36', open && 'ring-2 ring-brand/40', a.priority === 'URGENT' && 'border-bad/40')} padded={false}>
      <div className="p-5">
        <div className="flex items-start gap-3">
          <Avatar name={a.author.name} fileId={a.author.avatarFileId} size={40} />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2">
              {a.isPinned && <Badge tone="brand" icon={Pin}>Pinned</Badge>}
              {priority && <Badge tone={priority.tone}>{priority.label}</Badge>}
              {a.status && a.status !== 'PUBLISHED' && <StatusBadge status={a.status} publishAt={a.publishAt} />}
              {a.audience === 'SELECTED' && <Badge icon={Users}>{a.recipientIds ? plural(a.recipientIds.length, 'selected student') : 'Sent to you'}</Badge>}
            </p>
            <h2 className="mt-1 text-lg font-semibold text-ink text-balance">{a.title}</h2>
            <p className="text-[13px] text-faint">{a.author.name}{showClass ? ` · ${a.classLabel ?? 'Whole institution'}` : ''} · <span title={formatDateTime(a.publishedAt ?? a.createdAt)}>{relativeTime(a.publishedAt ?? a.createdAt)}</span></p>
          </div>
          {a.canManage && !readOnly && (
            <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} label="Announcement options" onClick={toggle} {...props} />}>
              <MenuItem icon={Pencil} onClick={onEdit}>Edit</MenuItem>
              <MenuItem icon={Pin} onClick={() => pin.mutate()}>{a.isPinned ? 'Unpin' : 'Pin to the top'}</MenuItem>
              <MenuItem icon={Trash2} tone="danger" onClick={() => setConfirm(true)}>Delete</MenuItem>
            </Menu>
          )}
        </div>
        <RichText html={a.contentHtml} className="mt-4" />
        {a.attachments.length > 0 && <FileList files={a.attachments} className="mt-4" />}
      </div>
      {a.allowComments && (
        <div className="border-t border-line px-5 py-3">
          <button type="button" onClick={() => setShowComments((v) => !v)} aria-expanded={showComments} className="inline-flex items-center gap-2 text-[13px] font-medium text-soft hover:text-brand">
            <MessageCircle className="size-4" aria-hidden="true" />{a.commentCount > 0 ? plural(a.commentCount, 'comment') : 'Add a comment'}
          </button>
          {showComments && <Comments announcementId={a.id} readOnly={readOnly} />}
        </div>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} title="Delete this announcement?" confirmLabel="Delete">It is removed for everyone, together with its comments.</ConfirmDialog>
    </Card>
  );
}

function Comments({ announcementId, readOnly }) {
  const [body, setBody] = useState('');
  const key = ['announcements', 'detail', announcementId];
  const query = useQuery({ queryKey: key, queryFn: () => api.get(`/announcements/${announcementId}`) });
  const invalidate = [['announcements']];
  const add = useAction(() => api.post(`/announcements/${announcementId}/comments`, { body: body.trim() }), { invalidate, onSuccess: () => setBody('') });
  const remove = useAction((id) => api.delete(`/announcements/${announcementId}/comments/${id}`), { invalidate });
  return (
    <div className="mt-3">
      <QueryState query={query} loader={<p className="py-2 text-sm text-faint">Loading comments…</p>}>
        {(a) => (
          <ul className="space-y-3">
            {a.comments.map((c) => (
              <li key={c.id} className="flex items-start gap-2.5">
                <Avatar name={c.author.name} fileId={c.author.avatarFileId} size={30} />
                <div className="min-w-0 flex-1 rounded-xl bg-raised px-3 py-2">
                  <p className="text-[13px]"><span className="font-semibold text-ink">{c.author.name}</span>{c.author.role === 'TEACHER' && <span className="text-brand"> · teacher</span>} <span className="text-xs text-faint">· {relativeTime(c.createdAt)}</span></p>
                  <p className="whitespace-pre-wrap text-sm text-ink">{c.body}</p>
                </div>
                {c.canDelete && !readOnly && <IconButton icon={Trash2} size="sm" variant="dangerGhost" label="Delete this comment" onClick={() => remove.mutate(c.id)} />}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {!readOnly && (
        <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(); }} className="mt-3 flex items-end gap-2">
          <Textarea rows={1} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment…" maxLength={2000} aria-label="Write a comment" className="min-h-10 resize-none" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (body.trim()) add.mutate(); } }} />
          <Button type="submit" icon={Send} loading={add.isPending} disabled={!body.trim()} aria-label="Post comment" />
        </form>
      )}
    </div>
  );
}

function AnnouncementDialog({ announcement: a, classId, classes, onClose }) {
  const { isAdmin } = useAuth();
  const [v, setV] = useState({
    classId: a?.classId ?? classId ?? (isAdmin ? '' : classes?.[0]?.id ?? ''), title: a?.title ?? '', contentHtml: a?.contentHtml ?? '', priority: a?.priority ?? 'NORMAL',
    audience: a?.audience === 'SELECTED' ? 'SELECTED' : 'CLASS', recipientIds: a?.recipientIds ?? [], isPinned: a?.isPinned ?? false, allowComments: a?.allowComments ?? false,
    status: a?.status ?? 'PUBLISHED', publishAt: a?.publishAt ?? null, files: a?.attachments ?? [],
  });
  const [errors, setErrors] = useState({});
  const set = (name, value) => setV((s) => ({ ...s, [name]: value }));
  const people = useQuery({ queryKey: ['class', v.classId, 'people'], queryFn: () => api.get(`/classes/${v.classId}/people`), enabled: Boolean(v.classId) && v.audience === 'SELECTED' });
  const students = (people.data?.students ?? []).filter((s) => s.status === 'ENROLLED');

  const save = useAction(() => {
    const body = {
      title: v.title.trim(), contentHtml: v.contentHtml, priority: v.priority, isPinned: v.isPinned, allowComments: v.allowComments, status: v.status, publishAt: v.publishAt, fileIds: v.files.map((f) => f.id),
      ...(v.classId ? { audience: v.audience, recipientIds: v.audience === 'SELECTED' ? v.recipientIds : [] } : {}),
    };
    return a ? api.patch(`/announcements/${a.id}`, body) : api.post('/announcements', { ...body, classId: v.classId || null });
  }, {
    invalidate: [['announcements'], ['dashboard']],
    success: a ? 'Announcement saved.' : v.status === 'PUBLISHED' ? 'Announcement posted.' : 'Announcement saved.',
    onSuccess: onClose,
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });

  return (
    <Modal open onClose={onClose} title={a ? 'Edit announcement' : 'New announcement'} size="lg">
      <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }} className="space-y-4">
        {!a && !classId && (
          <Field label="Post to" error={errors.classId}>
            <Select value={v.classId} onChange={(e) => set('classId', e.target.value)}>
              {isAdmin && <option value="">Everyone in the institution</option>}
              {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Title" error={errors.title}><Input value={v.title} onChange={(e) => set('title', e.target.value)} maxLength={200} required /></Field>
        <Field label="Message" error={errors.contentHtml}><LazyEditor value={v.contentHtml} onChange={(html) => set('contentHtml', html)} minHeight={160} placeholder="What should people know?" ariaLabel="Message" /></Field>
        <Field label="Attachments" optional error={errors.fileIds}><FileUpload value={v.files} onChange={(files) => set('files', files)} max={10} compact label="Attach files" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority" error={errors.priority}>
            <Select value={v.priority} onChange={(e) => set('priority', e.target.value)}><option value="LOW">Low — for your information</option><option value="NORMAL">Normal</option><option value="HIGH">Important</option><option value="URGENT">Urgent</option></Select>
          </Field>
          {v.classId && (
            <Field label="Who receives it" error={errors.audience}>
              <Segmented label="Audience" value={v.audience} onChange={(x) => set('audience', x)} className="w-full [&>button]:flex-1" options={[{ value: 'CLASS', label: 'Whole class' }, { value: 'SELECTED', label: 'Selected students' }]} />
            </Field>
          )}
        </div>
        {v.classId && v.audience === 'SELECTED' && (
          <Field label={`Students (${v.recipientIds.length} selected)`} error={errors.recipientIds}>
            <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-xl border border-line p-3">
              {people.isPending ? <p className="text-sm text-faint">Loading the class list…</p> : students.length === 0 ? <p className="text-sm text-faint">No students are enrolled.</p> : students.map((s) => (
                <Checkbox key={s.id} checked={v.recipientIds.includes(s.id)} onChange={(e) => set('recipientIds', e.target.checked ? [...v.recipientIds, s.id] : v.recipientIds.filter((id) => id !== s.id))} label={s.name} />
              ))}
            </div>
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Switch checked={v.isPinned} onChange={(on) => set('isPinned', on)} label="Pin to the top" />
          <Switch checked={v.allowComments} onChange={(on) => set('allowComments', on)} label="Allow comments" />
        </div>
        <PublishFields status={v.status} publishAt={v.publishAt} onChange={(p) => setV((s) => ({ ...s, ...p }))} error={errors.publishAt} noun="announcement" />
        {v.status === 'SCHEDULED' && <p className="flex items-center gap-2 text-[13px] text-faint"><CalendarClock className="size-4" aria-hidden="true" />People are notified when it is published.</p>}
        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!v.title.trim() || isEmptyHtml(v.contentHtml) || (v.audience === 'SELECTED' && v.classId && v.recipientIds.length === 0)}>{a ? 'Save' : v.status === 'PUBLISHED' ? 'Post' : 'Save'}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
