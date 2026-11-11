// One discussion thread with its replies.
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, CornerDownRight, Eye, EyeOff, Lock, LockOpen, MoreHorizontal, Pencil, Pin, PinOff, Reply, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { FileList } from '../../components/Files.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import RichText, { isEmptyHtml } from '../../components/RichText.jsx';
import { Alert, Avatar, Badge, Button, Card, cn, ConfirmDialog, IconButton, Menu, MenuItem, QueryState } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime, plural, relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { ThreadDialog } from './Discussions.jsx';
import { useClass } from './useClass.js';

export default function Thread() {
  const { cls, base } = useClass();
  const { threadId } = useParams();
  const navigate = useNavigate();
  const key = ['class', cls.id, 'thread', threadId];
  const query = useQuery({ queryKey: key, queryFn: () => api.get(`/discussions/threads/${threadId}`) });
  const [dialog, setDialog] = useState(null);
  const invalidate = [key, ['class', cls.id, 'discussions']];
  const patch = useAction((body) => api.patch(`/discussions/threads/${threadId}`, body), { invalidate });
  const remove = useAction(() => api.delete(`/discussions/threads/${threadId}`), { invalidate: [['class', cls.id, 'discussions']], success: 'Discussion deleted.', onSuccess: () => navigate(`${base}/discussions`, { replace: true }) });
  const readOnly = cls.status === 'ARCHIVED';

  return (
    <QueryState query={query}>
      {(t) => (
        <div className="mx-auto max-w-3xl">
          <Link to={`${base}/discussions`} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-soft hover:text-brand"><ChevronLeft className="size-4" aria-hidden="true" />All discussions</Link>
          <Card className={cn(t.isHidden && 'border-warn/50')}>
            <div className="flex items-start gap-3.5">
              <Avatar name={t.author.name} fileId={t.author.avatarFileId} size={44} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  {t.isPinned && <Badge tone="brand" icon={Pin}>Pinned</Badge>}
                  {t.topic && <Badge>{t.topic}</Badge>}
                  {t.isLocked && <Badge icon={Lock}>Closed to replies</Badge>}
                  {t.isHidden && <Badge tone="warn" icon={EyeOff}>Hidden from students</Badge>}
                </p>
                <h1 className="mt-1 text-xl font-bold tracking-tight text-ink text-balance">{t.title}</h1>
                <p className="text-[13px] text-faint">{t.author.name}{t.author.role === 'TEACHER' ? ' · teacher' : ''} · {formatDateTime(t.createdAt)}</p>
              </div>
              {(t.canEdit || t.canModerate) && !readOnly && (
                <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} label="Discussion options" onClick={toggle} {...props} />}>
                  {t.canEdit && <MenuItem icon={Pencil} onClick={() => setDialog('edit')}>Edit</MenuItem>}
                  {t.canModerate && <MenuItem icon={t.isPinned ? PinOff : Pin} onClick={() => patch.mutate({ isPinned: !t.isPinned })}>{t.isPinned ? 'Unpin' : 'Pin to the top'}</MenuItem>}
                  {t.canModerate && <MenuItem icon={t.isLocked ? LockOpen : Lock} onClick={() => patch.mutate({ isLocked: !t.isLocked })}>{t.isLocked ? 'Reopen for replies' : 'Close to replies'}</MenuItem>}
                  {t.canModerate && <MenuItem icon={t.isHidden ? Eye : EyeOff} onClick={() => patch.mutate({ isHidden: !t.isHidden })}>{t.isHidden ? 'Show to students' : 'Hide from students'}</MenuItem>}
                  <MenuItem icon={Trash2} tone="danger" onClick={() => setDialog('delete')}>Delete</MenuItem>
                </Menu>
              )}
            </div>
            <RichText html={t.body} className="mt-4" />
            {t.attachments.length > 0 && <FileList files={t.attachments} className="mt-4" />}
          </Card>

          <h2 className="mb-3 mt-6 text-sm font-semibold text-ink">{plural(t.replyCount, 'reply', 'replies')}</h2>
          <Replies thread={t} invalidate={invalidate} readOnly={readOnly} />

          {t.canReply && !readOnly ? <ReplyBox threadId={t.id} invalidate={invalidate} /> : t.isLocked ? <Alert tone="info" className="mt-4">This discussion is closed to new replies.</Alert> : null}

          {dialog === 'edit' && <ThreadDialog thread={t} onClose={() => setDialog(null)} />}
          <ConfirmDialog open={dialog === 'delete'} onClose={() => setDialog(null)} onConfirm={() => remove.mutate()} loading={remove.isPending} title="Delete this discussion?" confirmLabel="Delete">The discussion and all its replies are removed for everyone.</ConfirmDialog>
        </div>
      )}
    </QueryState>
  );
}

function Replies({ thread, invalidate, readOnly }) {
  const [replyTo, setReplyTo] = useState(null);
  // Replies to a reply are shown indented under it (one level).
  const { roots, children } = useMemo(() => {
    const byParent = new Map();
    const top = [];
    const ids = new Set(thread.replies.map((r) => r.id));
    for (const r of thread.replies) {
      if (r.parentReplyId && ids.has(r.parentReplyId)) byParent.set(r.parentReplyId, [...(byParent.get(r.parentReplyId) ?? []), r]);
      else top.push(r);
    }
    return { roots: top, children: byParent };
  }, [thread.replies]);

  if (thread.replies.length === 0) return <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-faint">No replies yet. Be the first to answer.</p>;
  return (
    <ul className="space-y-3">
      {roots.map((r) => (
        <li key={r.id}>
          <ReplyItem reply={r} thread={thread} invalidate={invalidate} readOnly={readOnly} onReply={() => setReplyTo(replyTo === r.id ? null : r.id)} />
          {(children.get(r.id) ?? []).length > 0 && (
            <ul className="ml-6 mt-2 space-y-2 border-l-2 border-line pl-4 sm:ml-10">
              {children.get(r.id).map((c) => <li key={c.id}><ReplyItem reply={c} thread={thread} invalidate={invalidate} readOnly={readOnly} nested /></li>)}
            </ul>
          )}
          {replyTo === r.id && <div className="ml-6 mt-2 sm:ml-10"><ReplyBox threadId={thread.id} parentReplyId={r.id} invalidate={invalidate} onDone={() => setReplyTo(null)} compact /></div>}
        </li>
      ))}
    </ul>
  );
}

function ReplyItem({ reply: r, thread, invalidate, readOnly, onReply, nested }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(r.body);
  const [confirm, setConfirm] = useState(false);
  const patch = useAction((data) => api.patch(`/discussions/replies/${r.id}`, data), { invalidate, onSuccess: () => setEditing(false) });
  const remove = useAction(() => api.delete(`/discussions/replies/${r.id}`), { invalidate, success: 'Reply deleted.', onSuccess: () => setConfirm(false) });
  return (
    <article className={cn('rounded-2xl border bg-surface p-4', r.isHidden ? 'border-warn/50 opacity-80' : 'border-line', nested && 'p-3')}>
      <div className="flex items-start gap-3">
        <Avatar name={r.author.name} fileId={r.author.avatarFileId} size={nested ? 30 : 36} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-sm">
            <span className="font-semibold text-ink">{r.author.name}</span>
            {r.author.role === 'TEACHER' && <Badge tone="brand">Teacher</Badge>}
            {r.isHidden && <Badge tone="warn" icon={EyeOff}>Hidden</Badge>}
            <span className="text-xs text-faint" title={formatDateTime(r.createdAt)}>{relativeTime(r.createdAt)}{r.edited ? ' · edited' : ''}</span>
          </p>
          {editing ? (
            <div className="mt-2 space-y-2">
              <LazyEditor value={body} onChange={setBody} minHeight={80} allowMedia={false} ariaLabel="Edit your reply" />
              <div className="flex justify-end gap-2"><Button size="sm" variant="secondary" onClick={() => { setEditing(false); setBody(r.body); }}>Cancel</Button><Button size="sm" loading={patch.isPending} disabled={isEmptyHtml(body)} onClick={() => patch.mutate({ body })}>Save</Button></div>
            </div>
          ) : (
            <>
              <RichText html={r.body} className="mt-1 text-[15px]" />
              {r.attachments?.length > 0 && <FileList files={r.attachments} className="mt-2" compact />}
              {onReply && thread.canReply && !readOnly && <button type="button" onClick={onReply} className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-soft hover:text-brand"><Reply className="size-3.5" aria-hidden="true" />Reply</button>}
            </>
          )}
        </div>
        {(r.canEdit || r.canModerate) && !readOnly && !editing && (
          <Menu trigger={({ toggle, props }) => <IconButton icon={MoreHorizontal} size="sm" label={`Options for the reply by ${r.author.name}`} onClick={toggle} {...props} />}>
            {r.canEdit && <MenuItem icon={Pencil} onClick={() => setEditing(true)}>Edit</MenuItem>}
            {r.canModerate && <MenuItem icon={r.isHidden ? Eye : EyeOff} onClick={() => patch.mutate({ isHidden: !r.isHidden })}>{r.isHidden ? 'Show to students' : 'Hide from students'}</MenuItem>}
            <MenuItem icon={Trash2} tone="danger" onClick={() => setConfirm(true)}>Delete</MenuItem>
          </Menu>
        )}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} title="Delete this reply?" confirmLabel="Delete">The reply is removed for everyone.</ConfirmDialog>
    </article>
  );
}

function ReplyBox({ threadId, parentReplyId = null, invalidate, onDone, compact }) {
  const [body, setBody] = useState('');
  const [key, setKey] = useState(0);
  const send = useAction(() => api.post(`/discussions/threads/${threadId}/replies`, { body, parentReplyId }), {
    invalidate,
    onSuccess: () => { setBody(''); setKey((k) => k + 1); onDone?.(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); send.mutate(); }} className={cn('space-y-2', !compact && 'mt-5')}>
      {!compact && <h2 className="text-sm font-semibold text-ink">Your reply</h2>}
      {compact && <p className="flex items-center gap-1.5 text-xs text-faint"><CornerDownRight className="size-3.5" aria-hidden="true" />Replying in this conversation</p>}
      <LazyEditor key={key} value={body} onChange={setBody} minHeight={compact ? 70 : 110} allowMedia={false} placeholder="Write a reply…" ariaLabel="Your reply" />
      <div className="flex justify-end gap-2">
        {onDone && <Button variant="secondary" size={compact ? 'sm' : 'md'} onClick={onDone}>Cancel</Button>}
        <Button type="submit" icon={Send} size={compact ? 'sm' : 'md'} loading={send.isPending} disabled={isEmptyHtml(body)}>Post reply</Button>
      </div>
    </form>
  );
}
