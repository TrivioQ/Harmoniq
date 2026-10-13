// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * INST-27: one bar per day, relative to the busiest day. Server-rendered SVG, no JS; the
 * total and the latest day are in the label for screen readers.
 */
export function TrendBars({
  values,
  label,
  className = 'text-indigo-500',
}: {
  values: number[];
  label: string;
  className?: string;
}) {
  const max = Math.max(1, ...values);
  const bar = 6;
  const gap = 2;
  const height = 40;
  const width = values.length * (bar + gap);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className={`block ${className}`}
    >
      {values.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * height) : 1;
        return (
          <rect
            key={i}
            x={i * (bar + gap)}
            y={height - h}
            width={bar}
            height={h}
            rx={1}
            fill="currentColor"
            opacity={v ? 1 : 0.25}
          />
        );
      })}
    </svg>
  );
}
