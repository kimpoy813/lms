// Anonymous grade-release ranking:
//   - TeacherRankingTab: lets teachers toggle ranking visibility, switch between named honor roll
//     and the exact anonymous student preview, change period scope, and export either view.
//   - StudentRankingCard: lets enrolled students view, copy, regenerate, or customize their
//     per-class secret code and browse released standings without exposing peer identities.
import { useQuery } from '@tanstack/react-query';
import { Award, Check, Copy, Download, Eye, EyeOff, KeyRound, Pencil, RefreshCw, ShieldCheck, Trophy } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { toast } from '../../../components/toast.jsx';
import {
  Alert, Badge, Button, Card, CardHeader, cn, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, QueryState, Segmented, Select, StatCard, Switch, Table, Td, Th, Tr,
} from '../../../components/ui.jsx';
import { api } from '../../../lib/api.js';
import { formatDateTime, formatPercent, plural } from '../../../lib/format.js';
import { useAction } from '../../../lib/query.js';
import { useClass } from '../useClass.js';

function RankBadge({ rank }) {
  if (rank === 1) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-bold text-warn tabular-nums">
        <Trophy className="size-3.5" aria-hidden="true" />#1
      </span>
    );
  }
  if (rank === 2 || rank === 3) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand tabular-nums">
        <Award className="size-3.5" aria-hidden="true" />#{rank}
      </span>
    );
  }
  return <span className="font-semibold text-soft tabular-nums">#{rank}</span>;
}

// ── Teacher view ─────────────────────────────────────────────────────────────
export function TeacherRankingTab() {
  const { cls, base } = useClass();
  const { can } = useAuth();
  const [scope, setScope] = useState('');
  const [viewMode, setViewMode] = useState('named');
  const readOnly = cls.status === 'ARCHIVED';
  const invalidate = [['class', cls.id], ['class', cls.id, 'gradebook'], ['grades']];

  const query = useQuery({
    queryKey: ['class', cls.id, 'gradebook', 'ranking', scope || 'default'],
    queryFn: () => api.get(`${base}/gradebook/ranking`, scope ? { scope } : undefined),
  });

  const updateSettings = useAction((patch) => api.patch(`${base}/gradebook/ranking-settings`, patch), {
    invalidate,
    success: (_, patch) => (
      patch.gradeRankingEnabled !== undefined
        ? (patch.gradeRankingEnabled ? 'Anonymous class ranking enabled for students.' : 'Class ranking hidden from students.')
        : (patch.gradeRankingShowScores ? 'Grades are shown beside ranking codes.' : 'Only ranks and codes are shown to students.')
    ),
  });

  const exportRanking = async (format, anonymous) => {
    try {
      await api.download(
        `${base}/gradebook/ranking/export`,
        { format, anonymous: anonymous ? 'true' : 'false', ...(scope ? { scope } : {}) },
        `${anonymous ? 'ranking' : 'honor-roll'}.${format}`,
      );
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <QueryState query={query}>
      {(data) => {
        const activeScope = scope || data.activeScope || '';
        const rows = viewMode === 'named' ? data.namedEntries : data.anonymousEntries;
        const showScoreCols = viewMode === 'named' || data.showScores;

        return (
          <div className="space-y-5">
            <Card>
              <CardHeader
                icon={ShieldCheck}
                title="Grade release ranking"
                description="Control whether students see a class ranking alongside released grades. Student identities stay hidden behind private per-class codes."
                action={can('grades.export') && (
                  <Menu trigger={({ toggle, props }) => <Button variant="secondary" size="sm" icon={Download} onClick={toggle} {...props}>Export</Button>}>
                    <MenuItem onClick={() => exportRanking('pdf', true)}>Anonymous coded ranking (PDF)</MenuItem>
                    <MenuItem onClick={() => exportRanking('xlsx', true)}>Anonymous coded ranking (Excel)</MenuItem>
                    <MenuItem onClick={() => exportRanking('csv', true)}>Anonymous coded ranking (CSV)</MenuItem>
                    <MenuItem onClick={() => exportRanking('pdf', false)}>Teacher honor roll — named (PDF)</MenuItem>
                    <MenuItem onClick={() => exportRanking('xlsx', false)}>Teacher honor roll — named (Excel)</MenuItem>
                  </Menu>
                )}
              />
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-line bg-raised/40 p-4">
                  <Switch
                    checked={data.enabled}
                    disabled={readOnly || updateSettings.isPending}
                    onChange={(on) => updateSettings.mutate({ gradeRankingEnabled: on })}
                    label="Show anonymous ranking to students"
                    description="Only released grading periods (or finalized grades) are shown. Off by default."
                  />
                </div>
                <div className="rounded-xl border border-line bg-raised/40 p-4">
                  <Switch
                    checked={data.showScores}
                    disabled={readOnly || !data.enabled || updateSettings.isPending}
                    onChange={(on) => updateSettings.mutate({ gradeRankingShowScores: on })}
                    label="Show grades alongside ranking codes"
                    description="Off: classmates see only rank order and secret codes without each other's percentages."
                  />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <div className="flex flex-wrap items-center gap-3">
                  {data.scopes.length > 0 && (
                    <Select
                      aria-label="Ranking scope"
                      value={activeScope}
                      onChange={(e) => setScope(e.target.value)}
                      className="h-9 w-56 text-[13px]"
                    >
                      {data.scopes.map((s) => (
                        <option key={s.scope} value={s.scope}>
                          {s.name} {s.released ? '(Released)' : '(Not released)'}
                        </option>
                      ))}
                    </Select>
                  )}
                  <Badge tone={data.enabled ? (data.released ? 'ok' : 'warn') : 'neutral'} dot>
                    {!data.enabled
                      ? 'Disabled for students'
                      : data.released
                        ? `Visible for ${data.activeScopeName}`
                        : `Waiting for ${data.activeScopeName ?? 'grade'} release`}
                  </Badge>
                </div>

                <Segmented
                  label="Ranking view mode"
                  size="sm"
                  value={viewMode}
                  onChange={setViewMode}
                  options={[
                    { value: 'named', label: 'Teacher view (names)' },
                    { value: 'preview', label: 'Student preview (codes)' },
                  ]}
                />
              </div>
            </Card>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Ranked students" value={`${data.stats.totalRanked}/${data.stats.totalStudents}`} icon={Trophy} hint={data.stats.unrankedCount > 0 ? `${plural(data.stats.unrankedCount, 'unranked student')}` : 'Everyone ranked'} />
              <StatCard label="Class average" value={data.stats.averagePercent === null ? '—' : formatPercent(data.stats.averagePercent)} icon={Award} />
              <StatCard label="Top grade" value={data.stats.topPercent === null ? '—' : formatPercent(data.stats.topPercent)} tone="ok" icon={Trophy} />
              <StatCard label="Student visibility" value={data.enabled ? (data.released ? 'Live' : 'Armed') : 'Off'} tone={data.enabled ? (data.released ? 'ok' : 'warn') : 'neutral'} icon={data.enabled ? Eye : EyeOff} hint={data.enabled ? (data.showScores ? 'Codes + grades' : 'Codes only') : 'Hidden from students'} />
            </div>

            <Alert tone="info" title={viewMode === 'named' ? 'Teacher honor roll' : 'Anonymous student preview'}>
              {viewMode === 'named'
                ? 'Student names and student numbers are shown only to you and administrators. Secret student codes are kept strictly separate so classmate identities stay protected.'
                : 'This is the exact anonymous list students see when this grading period is released. Each student knows only their own secret code.'}
            </Alert>

            {rows.length === 0 ? (
              <Card>
                <EmptyState icon={Trophy} title="No ranked students yet" description="Once students have graded work in this period, standings appear here." />
              </Card>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Rank</Th>
                    {viewMode === 'named' ? (
                      <>
                        <Th>Student No.</Th>
                        <Th>Student</Th>
                      </>
                    ) : (
                      <Th>Secret Code</Th>
                    )}
                    {showScoreCols && (
                      <>
                        <Th className="text-right">Grade %</Th>
                        <Th className="text-center">Grade</Th>
                        <Th>Remark</Th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={viewMode === 'named' ? r.studentId : r.code}>
                      <Td><RankBadge rank={r.rank} /></Td>
                      {viewMode === 'named' ? (
                        <>
                          <Td className="font-mono text-xs text-soft">{r.studentNumber ?? '—'}</Td>
                          <Td className="font-medium text-ink">
                            {r.lastName}, {r.firstName}
                            {r.isOverridden && <Badge tone="warn" className="ml-2">Adjusted</Badge>}
                          </Td>
                        </>
                      ) : (
                        <Td><code className="rounded-md bg-raised px-2 py-0.5 font-mono text-xs font-semibold tracking-wider text-ink">{r.code}</code></Td>
                      )}
                      {showScoreCols && (
                        <>
                          <Td className="text-right font-semibold tabular-nums">{formatPercent(r.percent, 2)}</Td>
                          <Td className="text-center font-semibold tabular-nums">{r.label ?? '—'}</Td>
                          <Td className={cn('text-sm', r.isPassing === false ? 'text-bad font-medium' : 'text-soft')}>{r.remark ?? '—'}</Td>
                        </>
                      )}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        );
      }}
    </QueryState>
  );
}

// ── Student view ─────────────────────────────────────────────────────────────
export function StudentRankingCard({ ranking, onScopeChange, readOnly }) {
  const [revealCode, setRevealCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [codeModal, setCodeModal] = useState(false);

  if (!ranking) return null;

  const copyCode = async () => {
    if (!ranking.myCode) return;
    try {
      await navigator.clipboard.writeText(ranking.myCode);
      setCopied(true);
      toast.success('Secret ranking code copied.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy to clipboard.');
    }
  };

  return (
    <Card className="space-y-4">
      <CardHeader
        icon={Trophy}
        title="Class ranking"
        description="Your teacher enabled anonymous grade-release ranking using private per-class codes."
        action={<Badge tone="brand" icon={ShieldCheck}>Identity protected</Badge>}
      />

      {/* Private secret code strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-raised/60 p-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-faint">
            <KeyRound className="size-3.5" aria-hidden="true" />
            Your private class code
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-lg border border-line bg-surface px-3 py-1 font-mono text-base font-bold tracking-[0.18em] text-ink">
              {revealCode ? (ranking.myCode ?? '—') : '••••••••'}
            </code>
            <IconButton
              size="sm"
              variant="secondary"
              icon={revealCode ? EyeOff : Eye}
              label={revealCode ? 'Hide secret code' : 'Show secret code'}
              onClick={() => setRevealCode((v) => !v)}
            />
            <Button size="sm" variant="secondary" icon={copied ? Check : Copy} onClick={copyCode} disabled={!ranking.myCode}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-soft">
            Only you know this code. Classmates see your rank and code — never your name, e-mail, or student number.
          </p>
        </div>
        {!readOnly && (
          <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setCodeModal(true)}>
            Change code
          </Button>
        )}
      </div>

      {!ranking.released ? (
        <EmptyState
          compact
          icon={Trophy}
          title="No rankings released yet"
          description="Standings will appear here once your teacher publishes a grading period or submits final grades."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/25 bg-brand-soft/60 px-4 py-3">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <p className="text-xs font-medium text-soft">Your standing ({ranking.activeScopeName})</p>
                <p className="text-lg font-bold text-ink tabular-nums">
                  {ranking.myRank !== null ? `Rank #${ranking.myRank} of ${ranking.totalRanked}` : 'Unranked yet'}
                </p>
              </div>
              {ranking.myPercent !== null && (
                <div className="border-l border-line pl-4">
                  <p className="text-xs font-medium text-soft">Your grade</p>
                  <p className="text-lg font-bold text-ink tabular-nums">
                    {ranking.myLabel ?? formatPercent(ranking.myPercent, 2)}
                    {ranking.myLabel && <span className="ml-1.5 text-sm font-medium text-soft">{formatPercent(ranking.myPercent, 2)}</span>}
                  </p>
                </div>
              )}
              {ranking.showScores && ranking.stats.averagePercent !== null && (
                <div className="border-l border-line pl-4">
                  <p className="text-xs font-medium text-soft">Class average</p>
                  <p className="text-sm font-semibold text-ink tabular-nums">
                    {formatPercent(ranking.stats.averagePercent)}
                    {ranking.stats.topPercent !== null && <span className="ml-2 text-xs font-normal text-soft">· Top {formatPercent(ranking.stats.topPercent)}</span>}
                  </p>
                </div>
              )}
            </div>

            {ranking.scopes.length > 1 && (
              <Select
                aria-label="Released grading period"
                value={ranking.activeScope ?? ''}
                onChange={(e) => onScopeChange?.(e.target.value)}
                className="h-9 w-48 text-[13px]"
              >
                {ranking.scopes.map((s) => (
                  <option key={s.scope} value={s.scope}>{s.name}</option>
                ))}
              </Select>
            )}
          </div>

          {ranking.entries.length === 0 ? (
            <EmptyState compact icon={Trophy} title="No graded scores in this period yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Rank</Th>
                  <Th>Student Code</Th>
                  {ranking.showScores && (
                    <>
                      <Th className="text-right">Grade %</Th>
                      <Th className="text-center">Grade</Th>
                      <Th>Remark</Th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {ranking.entries.map((entry) => (
                  <Tr key={entry.code} className={entry.isSelf ? 'bg-brand-soft/45 font-medium' : undefined}>
                    <Td><RankBadge rank={entry.rank} /></Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <code className="rounded-md bg-raised px-2 py-0.5 font-mono text-xs font-semibold tracking-wider text-ink">
                          {entry.code}
                        </code>
                        {entry.isSelf && <Badge tone="brand">You</Badge>}
                      </div>
                    </Td>
                    {ranking.showScores && (
                      <>
                        <Td className="text-right font-semibold tabular-nums">{formatPercent(entry.percent, 2)}</Td>
                        <Td className="text-center font-semibold tabular-nums">{entry.label ?? '—'}</Td>
                        <Td className={cn('text-sm', entry.isPassing === false ? 'text-bad font-medium' : 'text-soft')}>{entry.remark ?? '—'}</Td>
                      </>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-faint">
            <span>
              {ranking.unrankedCount > 0
                ? `${plural(ranking.unrankedCount, 'classmate')} with no graded work in this period yet ${ranking.unrankedCount === 1 ? 'is' : 'are'} not listed.`
                : `Showing all ${plural(ranking.totalRanked, 'ranked student')}.`}
            </span>
            {ranking.releasedAt && <span>Released {formatDateTime(ranking.releasedAt)}</span>}
          </div>
        </>
      )}

      {codeModal && <CodeDialog currentCode={ranking.myCode} onClose={() => setCodeModal(false)} />}
    </Card>
  );
}

function CodeDialog({ currentCode, onClose }) {
  const { cls, base } = useClass();
  const [custom, setCustom] = useState(currentCode ?? '');
  const [error, setError] = useState(null);
  const invalidate = [['class', cls.id, 'gradebook'], ['grades']];

  const regenerate = useAction(() => api.post(`${base}/gradebook/ranking-code/regenerate`), {
    invalidate,
    success: 'Generated a new private code.',
    onSuccess: onClose,
  });

  const saveCustom = useAction(() => api.put(`${base}/gradebook/ranking-code`, { code: custom.trim() }), {
    invalidate,
    success: 'Your private code was updated.',
    onSuccess: onClose,
    onError: (err) => {
      setError(err.fields?.code ?? err.message);
      return true;
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Change your private ranking code"
      description="This code is unique to this class. Classmates only see your code and rank."
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <div className="space-y-5">
        <div className="rounded-xl border border-line bg-raised/50 p-4">
          <p className="text-sm font-medium text-ink">Generate a random anonymous code</p>
          <p className="mt-0.5 text-xs text-soft">Recommended — creates a fresh 8-character code unrelated to your identity.</p>
          <Button
            size="sm"
            variant="secondary"
            icon={RefreshCw}
            loading={regenerate.isPending}
            onClick={() => regenerate.mutate()}
            className="mt-3"
          >
            Generate random code
          </Button>
        </div>

        <form
          className="space-y-3 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveCustom.mutate();
          }}
        >
          <Field
            label="Or choose a custom secret code"
            error={error}
            hint="6–16 letters and numbers. Never include your name, initials, e-mail, or student number."
          >
            <Input
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value.toUpperCase());
                setError(null);
              }}
              maxLength={20}
              placeholder="e.g. PHOENIX42"
              className="font-mono uppercase tracking-wider"
            />
          </Field>
          <Button type="submit" size="sm" loading={saveCustom.isPending} disabled={custom.trim().length < 6}>
            Save custom code
          </Button>
        </form>
      </div>
    </Modal>
  );
}
