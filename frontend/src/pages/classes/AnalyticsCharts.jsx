// Charts for class analytics (kept in the same lazy chunk as the charting library).
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardHeader } from '../../components/ui.jsx';
import { ChartTooltip } from '../DashboardCharts.jsx';

const axis = { fill: 'var(--faint)', fontSize: 11 };
const short = (key) => new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T00:00:00Z`));

export default function AnalyticsCharts({ data }) {
  const { gradeDistribution, attendanceTrend, thresholds } = data;
  // Lowest band on the left, as people read a distribution.
  const bands = [...gradeDistribution].reverse();
  const passingFrom = thresholds.gradeBelow;
  const trend = attendanceTrend.map((m) => ({ ...m, day: short(m.date) }));
  const graded = bands.reduce((a, b) => a + b.count, 0);
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Grade distribution" description="Students by running grade" />
        {graded === 0 ? <p className="py-16 text-center text-sm text-faint">No grades yet.</p> : (
          <div className="h-56" role="img" aria-label={`Grade distribution: ${bands.map((b) => `${b.count} in ${b.label}`).join(', ')}.`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bands} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: 'var(--line)' }} />
                <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--raised)' }} />
                <Bar dataKey="count" name="Students" radius={[6, 6, 0, 0]} maxBarSize={56}>
                  {bands.map((b) => <Cell key={b.label} fill={Number(b.label.split('–')[0]) >= passingFrom ? 'var(--ok)' : 'var(--bad)'} fillOpacity={0.85} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-2 flex items-center gap-4 text-xs text-faint"><span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-ok" />{passingFrom}% and above</span><span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-bad" />below {passingFrom}%</span></p>
      </Card>
      <Card>
        <CardHeader title="Attendance by meeting" description="Share of students present or late" />
        {trend.length === 0 ? <p className="py-16 text-center text-sm text-faint">No meetings recorded yet.</p> : (
          <div className="h-56" role="img" aria-label={`Attendance rate per meeting, from ${trend[0].day} to ${trend.at(-1).day}.`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="day" tick={axis} tickLine={false} axisLine={{ stroke: 'var(--line)' }} minTickGap={20} />
                <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={axis} tickLine={false} axisLine={false} unit="%" />
                <ReferenceLine y={thresholds.attendanceBelow} stroke="var(--warn)" strokeDasharray="4 4" />
                <Tooltip content={<ChartTooltip formatter={(v) => `${v}%`} />} cursor={{ stroke: 'var(--line-strong)' }} />
                <Line type="monotone" dataKey="rate" name="Attendance" stroke="var(--brand-fill)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--brand-fill)' }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-2 flex items-center gap-1.5 text-xs text-faint"><span className="h-0 w-4 border-t-2 border-dashed border-warn" />{thresholds.attendanceBelow}% — the level below which a student is flagged</p>
      </Card>
    </div>
  );
}
