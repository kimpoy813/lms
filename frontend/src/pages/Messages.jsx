// Private messages between two people. Who may write to whom is decided by the server
// (students ↔ their teachers by default; student ↔ student only if the administrator allows it).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CheckCheck, MessageSquare, MessageSquarePlus, Paperclip, Search, Send, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { FileList } from '../components/Files.jsx';
import { toast } from '../components/toast.jsx';
import { Alert, Avatar, Badge, Button, cn, EmptyState, Input, Modal, PageHeader, Spinner, useDebounced } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { dateKeyOf, formatDateKey, formatTime, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';
import { isReaderIdle, useLiveInterval, useOnReturn } from '../lib/live.js';
import { useSocketEvent } from '../lib/socket.js';

const ROLE = { TEACHER: 'Teacher', STUDENT: 'Student', ADMIN: 'Administrator' };

/**
 * Put the newest page of a conversation on top of what is already shown: older messages the
 * reader loaded are kept, messages in the page replace their earlier versions (a message may have
 * been deleted since), and new ones are added at the end.
 */
function mergeNewest(current, page) {
  if (page.messages.length === 0) return { ...current, otherLastReadAt: page.otherLastReadAt };
  const oldestFresh = page.messages[0].createdAt;
  const older = current.messages.filter((m) => m.createdAt < oldestFresh);
  return { ...current, ...page, messages: [...older, ...page.messages], hasMore: older.length > 0 ? current.hasMore : page.hasMore };
}

export default function Messages() {
  const { user } = useAuth();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const activeId = params.get('c');
  const to = params.get('to');
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');
  // Without push from the server the list is refreshed on a timer.
  const conversations = useQuery({ queryKey: ['messages', 'conversations'], queryFn: () => api.get('/messages/conversations'), refetchInterval: useLiveInterval(30_000) });

  // Links such as /messages?to=<user> open (or create) the conversation with that person.
  const opened = useRef(null);
  useEffect(() => {
    if (!to || opened.current === to) return;
    opened.current = to;
    api.post('/messages/conversations', { userId: to })
      .then((c) => { client.invalidateQueries({ queryKey: ['messages', 'conversations'] }); setParams({ c: c.id }, { replace: true }); })
      .catch((err) => { toast.error(err.message); setParams({}, { replace: true }); });
  }, [to, client, setParams]);

  // Keep the list fresh when anything happens in any conversation.
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: ['messages'] }), [client]);
  useSocketEvent('message:new', refresh);
  useSocketEvent('message:sent', refresh);
  useOnReturn(useCallback(() => client.invalidateQueries({ queryKey: ['messages', 'conversations'] }), [client]));

  const list = useMemo(() => (conversations.data ?? []).filter((c) => !filter.trim() || c.with?.name.toLowerCase().includes(filter.trim().toLowerCase())), [conversations.data, filter]);

  return (
    <>
      <div className={cn(activeId && 'max-lg:hidden')}><PageHeader title="Messages" actions={<Button icon={MessageSquarePlus} onClick={() => setPicking(true)}>New message</Button>} /></div>
      <div className="grid h-[calc(100dvh-13.5rem)] min-h-[26rem] grid-cols-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-card max-lg:data-[open=true]:h-[calc(100dvh-7rem)] lg:grid-cols-[20rem_minmax(0,1fr)]" data-open={Boolean(activeId)}>
        <aside className={cn('flex min-h-0 flex-col border-line lg:border-r', activeId && 'max-lg:hidden')}>
          <div className="border-b border-line p-3">
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden="true" /><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter conversations" aria-label="Filter conversations" className="pl-9" /></div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {conversations.isPending ? <div className="grid place-items-center py-10"><Spinner /></div>
              : list.length === 0 ? <EmptyState compact icon={MessageSquare} title={filter ? 'No conversation matches' : 'No messages yet'} description={filter ? null : 'Start a conversation with a teacher or a student of your classes.'} />
                : (
                  <ul>
                    {list.map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => setParams({ c: c.id })} aria-current={c.id === activeId ? 'true' : undefined} className={cn('flex w-full items-center gap-3 border-b border-line px-3 py-3 text-left', c.id === activeId ? 'bg-brand-soft' : 'hover:bg-raised')}>
                          <Avatar name={c.with?.name} fileId={c.with?.avatarFileId} size={40} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline justify-between gap-2">
                              <span className={cn('truncate text-sm', c.unread > 0 ? 'font-bold text-ink' : 'font-semibold text-ink')}>{c.with?.name ?? 'Former user'}</span>
                              <span className="shrink-0 text-[11px] text-faint">{c.lastMessage ? relativeTime(c.lastMessage.createdAt).replace(' ago', '') : ''}</span>
                            </span>
                            <span className="flex items-center gap-2">
                              <span className={cn('min-w-0 flex-1 truncate text-[13px]', c.unread > 0 ? 'font-medium text-ink' : 'text-faint')}>{c.lastMessage ? `${c.lastMessage.senderId === user.id ? 'You: ' : ''}${c.lastMessage.preview}` : 'No messages yet'}</span>
                              {c.unread > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-brand-fill px-1.5 text-[11px] font-bold leading-5 text-white" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
        </aside>
        <section className={cn('flex min-h-0 flex-col', !activeId && 'max-lg:hidden')}>
          {activeId ? <Conversation key={activeId} id={activeId} onBack={() => setParams({})} /> : (
            <div className="grid flex-1 place-items-center"><EmptyState icon={MessageSquare} title="Choose a conversation" description="Or start a new one. Messages are private between you and the other person." action={<Button variant="secondary" icon={MessageSquarePlus} onClick={() => setPicking(true)}>New message</Button>} /></div>
          )}
        </section>
      </div>
      {picking && <ContactPicker onClose={() => setPicking(false)} onPick={(person) => { setPicking(false); setParams({ to: person.id }); }} />}
    </>
  );
}

function Conversation({ id, onBack }) {
  const { user, runtime } = useAuth();
  const client = useQueryClient();
  const key = useMemo(() => ['messages', 'conversation', id], [id]);
  const query = useQuery({ queryKey: key, queryFn: () => api.get(`/messages/conversations/${id}`) });
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [older, setOlder] = useState({ loading: false });
  const scroller = useRef(null);
  const fileInput = useRef(null);
  const stick = useRef(true);
  const data = query.data;

  const markRead = useCallback(() => {
    api.post(`/messages/conversations/${id}/read`).then(() => client.invalidateQueries({ queryKey: ['messages', 'unread'] })).catch(() => {});
    client.setQueryData(['messages', 'conversations'], (list) => list?.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  }, [id, client]);

  // Live updates for this conversation.
  const append = useCallback((m) => {
    if (m.conversationId !== id) return;
    client.setQueryData(key, (d) => (d && !d.messages.some((x) => x.id === m.id) ? { ...d, messages: [...d.messages, m] } : d));
    if (m.senderId !== user.id && document.visibilityState === 'visible') markRead();
  }, [id, key, client, user.id, markRead]);
  useSocketEvent('message:new', append);
  useSocketEvent('message:sent', append);
  useSocketEvent('message:read', useCallback((e) => { if (e.conversationId === id) client.setQueryData(key, (d) => (d ? { ...d, otherLastReadAt: e.readAt } : d)); }, [id, key, client]));
  useSocketEvent('message:deleted', useCallback((e) => { if (e.conversationId === id) client.setQueryData(key, (d) => (d ? { ...d, messages: d.messages.map((m) => (m.id === e.id ? { ...m, deleted: true, body: null, attachments: [] } : m)) } : d)); }, [id, key, client]));

  useEffect(() => { if (data) markRead(); }, [Boolean(data), markRead]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the server cannot push, ask for the newest messages and merge them in: every 5 seconds
  // while the conversation is active, then less and less often, because the host counts every
  // request. (Refetching the query instead would throw away the older messages already loaded.)
  const poller = useRef({ active: () => {} });
  useEffect(() => {
    if (runtime.realtime) return undefined;
    let stopped = false;
    let timer = null;
    let due = 0;
    let lastActivity = Date.now();
    const delay = () => {
      const quietFor = Date.now() - lastActivity;
      return quietFor < 2 * 60_000 ? 5_000 : quietFor < 10 * 60_000 ? 15_000 : 60_000;
    };
    const schedule = (ms = delay()) => {
      clearTimeout(timer);
      due = Date.now() + ms;
      if (!stopped) timer = setTimeout(tick, ms);
    };
    async function tick() {
      if (document.visibilityState === 'visible' && !isReaderIdle()) {
        try {
          const page = await api.get(`/messages/conversations/${id}`);
          if (stopped) return;
          const known = new Set((client.getQueryData(key)?.messages ?? []).map((m) => m.id));
          client.setQueryData(key, (d) => (d ? mergeNewest(d, page) : page));
          if (page.messages.some((m) => !known.has(m.id))) lastActivity = Date.now();
          if (page.messages.some((m) => !known.has(m.id) && m.senderId !== user.id)) {
            markRead();
            client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
          }
        } catch {
          // The next round tries again; a lost session is handled by the rest of the app.
        }
      }
      schedule();
    }
    // Typing, sending or coming back to the tab: check again soon.
    const active = () => {
      lastActivity = Date.now();
      if (due - Date.now() > 5_000) schedule(1_000);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') active(); };
    poller.current = { active };
    document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      poller.current = { active: () => {} };
    };
  }, [runtime.realtime, id, key, client, user.id, markRead]);
  useEffect(() => { if (text) poller.current.active(); }, [text]);
  useOnReturn(useCallback(() => poller.current.active(), []));

  // Stay at the newest message unless the reader scrolled up.
  const count = data?.messages.length ?? 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count]);

  const send = useAction(() => api.post(`/messages/conversations/${id}/messages`, { body: text.trim(), fileIds: files.map((f) => f.id) }), {
    onSuccess: (m) => { setText(''); setFiles([]); stick.current = true; append(m); poller.current.active(); client.invalidateQueries({ queryKey: ['messages', 'conversations'] }); },
  });
  const remove = useAction((messageId) => api.delete(`/messages/messages/${messageId}`), {});

  const loadOlder = async () => {
    if (!data?.messages.length) return;
    setOlder({ loading: true });
    const el = scroller.current;
    const before = el.scrollHeight;
    try {
      const page = await api.get(`/messages/conversations/${id}`, { before: data.messages[0].id });
      stick.current = false;
      client.setQueryData(key, (d) => ({ ...d, messages: [...page.messages, ...d.messages], hasMore: page.hasMore }));
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - before; });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setOlder({ loading: false });
    }
  };
  const attach = async (list) => {
    const chosen = [...list].slice(0, 5 - files.length);
    if (chosen.length === 0) return;
    setUploading(true);
    try {
      setFiles([...files, ...(await api.upload(chosen))]);
    } catch (err) {
      if (err.saved?.length) setFiles([...files, ...err.saved]);
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  };
  const submit = (e) => { e?.preventDefault(); if ((text.trim() || files.length > 0) && !send.isPending) send.mutate(); };

  if (query.isPending) return <div className="grid flex-1 place-items-center"><Spinner /></div>;
  if (query.isError) return <div className="grid flex-1 place-items-center"><EmptyState title="This conversation could not be opened" description={query.error.message} action={<Button variant="secondary" onClick={onBack}>Back</Button>} /></div>;

  const other = data.with;
  const lastMine = [...data.messages].reverse().find((m) => m.senderId === user.id && !m.deleted);
  const seen = lastMine && data.otherLastReadAt && new Date(data.otherLastReadAt) >= new Date(lastMine.createdAt);
  let lastDay = null;

  return (
    <>
      <header className="flex items-center gap-3 border-b border-line px-3 py-2.5 sm:px-4">
        <button type="button" onClick={onBack} className="grid size-9 place-items-center rounded-lg text-soft hover:bg-raised lg:hidden" aria-label="Back to conversations"><ArrowLeft className="size-5" /></button>
        <Avatar name={other?.name} fileId={other?.avatarFileId} size={38} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{other?.name ?? 'Former user'}</p>
          <p className="text-xs text-faint">{ROLE[other?.role] ?? ''}{other && !other.active ? ' · account not active' : ''}</p>
        </div>
      </header>

      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 space-y-1 overflow-y-auto bg-canvas px-3 py-4 sm:px-5" role="log" aria-label={`Messages with ${other?.name ?? 'this person'}`} aria-live="polite">
        {data.hasMore && <div className="pb-3 text-center"><Button size="sm" variant="secondary" loading={older.loading} onClick={loadOlder}>Show earlier messages</Button></div>}
        {data.messages.length === 0 && <p className="py-10 text-center text-sm text-faint">No messages yet. Say hello.</p>}
        {data.messages.map((m, i) => {
          const mine = m.senderId === user.id;
          const day = dateKeyOf(m.createdAt);
          const newDay = day !== lastDay;
          lastDay = day;
          const next = data.messages[i + 1];
          const grouped = next && next.senderId === m.senderId && dateKeyOf(next.createdAt) === day && new Date(next.createdAt) - new Date(m.createdAt) < 5 * 60_000;
          return (
            <div key={m.id}>
              {newDay && <p className="py-3 text-center text-[11px] font-semibold uppercase tracking-wide text-faint">{formatDateKey(day)}</p>}
              <div className={cn('group flex items-end gap-2', mine ? 'justify-end' : 'justify-start', grouped ? 'mb-0.5' : 'mb-2.5')}>
                {mine && !m.deleted && <button type="button" onClick={() => remove.mutate(m.id)} className="mb-1 rounded p-1 text-faint opacity-0 hover:bg-raised hover:text-bad focus:opacity-100 group-hover:opacity-100" aria-label="Delete this message" title="Delete for everyone"><Trash2 className="size-3.5" /></button>}
                <div className={cn('max-w-[80%] rounded-2xl px-3.5 py-2 text-[15px] leading-snug sm:max-w-[70%]', m.deleted ? 'border border-dashed border-line-strong bg-transparent italic text-faint' : mine ? 'rounded-br-md bg-brand-fill text-white' : 'rounded-bl-md border border-line bg-surface text-ink')}>
                  {/* Message text is shown as plain text, never interpreted as HTML. */}
                  {m.deleted ? 'This message was deleted' : m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                  {!m.deleted && m.attachments?.length > 0 && <div className={cn(m.body && 'mt-2', '[&_li]:border-0 [&_li]:bg-black/5', mine && '[&_a]:text-white [&_span]:text-white/80 [&_svg]:text-white')}><FileList files={m.attachments} compact /></div>}
                  {!grouped && <p className={cn('mt-1 text-right text-[10px]', m.deleted ? 'text-faint' : mine ? 'text-white/70' : 'text-faint')}>{formatTime(m.createdAt)}</p>}
                </div>
              </div>
              {mine && lastMine?.id === m.id && <p className="-mt-1.5 mb-2 flex items-center justify-end gap-1 pr-1 text-[11px] text-faint">{seen ? <><CheckCheck className="size-3.5 text-brand" aria-hidden="true" />Seen</> : <><Check className="size-3.5" aria-hidden="true" />Sent</>}</p>}
            </div>
          );
        })}
      </div>

      {data.canSend ? (
        <form onSubmit={submit} className="border-t border-line p-3">
          {files.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2">
              {files.map((f) => <li key={f.id} className="flex items-center gap-1.5 rounded-lg bg-raised py-1 pl-2.5 pr-1 text-[13px] text-ink"><Paperclip className="size-3.5 text-faint" aria-hidden="true" /><span className="max-w-[12rem] truncate">{f.name}</span><button type="button" onClick={() => setFiles(files.filter((x) => x.id !== f.id))} className="rounded p-1 text-faint hover:text-bad" aria-label={`Remove ${f.name}`}><X className="size-3.5" /></button></li>)}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading || files.length >= 5} className="grid size-10 shrink-0 place-items-center rounded-lg text-soft hover:bg-raised disabled:opacity-50" aria-label="Attach a file">{uploading ? <Spinner className="size-4" label="Uploading" /> : <Paperclip className="size-5" />}</button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { attach(e.target.files); e.target.value = ''; }} />
            <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }} rows={1} maxLength={5000} placeholder="Write a message…" aria-label="Write a message" className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-[15px] text-ink placeholder:text-faint focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25" style={{ fieldSizing: 'content' }} />
            <Button type="submit" icon={Send} loading={send.isPending} disabled={!text.trim() && files.length === 0} aria-label="Send" />
          </div>
          <p className="mt-1.5 hidden text-[11px] text-faint sm:block">Enter to send · Shift + Enter for a new line</p>
        </form>
      ) : <div className="border-t border-line p-3"><Alert tone="info">You can read this conversation, but new messages cannot be sent{other && !other.active ? ' because the account is no longer active' : ' — messaging between you is not enabled'}.</Alert></div>}
    </>
  );
}

function ContactPicker({ onClose, onPick }) {
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 250);
  const contacts = useQuery({ queryKey: ['messages', 'contacts', term], queryFn: () => api.get('/messages/contacts', { search: term || undefined }) });
  return (
    <Modal open onClose={onClose} title="New message" description="People you are allowed to write to." size="sm">
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name" aria-label="Search people" data-autofocus />
      <div className="mt-3 max-h-80 overflow-y-auto">
        {contacts.isPending ? <div className="grid place-items-center py-8"><Spinner /></div>
          : (contacts.data ?? []).length === 0 ? <p className="py-8 text-center text-sm text-faint">{term ? 'No one matches.' : 'There is no one you can message yet. Join a class first.'}</p>
            : (
              <ul>
                {contacts.data.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-raised">
                      <Avatar name={p.name} fileId={p.avatarFileId} size={36} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{p.name}</span>
                      <Badge>{ROLE[p.role]}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </Modal>
  );
}
