// The assistant's display cards: chart (line / area / bar / scatter with bands + markers + scrub readout), table,
// stat tiles. Dataviz rules: one y axis, categorical hues in fixed order (validated for the dark surface: blue, orange,
// purple, green), 2px smooth lines, ≥8px dots with a surface ring, hairline grid, text in text tokens, a fixed readout
// row instead of a floating tooltip (tap / drag to scrub), legend only for ≥2 series, every value also in the readout.
import { motion } from 'motion/react';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtAxis, niceTicks } from './Charts';
import { TimeChart, type TPoint } from './TimeChart';
import { keyToDate } from '../lib/nutrition';
import type { Display } from '../lib/agent/types';

const HUES = ['#3d8bff', '#cf7200', '#bf5af2', '#20a04a']; // validated: dataviz validate_palette --mode dark --surface #1c1c1e
const TONE: Record<string, string> = { good: 'rgba(48, 209, 88, 0.16)', bad: 'rgba(255, 69, 58, 0.16)', neutral: 'rgba(235, 235, 245, 0.08)' };
const TONE_TEXT: Record<string, string> = { good: '#7fe39b', bad: '#ff8a80', neutral: 'rgba(235, 235, 245, 0.72)' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 864e5;
const PAD = { l: 40, r: 10, t: 8, b: 22 };
const appear = { initial: { opacity: 0, y: 10, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { type: 'spring', bounce: 0, duration: 0.35 } } as const;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, Math.round(e.contentRect.width))));
    ro.observe(el); setW(Math.max(220, Math.round(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Monotone cubic (Fritsch–Carlson): smooth, never overshoots the data. */
function smoothPath(p: [number, number][]) {
  if (p.length < 3) return p.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
  const n = p.length, dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = dx[i] ? (p[i + 1][1] - p[i][1]) / dx[i] : 0; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${p[i][0] + h},${p[i][1] + h * t[i]} ${p[i + 1][0] - h},${p[i + 1][1] - h * t[i + 1]} ${p[i + 1][0]},${p[i + 1][1]}`;
  }
  return d;
}

const fmtVal = (v: number, unit?: string) => `${v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 10 ? 1 : 0 })}${unit ? ` ${unit}` : ''}`;
const fmtDay = (key: string, long = false) => (DATE.test(key) ? keyToDate(key).toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }) : key);

/** A single dated series (the usual agent chart: one lift / bodyweight over time, with bands and markers) uses the shared
 *  TimeChart, so it gets range chips, maximize, pan/zoom and a values list. Several series or category x-axes keep the
 *  multi-series card below (no maximize yet). */
export function ChartCard({ d }: { d: Extract<Display, { type: 'chart' }> }) {
  const single = d.series.length === 1 && d.series[0].points.length > 0 && d.series[0].points.every((p) => DATE.test(p.x));
  return single ? <SingleSeriesCard d={d} /> : <MultiChartCard d={d} />;
}

function SingleSeriesCard({ d }: { d: Extract<Display, { type: 'chart' }> }) {
  const model = useMemo(() => {
    const ms = (k: string) => keyToDate(k).getTime();
    const points: TPoint[] = [...d.series[0].points].sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0)).map((p, i) => ({ t: ms(p.x), v: p.y, key: `${p.x}-${i}` }));
    // bar width = the smallest spacing between points (daily, weekly…), at least a day
    let period = 7 * DAY;
    for (let i = 1; i < points.length; i++) { const g = points[i].t - points[i - 1].t; if (g > 0 && g < period) period = Math.max(DAY, g); }
    const bands = d.bands.filter((b) => DATE.test(b.from)).map((b) => ({ from: ms(b.from), to: b.to && DATE.test(b.to) ? ms(b.to) + DAY - 1 : Date.now(), label: b.label, tone: b.tone }));
    const markers = d.markers.filter((m) => DATE.test(m.x)).map((m) => ({ t: ms(m.x), label: m.label }));
    return { points, period, bands, markers };
  }, [d]);
  const name = d.series[0].name;
  return (
    <motion.div className="dcard chart-dcard" {...appear}>
      <TimeChart bare anchorToday={false} className="tc-agent" title={d.title} note={name && name !== d.title ? name : d.note} points={model.points} period={model.period}
        kind={d.kind === 'bar' ? 'bar' : d.kind === 'scatter' ? 'dots' : 'line'} area={d.kind === 'area'} zeroBased={d.kind === 'bar'}
        fmt={(v) => fmtVal(v, d.unit)} bands={model.bands} markers={model.markers} barDateLabel={model.period >= 7 * DAY ? 'Week of' : ''} />
    </motion.div>
  );
}

function MultiChartCard({ d }: { d: Extract<Display, { type: 'chart' }> }) {
  const [ref, w] = useWidth();
  const H = 200;
  const dates = d.series.every((s) => s.points.every((p) => DATE.test(p.x)));
  const bar = d.kind === 'bar';
  const model = useMemo(() => {
    const all = d.series.flatMap((s) => s.points);
    const ys = all.map((p) => p.y);
    // x scale: time for dates (bands/markers placed by date), else categories in first-seen order
    const cats = dates ? [] : [...new Set(all.map((p) => p.x))];
    const ts = dates ? all.map((p) => keyToDate(p.x).getTime()) : [];
    const extra = dates ? [...d.bands.flatMap((b) => [b.from, b.to ?? '']), ...d.markers.map((m) => m.x)].filter((x) => DATE.test(x)).map((x) => keyToDate(x).getTime()) : [];
    let x0 = dates ? Math.min(...ts) : 0, x1 = dates ? Math.max(...ts) : Math.max(1, cats.length - 1);
    if (dates) { // include bands/markers that start just before/after the data, but never stretch more than 20%
      const span = Math.max(DAY, x1 - x0);
      x0 = Math.max(x0 - span * 0.2, Math.min(x0, ...extra)); x1 = Math.min(x1 + span * 0.2, Math.max(x1, ...extra));
      if (x1 === x0) { x0 -= DAY; x1 += DAY; }
    }
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const yt = niceTicks(bar ? Math.min(0, lo) : lo - (hi - lo) * 0.08, bar ? Math.max(0, hi) : hi + (hi - lo) * 0.08, 3);
    return { cats, x0, x1, yt };
  }, [d, dates, bar]);
  const iw = w - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const catW = bar && !dates ? iw / Math.max(1, model.cats.length) : 0;
  const X = (x: string) => {
    if (dates) return PAD.l + ((keyToDate(x).getTime() - model.x0) / (model.x1 - model.x0 || 1)) * iw;
    const i = model.cats.indexOf(x);
    return bar ? PAD.l + catW * (i + 0.5) : PAD.l + (model.cats.length > 1 ? (i / (model.cats.length - 1)) * iw : iw / 2);
  };
  const Y = (v: number) => PAD.t + (1 - (v - model.yt.lo) / (model.yt.hi - model.yt.lo || 1)) * ih;

  // scrub: every distinct x across series, nearest to the pointer
  const xs = useMemo(() => { const u = [...new Set(d.series.flatMap((s) => s.points.map((p) => p.x)))]; return dates ? u.sort() : u; }, [d, dates]);
  const [sel, setSel] = useState<number | null>(null);
  const si = sel == null ? xs.length - 1 : Math.min(sel, xs.length - 1);
  const pick = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect(); const px = ((clientX - r.left) / r.width) * w;
    let best = 0, bd = Infinity; xs.forEach((x, i) => { const dd = Math.abs(X(x) - px); if (dd < bd) { bd = dd; best = i; } }); setSel(best);
  };
  const onPointer = (e: PointerEvent<SVGSVGElement>) => { if (e.type === 'pointerdown' || e.buttons || e.pointerType === 'mouse') pick(e.clientX, e.currentTarget); };
  const onKey = (e: KeyboardEvent) => {
    const n = e.key === 'ArrowLeft' ? si - 1 : e.key === 'ArrowRight' ? si + 1 : null;
    if (n == null) return; e.preventDefault(); setSel(Math.max(0, Math.min(xs.length - 1, n)));
  };
  const selX = xs[si];
  const vals = d.series.map((s, k) => ({ k, name: s.name, p: s.points.find((p) => p.x === selX) }));
  const inBands = d.bands.filter((b) => selX && DATE.test(selX) && b.from <= selX && (!b.to || b.to >= selX));
  const atMarker = d.markers.filter((m) => m.x === selX);

  // bands clamped to the plot; labels on alternating rows when they would collide
  const bandRects = d.bands.map((b) => {
    const a = Math.max(PAD.l, X(b.from)), z = Math.min(PAD.l + iw, b.to ? X(b.to) : PAD.l + iw);
    return { b, a, z: Math.max(z, a + 2) };
  }).filter((r) => r.z > PAD.l && r.a < PAD.l + iw);
  let lastEnd = -Infinity, row = 0;
  const bandLabels = bandRects.map((r) => { row = r.a < lastEnd ? (row + 1) % 2 : 0; lastEnd = r.a + Math.min(r.z - r.a, 120); return { ...r, row }; });
  const xTicks = dates ? [model.x0, (model.x0 + model.x1) / 2, model.x1] : [];

  return (
    <motion.section className="dcard chart-dcard" {...appear} aria-label={d.title}>
      <div className="dcard-title">{d.title}</div>
      {d.series.length > 1 && (
        <div className="dlegend">{d.series.map((s, k) => <span key={k}><i style={{ background: HUES[k] }} />{s.name}</span>)}</div>
      )}
      <div className="dreadout" aria-live="polite">
        <span className="dreadout-x">{selX ? fmtDay(selX, true) : ''}</span>
        {vals.map((v) => v.p && <span key={v.k} className="dreadout-v">{d.series.length > 1 && <i style={{ background: HUES[v.k] }} />}<b className="num">{fmtVal(v.p.y, d.unit)}</b></span>)}
        {[...inBands.map((b) => b.label), ...atMarker.map((m) => m.label)].slice(0, 2).map((l) => <span key={l} className="dreadout-tag">{l}</span>)}
      </div>
      <div ref={ref} className="chart">
        <svg className="chart-svg" width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" tabIndex={0} onKeyDown={onKey}
          aria-label={`${d.title}. ${d.series.map((s) => `${s.name}: ${s.points.length} points, latest ${s.points.length ? fmtVal(s.points[s.points.length - 1].y, d.unit) : 'none'}`).join('; ')}`}
          onPointerDown={onPointer} onPointerMove={onPointer}>
          <defs>
            {d.series.map((_, k) => (
              <linearGradient key={k} id={`ag-fill-${k}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={HUES[k]} stopOpacity={d.series.length > 1 ? 0.12 : 0.3} /><stop offset="1" stopColor={HUES[k]} stopOpacity="0" /></linearGradient>
            ))}
          </defs>
          {bandLabels.map(({ b, a, z, row: r }, i) => (
            <g key={`b${i}`}>
              <rect x={a} y={PAD.t} width={z - a} height={ih} fill={TONE[b.tone ?? 'neutral']} rx={4} />
              <text x={a + 4} y={PAD.t + 11 + r * 13} className="dband-label" fill={TONE_TEXT[b.tone ?? 'neutral']}>{b.label.length > Math.max(4, (z - a) / 6) ? b.label.slice(0, Math.max(3, Math.floor((z - a) / 6))) + '…' : b.label}</text>
            </g>
          ))}
          {model.yt.ticks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.l} x2={PAD.l + iw} y1={Y(t)} y2={Y(t)} className="grid" />
              <text x={PAD.l - 6} y={Y(t) + 4} textAnchor="end" className="axis">{fmtAxis(t)}</text>
            </g>
          ))}
          {dates ? xTicks.map((t, i) => (
            <text key={`x${i}`} x={PAD.l + ((t - model.x0) / (model.x1 - model.x0 || 1)) * iw} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="axis">
              {new Date(t).toLocaleDateString(undefined, model.x1 - model.x0 > 300 * DAY ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' })}</text>
          )) : model.cats.length <= 8 && model.cats.map((c) => <text key={c} x={X(c)} y={H - 6} textAnchor="middle" className="axis">{c.length > 8 ? c.slice(0, 7) + '…' : c}</text>)}
          {d.markers.filter((m) => !dates || DATE.test(m.x)).map((m, i) => {
            const x = X(m.x); if (x < PAD.l - 1 || x > PAD.l + iw + 1) return null;
            return (
              <g key={`m${i}`}>
                <line x1={x} x2={x} y1={PAD.t + 14} y2={PAD.t + ih} className="dmarker-line" />
                <circle cx={x} cy={PAD.t + 10} r={4} className="dmarker-dot" />
              </g>
            );
          })}
          {d.series.map((s, k) => {
            const pts = s.points.map((p) => [X(p.x), Y(p.y)] as [number, number]);
            if (bar) {
              const n = d.series.length, bw = Math.max(3, Math.min(22, (dates ? iw / Math.max(8, s.points.length * 1.6) : catW * 0.7) / n));
              return <g key={k}>{pts.map(([x, y], i) => { const y0 = Y(Math.max(0, model.yt.lo)); const top = Math.min(y, y0), h = Math.max(1, Math.abs(y0 - y));
                return <path key={i} d={roundTop(x - (n * bw) / 2 + k * bw + 1, top, bw - 2, h)} fill={HUES[k]} opacity={selX && s.points[i].x !== selX ? 0.75 : 1} />; })}</g>;
            }
            if (d.kind === 'scatter') return <g key={k}>{pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={4} fill={HUES[k]} className="ddot" />)}</g>;
            const line = smoothPath(pts);
            return (
              <g key={k}>
                {(d.kind === 'area' || d.series.length === 1) && pts.length > 1 && <path d={`${line}L${pts[pts.length - 1][0]},${PAD.t + ih}L${pts[0][0]},${PAD.t + ih}Z`} fill={`url(#ag-fill-${k})`} />}
                <path d={line} fill="none" stroke={HUES[k]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                {pts.length <= 24 && pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={3} fill={HUES[k]} className="ddot sm" />)}
              </g>
            );
          })}
          {selX && !bar && (
            <g pointerEvents="none">
              <line x1={X(selX)} x2={X(selX)} y1={PAD.t} y2={PAD.t + ih} className="dcross" />
              {vals.map((v) => v.p && <circle key={v.k} cx={X(selX)} cy={Y(v.p.y)} r={5} fill={HUES[v.k]} className="ddot" />)}
            </g>
          )}
        </svg>
      </div>
      {d.markers.length > 0 && (
        <div className="dmarkers">{d.markers.slice(0, 6).map((m, i) => (
          <button key={i} className="dmarker-chip" onClick={() => { const j = xs.findIndex((x) => x >= m.x); setSel(j < 0 ? xs.length - 1 : j); }}><i />{fmtDay(m.x)} · {m.label}</button>
        ))}</div>
      )}
    </motion.section>
  );
}
const roundTop = (x: number, y: number, w: number, h: number) => { const r = Math.min(4, w / 2, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

export function TableCard({ d }: { d: Extract<Display, { type: 'table' }> }) {
  const numeric = d.columns.map((_, i) => d.rows.every((r) => r[i] == null || typeof r[i] === 'number'));
  return (
    <motion.section className="dcard" {...appear} aria-label={d.title ?? 'Table'}>
      {d.title && <div className="dcard-title">{d.title}</div>}
      <div className="dtable-wrap">
        <table className="dtable">
          <thead><tr>{d.columns.map((c, i) => <th key={i} className={numeric[i] ? 'num' : ''} dir="auto">{c}</th>)}</tr></thead>
          <tbody>{d.rows.map((r, j) => <tr key={j}>{r.map((v, i) => <td key={i} className={numeric[i] ? 'num' : ''} dir="auto">{v == null ? '–' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : v}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </motion.section>
  );
}

export function StatsCard({ d }: { d: Extract<Display, { type: 'stats' }> }) {
  return (
    <motion.section className={'dstats' + (d.items.length === 1 ? ' one' : '')} {...appear} aria-label="Stats">
      {d.items.map((it, i) => {
        const good = it.delta == null || !it.good ? null : (it.delta > 0) === (it.good === 'up');
        return (
          <div key={i} className="dstat">
            <div className="dstat-label" dir="auto">{it.label}</div>
            <div className="dstat-value num">{typeof it.value === 'number' ? it.value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : it.value}{it.unit && <span className="dstat-unit"> {it.unit}</span>}</div>
            {it.delta != null && it.delta !== 0 && (
              <div className={'dstat-delta num' + (good == null ? '' : good ? ' good' : ' bad')}>
                <span aria-hidden>{it.delta > 0 ? '▲' : '▼'}</span><span className="sr-only">{it.delta > 0 ? 'up' : 'down'} </span>{Math.abs(it.delta).toLocaleString(undefined, { maximumFractionDigits: 1 })}{it.unit ? ` ${it.unit}` : ''}
              </div>
            )}
          </div>
        );
      })}
    </motion.section>
  );
}

export function DisplayCard({ d }: { d: Display }) {
  if (d.type === 'chart') return <ChartCard d={d} />;
  if (d.type === 'table') return <TableCard d={d} />;
  return <StatsCard d={d} />;
}
