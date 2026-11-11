// A student's grades in one class.
import { useQuery } from '@tanstack/react-query';
import { MessageSquareWarning } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, Field, Modal, QueryState, Textarea } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useAction } from '../../lib/query.js';
import StudentGrades from './gradebook/StudentGrades.jsx';
import { useClass } from './useClass.js';

export default function Grades() {
  const { cls, canManage, base } = useClass();
  const [appeal, setAppeal] = useState(null); // { item } or { item: null } for the overall grade
  const query = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'mine'], queryFn: () => api.get(`${base}/gradebook/mine`), enabled: !canManage });
  const appeals = useQuery({ queryKey: ['class', cls.id, 'gradebook', 'appeals'], queryFn: () => api.get(`${base}/gradebook/appeals`), enabled: !canManage });
  if (canManage) return <Card className="text-center text-sm text-soft">Open the Gradebook tab to see and enter grades.</Card>;

  return (
    <QueryState query={query}>
      {(data) => (
        <div className="space-y-5">
          {data.finalized && <Alert tone="ok" title="Final grades have been submitted">Submitted {formatDateTime(data.finalizedAt)}.</Alert>}
          <StudentGrades data={data} onAppeal={cls.status === 'ARCHIVED' ? undefined : (item) => setAppeal({ item })} />
          {(appeals.data ?? []).length > 0 && (
            <Card>
              <h3 className="mb-3 text-[15px] font-semibold">My questions about grades</h3>
              <ul className="divide-y divide-line">
                {appeals.data.map((a) => (
                  <li key={a.id} className="py-3 first:pt-0 last:pb-0 text-sm">
                    <p className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{a.item ? a.item.title : 'Overall grade'}</span><span className={a.status === 'PENDING' ? 'text-warn' : a.status === 'APPROVED' ? 'text-ok' : 'text-soft'}>{a.status === 'PENDING' ? 'Waiting for your teacher' : a.status === 'APPROVED' ? 'Accepted' : 'Declined'}</span></p>
                    <p className="mt-1 text-soft">{a.reason}</p>
                    {a.response && <p className="mt-1 text-soft"><span className="font-medium text-ink">Teacher:</span> {a.response}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {data.periods.some((p) => p.published) && cls.status !== 'ARCHIVED' && (
            <p className="text-center text-sm text-soft">Think a grade is wrong? <button type="button" onClick={() => setAppeal({ item: null })} className="font-semibold text-brand hover:underline">Ask your teacher to review it</button>.</p>
          )}
          {appeal && <AppealDialog item={appeal.item} onClose={() => setAppeal(null)} />}
        </div>
      )}
    </QueryState>
  );
}

function AppealDialog({ item, onClose }) {
  const { cls, base } = useClass();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const send = useAction(() => api.post(`${base}/gradebook/appeals`, { ...(item ? { gradeItemId: item.id } : {}), reason: reason.trim() }), {
    invalidate: [['class', cls.id, 'gradebook', 'appeals']],
    success: 'Your question was sent to your teacher.', onSuccess: onClose,
    onError: (err) => { setError(err.fields?.reason ?? err.message); return true; },
  });
  return (
    <Modal open onClose={onClose} title={item ? `Question about “${item.title}”` : 'Ask for a grade review'} description="Be specific and polite. Your teacher will answer here and you will be notified."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={MessageSquareWarning} loading={send.isPending} disabled={reason.trim().length < 10} onClick={() => send.mutate()}>Send</Button></>}>
      <Field label="What should be reviewed, and why?" error={error} hint="At least 10 characters.">
        <Textarea rows={4} value={reason} onChange={(e) => { setReason(e.target.value); setError(null); }} maxLength={2000} placeholder="e.g. In question 4 I answered “Operating system”, which is one of the accepted answers in the lesson." data-autofocus />
      </Field>
    </Modal>
  );
}
