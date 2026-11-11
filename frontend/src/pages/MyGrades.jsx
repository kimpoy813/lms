// A student's grades across all classes — the closest thing to a report card.
import { useQuery } from '@tanstack/react-query';
import { GraduationCap } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { Badge, Card, cn, EmptyState, PageHeader, QueryState } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatPercent } from '../lib/format.js';

export default function MyGrades() {
  const { isStudent } = useAuth();
  const query = useQuery({ queryKey: ['grades', 'mine'], queryFn: () => api.get('/grades/mine'), enabled: isStudent });
  if (!isStudent) return <><PageHeader title="Grades" /><Card><EmptyState icon={GraduationCap} title="Grades are shown per class" description="Open a class and choose Gradebook." /></Card></>;
  return (
    <>
      <PageHeader title="My grades" description="Grades your teachers have released. Open a class to see the scores behind each grade." />
      <QueryState query={query}>
        {(classes) => classes.length === 0 ? <Card><EmptyState icon={GraduationCap} title="No classes yet" description="Your grades appear here after you join a class." /></Card> : (
          <ul className="space-y-4">
            {classes.map((c) => (
              <li key={c.classId}>
                <Link to={`/classes/${c.classId}/grades`} className="block rounded-2xl border border-line bg-surface p-5 shadow-card transition-colors hover:border-line-strong">
                  <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">{c.code}{c.section ? ` · ${c.section}` : ''}{c.finalized && <Badge tone="ok">Final</Badge>}{c.classStatus === 'ARCHIVED' && <Badge>Archived</Badge>}</p>
                      <p className="text-sm text-soft">{c.title} · {c.units} {c.units === 1 ? 'unit' : 'units'}</p>
                      <p className="text-xs text-faint">{c.teacher} · {c.semester}, {c.academicYear}</p>
                    </div>
                    <dl className="flex flex-wrap gap-x-7 gap-y-2 text-right">
                      {c.periods.map((p) => (
                        <div key={p.name}>
                          <dt className="text-xs font-medium text-faint">{p.name}</dt>
                          <dd className="text-sm">{p.published && p.percent !== null ? <><span className="text-lg font-bold tabular-nums text-ink">{p.label ?? formatPercent(p.percent)}</span>{p.label && <span className="ml-1.5 text-xs tabular-nums text-faint">{formatPercent(p.percent)}</span>}</> : <span className="text-faint">{p.published ? '—' : 'Not released'}</span>}</dd>
                        </div>
                      ))}
                      <div>
                        <dt className="text-xs font-medium text-faint">{c.finalized ? 'Final grade' : 'So far'}</dt>
                        <dd>{c.overall ? <><span className={cn('text-lg font-bold tabular-nums', c.overall.isPassing === false ? 'text-bad' : 'text-ink')}>{c.overall.label ?? formatPercent(c.overall.percent)}</span>{c.overall.label && <span className="ml-1.5 text-xs tabular-nums text-faint">{formatPercent(c.overall.percent)}</span>}</> : <span className="text-sm text-faint">—</span>}</dd>
                      </div>
                    </dl>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </>
  );
}
