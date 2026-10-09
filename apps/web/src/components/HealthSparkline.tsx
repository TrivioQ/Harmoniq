import type { HourlyHealth } from '@/lib/workspaceApi';

/**
 * HLT-04: one bar per hour for the last `hours` hours. Height is the load count (relative
 * to the busiest hour), the red part the failed share. Server-rendered SVG, no JS.
 */
export function HealthSparkline({
  points,
  since,
  hours = 24,
  label,
}: {
  points: HourlyHealth[];
  since: string;
  hours?: number;
  label: string;
}) {
  const start = new Date(since);
  start.setUTCMinutes(0, 0, 0);
  const byHour = new Map(points.map((p) => [new Date(p.hour).getTime(), p]));
  const slots = Array.from({ length: hours + 1 }, (_, i) =>
    byHour.get(start.getTime() + i * 3_600_000)
  );
  const max = Math.max(1, ...slots.map((p) => p?.sampleCount ?? 0));
  const width = slots.length * 4;
  const height = 20;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="inline-block align-middle"
    >
      {slots.map((p, i) => {
        if (!p?.sampleCount) {
          return (
            <rect key={i} x={i * 4} y={height - 1} width={3} height={1} className="fill-muted" />
          );
        }
        const h = Math.max(2, (p.sampleCount / max) * height);
        const failed = (p.errorCount / p.sampleCount) * h;
        return (
          <g key={i}>
            <title>{`${new Date(p.hour).toISOString().slice(11, 16)} UTC: ${p.sampleCount} loads, ${p.errorCount} failed`}</title>
            <rect
              x={i * 4}
              y={height - h}
              width={3}
              height={h - failed}
              className="fill-green-500"
            />
            {failed > 0 && (
              <rect
                x={i * 4}
                y={height - failed}
                width={3}
                height={failed}
                className="fill-red-500"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
