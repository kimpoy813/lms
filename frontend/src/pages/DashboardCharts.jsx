// Charts are in their own chunk so the charting library is only downloaded when needed.
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const dayLabel = (key) => new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T00:00:00Z`));

export function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <p className="font-semibold text-ink">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="mt-0.5 flex items-center gap-1.5 text-soft">
          <span className="size-2 rounded-full" style={{ background: p.color ?? p.fill }} aria-hidden="true" />
          {p.name}: <span className="font-semibold text-ink">{formatter ? formatter(p.value) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

export default function AdminCharts({ signIns }) {
  const rows = signIns.map((d) => ({ day: dayLabel(d.date), users: d.users }));
  const total = rows.reduce((a, r) => a + r.users, 0);
  return (
    <figure>
      <div className="h-56" role="img" aria-label={`Sign-ins per day for the last 14 days. ${total} in total.`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
            <defs>
              <linearGradient id="signins" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand-fill)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--brand-fill)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: 'var(--faint)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--line)' }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis allowDecimals={false} tick={{ fill: 'var(--faint)', fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--line-strong)' }} />
            <Area type="monotone" dataKey="users" name="Users" stroke="var(--brand-fill)" strokeWidth={2} fill="url(#signins)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
