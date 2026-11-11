// The full notification history.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Card, cn, EmptyState, IconButton, PageHeader, Pagination, QueryState, Segmented } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDateTime, relativeTime } from '../lib/format.js';
import { useAction } from '../lib/query.js';

export default function Notifications() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['notifications', 'list', { unread, page }], queryFn: () => api.list('/notifications', { unread: unread || undefined, page, pageSize: 25 }), placeholderData: (prev) => prev });
  const invalidate = [['notifications']];
  const readAll = useAction(() => api.post('/notifications/read-all'), { invalidate, success: 'All notifications marked as read.' });
  const remove = useAction((id) => api.delete(`/notifications/${id}`), { invalidate });
  const open = (n) => {
    if (!n.readAt) api.post(`/notifications/${n.id}/read`).then(() => client.invalidateQueries({ queryKey: ['notifications'] })).catch(() => {});
    if (n.link) navigate(n.link);
  };
  const meta = query.data?.meta;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" description={meta?.unread ? `${meta.unread} unread` : 'You are all caught up.'} actions={<Button variant="secondary" icon={CheckCheck} loading={readAll.isPending} disabled={!meta?.unread} onClick={() => readAll.mutate()}>Mark all as read</Button>} />
      <Segmented className="mb-4" label="Show" value={unread ? 'UNREAD' : 'ALL'} onChange={(v) => { setUnread(v === 'UNREAD'); setPage(1); }} options={[{ value: 'ALL', label: 'All' }, { value: 'UNREAD', label: 'Unread' }]} />
      <QueryState query={{ ...query, data: query.data?.data }}>
        {(list) => list.length === 0 ? <Card><EmptyState icon={Bell} title={unread ? 'No unread notifications' : 'No notifications yet'} description="Grades, announcements, deadlines and requests will appear here." /></Card> : (
          <Card padded={false}>
            <ul className="divide-y divide-line">
              {list.map((n) => (
                <li key={n.id} className="group flex items-start gap-3 px-4 py-3.5 hover:bg-raised/60">
                  <span className={cn('mt-2 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand')} aria-label={n.readAt ? undefined : 'Unread'} />
                  <button type="button" onClick={() => open(n)} className="min-w-0 flex-1 text-left">
                    <span className={cn('block text-sm leading-snug', n.readAt ? 'text-soft' : 'font-semibold text-ink')}>{n.title}</span>
                    {n.body && <span className="mt-0.5 block text-[13px] text-faint">{n.body}</span>}
                    <span className="mt-1 block text-xs text-faint" title={formatDateTime(n.createdAt)}>{relativeTime(n.createdAt)}</span>
                  </button>
                  <IconButton icon={Trash2} size="sm" label="Delete this notification" className="opacity-0 focus:opacity-100 group-hover:opacity-100" onClick={() => remove.mutate(n.id)} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </QueryState>
      <Pagination meta={meta} onPage={setPage} />
    </div>
  );
}
