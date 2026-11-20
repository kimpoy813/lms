// A student's grades across all classes — with term filter, GWA summary and Report Card export.
import { useQuery } from '@tanstack/react-query';
import { Download, GraduationCap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { toast } from '../components/toast.jsx';
import { Badge, Button, Card, cn, EmptyState, Menu, MenuItem, PageHeader, QueryState, Select } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatPercent } from '../lib/format.js';

export default function MyGrades() {
  const { isStudent } = useAuth();
  const [semesterId, setSemesterId] = useState('');
  const [downloading, setDownloading] = useState(false);
  const query = useQuery({ queryKey: ['grades', 'mine'], queryFn: () => api.get('/grades/mine'), enabled: isStudent });

  const terms = useMemo(() => {
    const seen = new Map();
    for (const c of query.data ?? []) {
      if (c.semesterId && !seen.has(c.semesterId)) seen.set(c.semesterId, `${c.semester}, ${c.academicYear}`);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [query.data]);

  const filtered = useMemo(
    () => (semesterId ? (query.data ?? []).filter((c) => c.semesterId === semesterId) : (query.data ?? [])),
    [query.data, semesterId],
  );

  const summary = useMemo(() => {
    const totalUnits = Math.round(filtered.reduce((sum, c) => sum + (Number(c.units) || 0), 0) * 10000) / 10000;
    const graded = filtered.filter((c) => c.overall && typeof c.overall.percent === 'number');
    const weightSum = graded.reduce((sum, c) => sum + (Number(c.units) > 0 ? Number(c.units) : 1), 0);
    const average = weightSum > 0
      ? graded.reduce((sum, c) => sum + c.overall.percent * (Number(c.units) > 0 ? Number(c.units) : 1), 0) / weightSum
      : null;
    return { subjects: filtered.length, totalUnits, gradedCount: graded.length, average };
  }, [filtered]);

  const exportReport = async (format) => {
    setDownloading(true);
    try {
      await api.download('/grades/mine/export', { format, ...(semesterId ? { semesterId } : {}) }, `report-card.${format}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDownloading(false);
    }
  };

  if (!isStudent) return <><PageHeader title="Grades" /><Card><EmptyState icon={GraduationCap} title="Grades are shown per class" description="Open a class and choose Gradebook." /></Card></>;
  return (
    <>
      <PageHeader
        title="My grades"
        description="Grades your teachers have released. Open a class to see the scores behind each grade."
        actions={(query.data?.length ?? 0) > 0 && (
          <Menu trigger={({ toggle, props }) => <Button variant="secondary" icon={Download} loading={downloading} onClick={toggle} {...props}>Report card</Button>}>
            <MenuItem onClick={() => exportReport('pdf')}>Download PDF</MenuItem>
            <MenuItem onClick={() => exportReport('xlsx')}>Excel (.xlsx)</MenuItem>
            <MenuItem onClick={() => exportReport('csv')}>CSV</MenuItem>
          </Menu>
        )}
      />
      <QueryState query={query}>
        {(classes) => classes.length === 0 ? <Card><EmptyState icon={GraduationCap} title="No classes yet" description="Your grades appear here after you join a class." /></Card> : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-4 text-sm text-soft">
                <span><strong className="font-semibold text-ink">{summary.subjects}</strong> {summary.subjects === 1 ? 'subject' : 'subjects'}</span>
                <span><strong className="font-semibold text-ink">{summary.totalUnits}</strong> {summary.totalUnits === 1 ? 'unit' : 'units'}</span>
                {summary.average !== null && (
                  <span>Weighted average: <strong className="font-semibold text-ink">{formatPercent(summary.average)}</strong></span>
                )}
              </div>
              {terms.length > 1 && (
                <Select aria-label="Filter by term" value={semesterId} onChange={(e) => setSemesterId(e.target.value)} className="w-full sm:w-64">
                  <option value="">All terms</option>
                  {terms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </Select>
              )}
            </div>
            <ul className="space-y-4">
              {filtered.map((c) => (
                <li key={c.classId}>
                  <Link to={`/classes/${c.classId}/grades`} className="block rounded-2xl border border-line bg-surface p-5 shadow-card transition-colors hover:border-line-strong">
                    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                          {c.code}{c.section ? ` · ${c.section}` : ''}
                          {c.finalized && <Badge tone="ok">Final</Badge>}
                          {c.ranking && <Badge tone="brand">Rank #{c.ranking.rank} of {c.ranking.totalRanked}</Badge>}
                          {c.classStatus === 'ARCHIVED' && <Badge>Archived</Badge>}
                        </p>
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
          </>
        )}
      </QueryState>
    </>
  );
}
