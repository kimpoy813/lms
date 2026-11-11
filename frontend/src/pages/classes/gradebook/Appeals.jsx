// Students' questions about a score, answered by the teacher.
import { Check, Inbox, X } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Badge, Button, Card, EmptyState, Field, Modal, QueryState, Textarea } from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { formatDateTime, relativeTime } from '../../../lib/format.js';
import { useAction } from '../../../lib/query.js';
import { useClass } from '../useClass.js';

export default function Appeals({ query }) {
  const [answering, setAnswering] = useState(null);
  return (
    <>
      <QueryState query={query}>
        {(list) => list.length === 0 ? <Card><EmptyState icon={Inbox} title="No grade questions" description="When a student questions a score, it appears here for your answer." /></Card> : (
        <ul className="space-y-3">
          {list.map((a) => (
            <li key={a.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <Avatar name={a.student.name} size={38} />
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-sm font-semibold text-ink">{a.student.name} <span className="font-normal text-faint">· about {a.item ? `“${a.item.title}”` : 'the overall grade'}</span></p>
                    <p className="text-xs text-faint">Sent {relativeTime(a.createdAt)}</p>
                    <p className="mt-2 whitespace-pre-wrap rounded-lg bg-raised px-3 py-2 text-sm text-ink">{a.reason}</p>
                    {a.response && <p className="mt-2 text-sm text-soft"><span className="font-medium text-ink">Your answer{a.resolvedAt ? ` (${formatDateTime(a.resolvedAt)})` : ''}:</span> {a.response}</p>}
                  </div>
                  {a.status === 'PENDING' ? (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" icon={Check} onClick={() => setAnswering({ appeal: a, status: 'APPROVED' })}>Accept</Button>
                      <Button size="sm" variant="secondary" icon={X} onClick={() => setAnswering({ appeal: a, status: 'REJECTED' })}>Decline</Button>
                    </div>
                  ) : <Badge tone={a.status === 'APPROVED' ? 'ok' : 'neutral'}>{a.status === 'APPROVED' ? 'Accepted' : 'Declined'}</Badge>}
                </div>
              </Card>
            </li>
          ))}
        </ul>
        )}
      </QueryState>
      {answering && <AnswerDialog {...answering} onClose={() => setAnswering(null)} />}
    </>
  );
}

function AnswerDialog({ appeal, status, onClose }) {
  const { cls, base } = useClass();
  const [response, setResponse] = useState('');
  const [error, setError] = useState(null);
  const resolve = useAction(() => api.post(`${base}/gradebook/appeals/${appeal.id}/resolve`, { status, response: response.trim() }), {
    invalidate: [['class', cls.id, 'gradebook'], ['dashboard']],
    success: 'Answer sent to the student.', onSuccess: onClose,
    onError: (err) => { setError(err.fields?.response ?? err.message); return true; },
  });
  return (
    <Modal open onClose={onClose} title={status === 'APPROVED' ? 'Accept this request' : 'Decline this request'} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={resolve.isPending} disabled={response.trim().length < 3} onClick={() => resolve.mutate()}>Send answer</Button></>}>
      <p className="mb-4 text-sm text-soft">{status === 'APPROVED' ? 'Accepting records your decision. If the score should change, update it in the assignment, quiz or gradebook column — it is not changed automatically.' : 'The student is told that the score stays as it is.'}</p>
      <Field label="Answer for the student" error={error}><Textarea rows={3} value={response} onChange={(e) => setResponse(e.target.value)} maxLength={2000} data-autofocus /></Field>
    </Modal>
  );
}
