// Hand-rolled SVG charts (no library): one line chart and one column chart, sized to their container.
// Follows the dataviz rules: single series in the role colour (no legend; the card title names it), 2px line,
// ≥8px dots with a surface ring, columns ≤24px with a 4px rounded data end and a square baseline, hairline solid
// grid, text in text tokens only. Hover/drag/keyboard snap to the nearest point and show it in a fixed readout row
// above the plot (no floating tooltip to chase on a phone). Values are always reachable without hover too: the
// readout defaults to the latest point and every screen keeps a list/table of the same numbers.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

export interface LinePoint { t: number; v: number; approx?: boolean; caption?: string }
export interface Bar { key: string; label: string; v: number; caption?: string; partial?: boolean }

const PAD = { l: 44, r: 12, t: 10, b: 24 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el); setW(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Clean axis ticks (1 / 2 / 2.5 / 5 × 10ⁿ steps) covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 3, minStep = 0) {
  if (!(hi > lo)) { const d = Math.abs(hi) * 0.1 || 1; lo -= d; hi += d; }
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw * 0.999)!);
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, lo: a, hi: b };
}

/** Axis numbers: in full under 10,000, compact above (12K). */
export const fmtAxis = (v: number) => (Math.abs(v) >= 10000 ? `${Math.round(v / 100) / 10}K`.replace('.0K', 'K') : v.toLocaleString(undefined, { maximumFractionDigits: 1 }));

const dayFmt = (t: number, span: number) => new Date(t).toLocaleDateString(undefined, span > 300 * 864e5 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });

function useSelection(n: number, initial = n - 1) {
  const [sel, setSel] = useState<number | null>(null);
  const i = sel == null || sel >= n ? Math.max(0, Math.min(n - 1, initial)) : sel;
  const onKey = (e: KeyboardEvent) => {
    const next = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next == null) return;
    e.preventDefault(); setSel(Math.max(0, Math.min(n - 1, next)));
  };
  return { i, setSel, onKey };
}

function Readout({ value, sub }: { value: ReactNode; sub: ReactNode }) {
  return (
    <div className="chart-readout" aria-live="polite">
      <b>{value}</b><span>{sub}</span>
    </div>
  );
}

/** Time-proportional line chart. `fmt` formats values (already in the display unit). */
export function LineChart({ points, fmt, label, height = 150, zeroBased = false, integer = false }: {
  points: LinePoint[]; fmt: (v: number) => string; label: string; height?: number; zeroBased?: boolean; integer?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { i, setSel, onKey } = useSelection(points.length);
  if (!points.length) return <div className="chart-empty">No data in this range</div>;
  const ts = points.map((p) => p.t), vs = points.map((p) => p.v);
  let t0 = Math.min(...ts), t1 = Math.max(...ts);
  if (t1 - t0 < 864e5) { t0 -= 3 * 864e5; t1 += 3 * 864e5; } // a single day: centre it
  const vMin = Math.min(...vs), vMax = Math.max(...vs);
  const pad = (vMax - vMin) * 0.15 || Math.abs(vMax) * 0.08 || 1;
  const y = niceTicks(zeroBased ? 0 : Math.max(0, vMin - pad), vMax + pad, 3, integer ? 1 : 0);
  const pw = w - PAD.l - PAD.r, ph = height - PAD.t - PAD.b;
  const X = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * pw;
  const Y = (v: number) => PAD.t + (1 - (v - y.lo) / (y.hi - y.lo)) * ph;
  const xy = points.map((p) => [X(p.t), Y(p.v)] as const);
  const line = xy.map(([a, b], k) => `${k ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
  const area = `${line}L${xy.at(-1)![0].toFixed(1)},${PAD.t + ph}L${xy[0][0].toFixed(1)},${PAD.t + ph}Z`;
  const span = t1 - t0;
  const nx = Math.max(2, Math.min(4, Math.floor(pw / 80)));
  const xt = Array.from({ length: nx }, (_, k) => t0 + (span * k) / (nx - 1));
  const dots = points.length <= 40;
  const pick = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const px = e.clientX - r.left;
    let best = 0; xy.forEach(([a], k) => { if (Math.abs(a - px) < Math.abs(xy[best][0] - px)) best = k; });
    setSel(best);
  };
  const p = points[i];
  return (
    <div ref={ref} className="chart">
      <Readout value={<>{p.approx ? '≈' : ''}{fmt(p.v)}</>} sub={<>{new Date(p.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: span > 300 * 864e5 ? 'numeric' : undefined })}{p.caption ? ` · ${p.caption}` : ''}</>} />
      <svg width={w} height={height} role="group" tabIndex={0} aria-label={`${label}. ${points.length} points. Use left and right arrow keys to step through them.`}
        onPointerMove={pick} onPointerDown={pick} onKeyDown={onKey} className="chart-svg">
        {y.ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={Y(v)} y2={Y(v)} className="chart-gridline" />
            <text x={PAD.l - 8} y={Y(v)} dy="0.32em" textAnchor="end" className="chart-tick">{fmtAxis(v)}</text>
          </g>
        ))}
        {xt.map((t, k) => (
          <text key={k} x={X(t)} y={height - 6} textAnchor={k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle'} className="chart-tick">{dayFmt(t, span)}</text>
        ))}
        <path d={area} className="chart-area" />
        <path d={line} className="chart-line" />
        <line x1={xy[i][0]} x2={xy[i][0]} y1={PAD.t} y2={PAD.t + ph} className="chart-cross" />
        {(dots ? points : [points[i]]).map((pt) => {
          const k = dots ? points.indexOf(pt) : i;
          return <circle key={k} cx={xy[k][0]} cy={xy[k][1]} r={k === i ? 5.5 : 4} className={'chart-dot' + (pt.approx ? ' approx' : '') + (k === i ? ' on' : '')} />;
        })}
      </svg>
    </div>
  );
}

/** Column chart from a zero baseline (weekly totals). `partial` columns (the week in progress) are drawn lighter. */
export function BarChart({ bars, fmt, label, height = 150, integer = false }: {
  bars: Bar[]; fmt: (v: number) => string; label: string; height?: number; integer?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  // start on the latest column with data (an empty week in progress says little)
  let last = bars.length - 1; while (last > 0 && bars[last].v === 0) last--;
  const { i, setSel, onKey } = useSelection(bars.length, last);
  if (!bars.length) return <div className="chart-empty">No data</div>;
  const y = niceTicks(0, Math.max(...bars.map((b) => b.v), 1), 3, integer ? 1 : 0);
  const pw = w - PAD.l - PAD.r, ph = height - PAD.t - PAD.b;
  const band = pw / bars.length;
  const bw = Math.min(24, Math.max(4, band * 0.62));
  const Y = (v: number) => PAD.t + (1 - v / y.hi) * ph;
  const every = Math.max(1, Math.ceil(44 / band));
  const col = (k: number, v: number) => {
    const x = PAD.l + band * k + (band - bw) / 2, top = Y(v), base = PAD.t + ph, r = Math.min(4, bw / 2, base - top);
    if (base - top < 0.5) return '';
    return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z`;
  };
  const b = bars[i];
  // one handler on the whole plot: a finger dragging across thin columns keeps updating (pointer capture would pin the first bar)
  const pick = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    setSel(Math.max(0, Math.min(bars.length - 1, Math.floor((e.clientX - r.left - PAD.l) / band))));
  };
  return (
    <div ref={ref} className="chart">
      <Readout value={fmt(b.v)} sub={<>{b.caption ?? b.label}{b.partial ? ' · so far' : ''}</>} />
      <svg width={w} height={height} role="group" tabIndex={0} aria-label={`${label}. ${bars.length} columns. Use left and right arrow keys to step through them.`}
        onKeyDown={onKey} onPointerDown={pick} onPointerMove={pick} className="chart-svg">
        {y.ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={Y(v)} y2={Y(v)} className={v === 0 ? 'chart-base' : 'chart-gridline'} />
            <text x={PAD.l - 8} y={Y(v)} dy="0.32em" textAnchor="end" className="chart-tick">{fmtAxis(v)}</text>
          </g>
        ))}
        {bars.map((bar, k) => (
          <g key={bar.key}>
            <path d={col(k, bar.v)} className={'chart-col' + (bar.partial ? ' partial' : '') + (k === i ? ' on' : '')} />
            {(k % every === (bars.length - 1) % every) && (
              <text x={PAD.l + band * k + band / 2} y={height - 6} textAnchor="middle" className={'chart-tick' + (k === i ? ' on' : '')}>{bar.label}</text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
