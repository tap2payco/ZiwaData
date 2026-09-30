import { useEffect, useRef, useState } from 'react';
import { DAY_MS, dayKeyToMs, dayKey, formatDayMonth, startOfDay } from '../core/format';
import { useLang, useT } from '../i18n';

function useWidth(fallback = 320) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export interface TrendPoint {
  ts: number;
  v: number;
  manual: boolean;
}
export interface ChartLine {
  value: number;
  label: string;
  tone: 'watch' | 'critical';
}
/**
 * Hand-drawn SVG trend. Drawn at the real pixel width so text never scales below 13px.
 * Gaps (no readings for a long stretch) are shaded and the line is broken, never bridged.
 * Manual readings are hollow circles; the last reading is labelled.
 */
export function TrendChart({ points, now, days = 7, lines, unit, ariaLabel, height = 230 }: { points: TrendPoint[]; now: number; days?: number; lines: ChartLine[]; unit: string; ariaLabel: string; height?: number }) {
  const lang = useLang();
  const t = useT();
  const [ref, W] = useWidth();
  const from = now - days * DAY_MS;
  const pts = points.filter((p) => p.ts >= from && p.ts <= now).sort((a, b) => a.ts - b.ts);
  const L = 34, R = 14, T = 16, B = 30;
  const plotW = W - L - R;
  const plotH = height - T - B;
  const vals = pts.map((p) => p.v).concat(lines.map((l) => l.value));
  const yMin = Math.floor(Math.min(...vals, 3) / 2) * 2;
  const yMax = Math.ceil(Math.max(...vals, 8) / 2) * 2;
  const x = (ts: number) => L + ((ts - from) / (now - from)) * plotW;
  const y = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  const gaps: number[] = pts.slice(1).map((p, i) => p.ts - pts[i]!.ts).sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 6 * 3600_000;
  const gapLimit = Math.max(12 * 3600_000, median * 2.5);
  const segs: TrendPoint[][] = [];
  const bands: [number, number][] = [];
  pts.forEach((p, i) => {
    if (i === 0 || p.ts - pts[i - 1]!.ts > gapLimit) {
      if (i > 0) bands.push([pts[i - 1]!.ts, p.ts]);
      segs.push([p]);
    } else segs[segs.length - 1]!.push(p);
  });
  if (pts.length && now - pts[pts.length - 1]!.ts > gapLimit) bands.push([pts[pts.length - 1]!.ts, now]);

  // One tick per East Africa midnight. On narrow screens show every second day.
  const ticks: number[] = [];
  for (let d = dayKeyToMs(dayKey(from)) + DAY_MS; d < now; d += DAY_MS) ticks.push(d);
  const every = plotW / ticks.length < 52 ? 2 : 1;
  const last = pts[pts.length - 1];
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax; v += 2) yTicks.push(v);

  return (
    <div ref={ref} className="chart-wrap">
      <svg className="bw-chart" width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
        {yTicks.map((v) => (
          <g key={v}>
            <line className="bw-chart__grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text className="bw-chart__axis" x={L - 6} y={y(v) + 4} textAnchor="end">{v}</text>
          </g>
        ))}
        {bands.map(([a, b], i) => (
          <g key={i}>
            <rect className="bw-chart__gap" x={x(a)} y={T} width={Math.max(0, x(b) - x(a))} height={plotH} />
            {x(b) - x(a) > 86 && (
              <text className="bw-chart__axis" x={(x(a) + x(b)) / 2} y={T + 16} textAnchor="middle">{t('chart.noReadings')}</text>
            )}
          </g>
        ))}
        {ticks.map((d, i) => (
          <g key={d}>
            <line className="bw-chart__grid" x1={x(d)} x2={x(d)} y1={T + plotH} y2={T + plotH + 4} />
            {i % every === (every === 2 ? 1 : 0) && <text className="bw-chart__axis" x={x(d)} y={height - 8} textAnchor="middle">{formatDayMonth(d + 3600_000, lang)}</text>}
          </g>
        ))}
        {lines.map((l) => (
          <g key={l.label}>
            <line className={`bw-chart__threshold bw-chart__threshold--${l.tone === 'watch' ? 'watch' : 'act'}`} x1={L} x2={W - R} y1={y(l.value)} y2={y(l.value)} />
            <text className={`bw-chart__label${l.tone === 'watch' ? ' bw-chart__label--watch' : ''}`} x={L + 6} y={y(l.value) - 5}>{l.label}</text>
          </g>
        ))}
        {segs.map((s, i) => s.length > 1 && <polyline key={i} className="bw-chart__line" points={s.map((p) => `${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')} />)}
        {pts.filter((p) => p.manual).map((p) => <circle key={p.ts} className="bw-chart__dot" cx={x(p.ts)} cy={y(p.v)} r={4.5} />)}
        {last && (
          <g>
            <circle cx={x(last.ts)} cy={y(last.v)} r={6} fill="var(--chart-1)" stroke="var(--surface-card)" strokeWidth={2} />
            <text className="bw-chart__series-label" x={Math.min(x(last.ts), W - R - 2)} y={y(last.v) - 12} textAnchor="end">{last.v.toFixed(1)} {unit}</text>
          </g>
        )}
        {!pts.length && <text className="bw-chart__axis" x={W / 2} y={height / 2} textAnchor="middle">{t('status.none')}</text>}
      </svg>
    </div>
  );
}
export { startOfDay };

export function ScoreRing({ score, size = 176, showOf = true, label }: { score: number; size?: number; showOf?: boolean; label: string }) {
  const r = 76, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg className="bw-ring" style={{ width: size, height: size }} viewBox="0 0 176 176" role="img" aria-label={label}>
      <circle className="bw-ring__track" cx="88" cy="88" r={r} />
      <circle className="bw-ring__fill" cx="88" cy="88" r={r} strokeDasharray={`${pct * c} ${c}`} transform="rotate(-90 88 88)" />
      <text className="bw-ring__num" x="88" y={showOf ? 96 : 104} style={{ fontSize: 56 }}>{score}</text>
      {showOf && <text className="bw-ring__of" x="88" y="122">/ 100</text>}
    </svg>
  );
}
