/**
 * Daily net sales as thin bars (one series, so no legend; the card title names it). Each bar has a
 * native tooltip with its day, value and order count, a hit area taller than the mark, and the
 * same numbers are available as a table for screen readers and keyboard users.
 */
export function SalesChart({ days }: { days: { day: string; value: number; label: string; orders: number }[] }) {
  if (days.length === 0) return <p className="text-sm text-muted-foreground">No sales in this range.</p>;
  const W = 720;
  const H = 200;
  const pad = 4;
  const max = Math.max(1, ...days.map((d) => d.value));
  const slot = (W - pad * 2) / days.length;
  const bar = Math.max(2, Math.min(24, slot - 2));
  const peak = days.reduce((a, b) => (b.value > a.value ? b : a));
  return (
    <figure className="grid gap-2">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="h-auto w-full" role="img" aria-label={`Net sales per day; highest ${peak.label} on ${peak.day}`}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--color-border)" strokeWidth={1} />
        {days.map((d, i) => {
          const h = d.value > 0 ? Math.max(2, (d.value / max) * (H - 8)) : 0;
          const x = pad + i * slot + (slot - bar) / 2;
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${d.label} · ${d.orders} order${d.orders === 1 ? "" : "s"}`}</title>
              <rect x={pad + i * slot} y={0} width={slot} height={H} fill="transparent" />
              {h > 0 ? <path d={`M${x},${H} v${-(h - 4)} q0,-4 4,-4 h${bar - 8} q4,0 4,4 v${h - 4} z`} fill="var(--color-primary)" /> : null}
            </g>
          );
        })}
        <text x={0} y={H + 14} fontSize={11} fill="var(--color-muted-foreground)">
          {days[0]!.day}
        </text>
        <text x={W} y={H + 14} fontSize={11} textAnchor="end" fill="var(--color-muted-foreground)">
          {days.at(-1)!.day}
        </text>
      </svg>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show as table</summary>
        <table className="mt-2 w-full text-left">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 font-medium">Orders</th>
              <th className="py-1 text-right font-medium">Net sales</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day} className="border-t border-border">
                <td className="py-1">{d.day}</td>
                <td className="py-1 tabular-nums">{d.orders}</td>
                <td className="py-1 text-right tabular-nums">{d.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
