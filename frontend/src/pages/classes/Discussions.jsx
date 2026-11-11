// Class discussion board: the list of threads.
import { useQuery } from '@tanstack/react-query';
import { Lock, MessagesSquare, Pin, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FileUpload } from '../../components/Files.jsx';
import LazyEditor from '../../components/LazyEditor.jsx';
import { isEmptyHtml } from '../../components/RichText.jsx';
import { Avatar, Badge, Button, Card, cn, EmptyState, Field, Input, Modal, ModalActions, Pagination, QueryState, SearchInput, useDebounced } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { plural, relativeTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import { useClass } from './useClass.js';

export default function Discussions() {
  const { cls, base } = useClass();
  const [search, setSearch] = useState('');
  const [topic, setTopic] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(search.trim());
  const query = useQuery({ queryKey: ['class', cls.id, 'discussions', { term, topic, page }], queryFn: () => api.list(`${base}/discussions`, { search: term || undefined, topic: topic || undefined, page }), placeholderData: (prev) => prev });
  const meta = query.data?.meta;
  const canCreate = meta?.canCreate && cls.status !== 'ARCHIVED';

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search discussions…" className="w-full sm:w-72" />
        {(meta?.topics ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {['', ...meta.topics].map((t) => <button key={t || 'all'} type="button" onClick={() => { setTopic(t); setPage(1); }} aria-pressed={topic === t} className={cn('rounded-full border px-3 py-1 text-[13px] font-medium', topic === t ? 'border-brand bg-brand-soft text-brand' : 'border-line text-soft hover:border-line-strong')}>{t || 'All topics'}</button>)}
          </div>
        )}
        {canCreate && <Button icon={Plus} className="ml-auto" onClick={() => setCreating(true)}>New discussion</Button>}
      </div>
      <QueryState query={{ ...query, data: query.data?.data }}>
        {(threads) => threads.length === 0 ? (
          <Card><EmptyState icon={MessagesSquare} title={term || topic ? 'No discussions match' : 'No discussions yet'} description={term || topic ? null : 'Ask a question about the lesson, or start a topic for the class.'} action={canCreate && !term && !topic ? <Button icon={Plus} onClick={() => setCreating(true)}>Start a discussion</Button> : null} /></Card>
        ) : (
          <ul className="space-y-2.5">
            {threads.map((t) => (
              <li key={t.id}>
                <Link to={`${base}/discussions/${t.id}`} className={cn('flex items-start gap-3.5 rounded-2xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong', t.isHidden && 'opacity-60')}>
                  <Avatar name={t.author.name} fileId={t.author.avatarFileId} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      {t.isPinned && <Pin className="size-4 shrink-0 text-brand" aria-label="Pinned" />}
                      <span className="font-semibold text-ink">{t.title}</span>
                      {t.topic && <Badge>{t.topic}</Badge>}
                      {t.isLocked && <Badge icon={Lock}>Closed</Badge>}
                      {t.isHidden && <Badge tone="warn">Hidden</Badge>}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] text-soft">{t.excerpt}</span>
                    <span className="mt-1.5 block text-xs text-faint">{t.author.name}{t.author.role === 'TEACHER' ? ' (teacher)' : ''} · {plural(t.replyCount, 'reply', 'replies')} · last activity {relativeTime(t.lastActivityAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Pagination meta={meta} onPage={setPage} />
      {creating && <ThreadDialog topics={meta?.topics ?? []} onClose={() => setCreating(false)} />}
    </>
  );
}

export function ThreadDialog({ thread, topics = [], onClose }) {
  const { cls, base } = useClass();
  const navigate = useNavigate();
  const [v, setV] = useState({ title: thread?.title ?? '', body: thread?.body ?? '', topic: thread?.topic ?? '', files: thread?.attachments ?? [] });
  const [errors, setErrors] = useState({});
  const save = useAction(() => {
    const body = { title: v.title.trim(), body: v.body, topic: v.topic.trim() || null, fileIds: v.files.map((f) => f.id) };
    return thread ? api.patch(`/discussions/threads/${thread.id}`, body) : api.post(`${base}/discussions`, body);
  }, {
    invalidate: [['class', cls.id, 'discussions'], ['class', cls.id, 'thread']],
    success: thread ? 'Discussion updated.' : 'Discussion posted.',
    onSuccess: (saved) => { onClose(); if (!thread) navigate(`${base}/discussions/${saved.id}`); },
    onError: (err) => { if (err.fields) { setErrors(err.fields); return true; } return false; },
  });
  return (
    <Modal open onClose={onClose} title={thread ? 'Edit discussion' : 'New discussion'} size="lg">
      <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }} className="space-y-4">
        <Field label="Title" error={errors.title}><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={200} required placeholder="What is this about?" /></Field>
        <Field label="Message" error={errors.body}><LazyEditor value={v.body} onChange={(body) => setV({ ...v, body })} minHeight={150} allowMedia={false} placeholder="Share the details. Be respectful — your teacher moderates this board." ariaLabel="Message" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Topic" optional error={errors.topic}><Input value={v.topic} onChange={(e) => setV({ ...v, topic: e.target.value })} maxLength={60} list="thread-topics" placeholder="e.g. Module 2" /><datalist id="thread-topics">{topics.map((t) => <option key={t} value={t} />)}</datalist></Field>
          <Field label="Attachments" optional error={errors.fileIds}><FileUpload value={v.files} onChange={(files) => setV({ ...v, files })} max={5} compact label="Attach files" /></Field>
        </div>
        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!v.title.trim() || isEmptyHtml(v.body)}>{thread ? 'Save' : 'Post'}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
