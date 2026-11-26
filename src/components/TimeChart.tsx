// One reusable time-series chart (line, dots or weekly bars) with a compact card mode and a maximized full-screen mode.
// Dataviz rules: one series in the role colour (title names it; legend only for the special marks that are present),
// 2px line, ≥ 8px dots with a surface ring, hollow = lower bound (≥), dim = unreliable (≈), ringed = PR, hairline grid,
// text in text tokens. Honest gaps: no line across a pause longer than gapDays (a faint dashed hairline marks the break).
// Values are always reachable: fixed readout row (no floating tooltip), keyboard stepping, and a values list when maximized.
// Compact: tap / drag sideways to scrub (touch-action: pan-y, so vertical page scroll is never hijacked).
// Full screen: drag = pan (with momentum), pinch / wheel = zoom the time axis, tap = crosshair, hold then drag = scrub.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';
import { Link } from 'react-router';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { fmtAxis, niceTicks } from './Charts';
import { clampWindow, DAY_MS, GAP_DAYS, segments, zoomWindow } from '../lib/series';

export interface TPoint {
  t: number; v: number;
  /** effort unknown: the real value is at least this (drawn hollow, shown with ≥) */
  lowerBound?: boolean;
  /** estimate outside the reliable range (drawn dim, shown with ≈) */
  unreliable?: boolean;
  pr?: boolean;
  /** ignored by the trend (e.g. a weigh-in typo): drawn as a faint ring, kept out of the y range */
  excluded?: boolean;
  /** bars: the period is still running (drawn lighter) */
  partial?: boolean;
  caption?: string;
  key?: string;
}
export interface TBand { from: number; to: number; label: string; tone?: 'good' | 'bad' | 'neutral' }
export interface TMarker { t: number; label: string }
export type RangeKey = '1M' | '3M' | '6M' | '1Y' | 'All';
const RANGES: { key: RangeKey; days: number }[] = [{ key: '1M', days: 31 }, { key: '3M', days: 92 }, { key: '6M', days: 183 }, { key: '1Y', days: 366 }, { key: 'All', days: 0 }];

export interface TimeChartProps {
  title: string;
  note?: ReactNode;
  /** sorted oldest first */
  points: TPoint[];
  kind?: 'line' | 'dots' | 'bar';
  fmt: (v: number) => string;
  /** a smoothed line drawn over the points (weight trend) */
  trend?: { t: number; v: number }[];
  trendLabel?: string;
  /** label of the plain point mark in the legend when a trend is drawn ("Weigh-in") */
  pointLabel?: string;
  area?: boolean;
  zeroBased?: boolean;
  integer?: boolean;
  gapDays?: number;
  /** bar width in ms (default one week); bars start at their point's t */
  period?: number;
  defaultRange?: RangeKey;
  height?: number;
  bands?: TBand[];
  markers?: TMarker[];
  /** extra content between the title and the chart (metric chips) */
  header?: ReactNode;
  /** link for a values-list row (opens the session) */
  rowHref?: (p: TPoint) => string | undefined;
  /** "Week of" prefix for bar dates */
  barDateLabel?: string;
  className?: string;
  /** ranges end today (default; an exercise not done lately shows the empty stretch). false: they end at the last point */
  anchorToday?: boolean;
  /** no card chrome (when the caller already wraps it in a card) */
  bare?: boolean;
}

const TONE: Record<string, string> = { good: 'rgba(48, 209, 88, 0.14)', bad: 'rgba(255, 69, 58, 0.14)', neutral: 'rgba(235, 235, 245, 0.07)' };
const TONE_TEXT: Record<string, string> = { good: '#7fe39b', bad: '#ff8a80', neutral: 'rgba(235, 235, 245, 0.72)' };
const PAD = { l: 44, r: 14, t: 12, b: 24 };
const WEEK = 7 * DAY_MS;

/** Element size via a callback ref, so it also works for elements that mount later (inside a sheet that opens). */
function useSize<T extends HTMLElement>() {
  const [s, setS] = useState({ w: 320, h: 0 });
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect(); ro.current = null;
    if (!el) return;
    const read = () => { const r = el.getBoundingClientRect(); setS({ w: Math.max(200, Math.round(r.width)), h: Math.round(r.height) }); };
    ro.current = new ResizeObserver(read); ro.current.observe(el); read();
  }, []);
  return [ref, s] as const;
}

// ---------- formatting ----------
const thisYear = new Date().getFullYear();
export const fmtDayLong = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: new Date(t).getFullYear() === thisYear ? undefined : 'numeric' });
const fmtDayShort = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === thisYear ? undefined : '2-digit' });
const prefix = (p: TPoint) => (p.lowerBound ? '≥' : p.unreliable ? '≈' : '');

/** Calendar-aligned time ticks for [t0, t1], at most maxN of them. */
function timeTicks(t0: number, t1: number, maxN: number) {
  const span = t1 - t0;
  const steps: [number, 'd' | 'm'][] = [[1, 'd'], [2, 'd'], [7, 'd'], [14, 'd'], [1, 'm'], [2, 'm'], [3, 'm'], [6, 'm'], [12, 'm'], [24, 'm']];
  const [n, u] = steps.find(([k, unit]) => span / (k * (unit === 'd' ? DAY_MS : 30.44 * DAY_MS)) <= maxN) ?? steps[steps.length - 1];
  const out: { t: number; label: string }[] = [];
  if (u === 'd') {
    const d = new Date(t0); d.setHours(0, 0, 0, 0);
    if (n === 7 || n === 14) d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start Monday
    while (d.getTime() < t0) d.setDate(d.getDate() + n);
    for (; d.getTime() <= t1; d.setDate(d.getDate() + n)) out.push({ t: d.getTime(), label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
  } else {
    const d0 = new Date(t0);
    let y = d0.getFullYear(), m = d0.getMonth();
    if (new Date(y, m, 1).getTime() < t0) m++;
    m = Math.ceil(m / n) * n; // align (quarters start Jan/Apr/Jul/Oct, years start Jan)
    for (let d = new Date(y, m, 1); d.getTime() <= t1; d = new Date(y, (m += n), 1)) { // Date normalises months past 11
      const yr = d.getMonth() === 0 || n >= 12;
      out.push({ t: d.getTime(), label: n >= 12 ? String(d.getFullYear()) : d.toLocaleDateString(undefined, yr ? { month: 'short', year: '2-digit' } : { month: 'short' }) });
    }
  }
  return out;
}

/** Index of the point whose (centre) time is nearest t. */
function nearest(ts: number[], t: number) {
  let lo = 0, hi = ts.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] < t) lo = mid; else hi = mid; }
  return Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
}

interface Model {
  points: TPoint[]; kind: 'line' | 'dots' | 'bar'; period: number; centers: number[]; lo: number; hi: number;
}
function useModel(points: TPoint[], kind: 'line' | 'dots' | 'bar', period: number, anchorToday: boolean): Model {
  return useMemo(() => {
    const centers = points.map((p) => (kind === 'bar' ? p.t + period / 2 : p.t));
    const first = points.length ? points[0].t : Date.now() - 30 * DAY_MS;
    const last = points.length ? points[points.length - 1].t + (kind === 'bar' ? period : 0) : Date.now();
    // ranges count back from today (like the session list filter), so "3M" means the last 3 months for every metric
    const hi = (anchorToday ? Math.max(last, Date.now()) : last) + (kind === 'bar' ? 0 : 2 * DAY_MS);
    const lo = Math.min(first - (kind === 'bar' ? 0 : 2 * DAY_MS), hi - 14 * DAY_MS);
    return { points, kind, period, centers, lo, hi };
  }, [points, kind, period, anchorToday]);
}
function rangeWindow(m: Model, r: RangeKey): [number, number] {
  const days = RANGES.find((x) => x.key === r)!.days;
  return days ? clampWindow(m.hi - days * DAY_MS, m.hi, m.lo, m.hi) : [m.lo, m.hi];
}

// ---------- the plot ----------
interface PlotProps extends Pick<TimeChartProps, 'fmt' | 'trend' | 'area' | 'zeroBased' | 'integer' | 'bands' | 'markers' | 'title'> {
  m: Model; win: [number, number]; w: number; h: number; sel: number; gapDays: number;
  full: boolean;
  onSelect: (i: number) => void;
  onWindow?: (w: [number, number]) => void;
}

function Plot({ m, win, w, h, sel, gapDays, full, fmt, trend, area, zeroBased, integer, bands = [], markers = [], title, onSelect, onWindow }: PlotProps) {
  const [t0, t1] = win;
  const span = t1 - t0 || 1;
  const pw = w - PAD.l - PAD.r, ph = h - PAD.t - PAD.b;
  const X = (t: number) => PAD.l + ((t - t0) / span) * pw;
  const bar = m.kind === 'bar';
  const vis = useMemo(() => {
    const out: number[] = [];
    m.centers.forEach((c, i) => { if (c >= t0 - (bar ? m.period / 2 : 0) && c <= t1 + (bar ? m.period / 2 : 0)) out.push(i); });
    return out;
  }, [m, t0, t1, bar]);
  // y range from what's on screen (excluded points never stretch it)
  const yr = useMemo(() => {
    const vs = vis.filter((i) => !m.points[i].excluded).map((i) => m.points[i].v);
    if (trend) for (const p of trend) if (p.t >= t0 && p.t <= t1) vs.push(p.v);
    if (!vs.length) return niceTicks(0, 1, 3);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (bar || zeroBased) { lo = Math.min(0, lo); hi = Math.max(0, hi, integer ? 1 : 0); }
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
    // domain = the data plus a little room (0 stays the floor for zero-based and all-positive data); ticks sit inside it
    const d0 = bar || zeroBased ? (lo < 0 ? lo - pad : 0) : lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
    const d1 = bar || zeroBased ? (hi > 0 ? hi + pad : 0) : hi + pad;
    const nt = niceTicks(d0, d1, full ? 5 : 4, integer ? 1 : 0);
    const inside = nt.ticks.filter((v) => v >= d0 - 1e-9 && v <= d1 + 1e-9);
    return inside.length >= 2 ? { ticks: inside, lo: d0, hi: d1 } : nt;
  }, [vis, m, trend, t0, t1, bar, zeroBased, integer, full]);
  const Y = (v: number) => PAD.t + (1 - (v - yr.lo) / (yr.hi - yr.lo || 1)) * ph;
  const ticks = useMemo(() => timeTicks(t0, t1, Math.max(2, Math.floor(pw / (full ? 64 : 56)))), [t0, t1, pw, full]);

  // ---- line segments (one point beyond each edge so lines run to the frame; clipped) ----
  const segs = useMemo(() => {
    if (m.kind !== 'line' || !vis.length) return { lines: [] as TPoint[][], breaks: [] as [TPoint, TPoint][] };
    const a = Math.max(0, vis[0] - 1), b = Math.min(m.points.length - 1, vis[vis.length - 1] + 1);
    const pts = m.points.slice(a, b + 1).filter((p) => !p.excluded);
    const lines = segments(pts, gapDays);
    const breaks: [TPoint, TPoint][] = [];
    for (let i = 1; i < lines.length; i++) breaks.push([lines[i - 1][lines[i - 1].length - 1], lines[i][0]]);
    return { lines, breaks };
  }, [m, vis, gapDays]);
  const trendSegs = useMemo(() => (trend?.length ? segments(trend.filter((p) => p.t >= t0 - 60 * DAY_MS && p.t <= t1 + 60 * DAY_MS), gapDays) : []), [trend, t0, t1, gapDays]);
  const path = (pts: { t: number; v: number }[]) => pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');

  // ---- bands clamped to the plot; labels on alternating rows when they would collide ----
  let lastEnd = -Infinity, bandRow = 0;
  const bandLabels = bands.map((b) => ({ b, a: Math.max(PAD.l, X(b.from)), z: Math.min(PAD.l + pw, X(b.to)) })).filter((r) => r.z > r.a)
    .map((r) => { bandRow = r.a < lastEnd ? (bandRow + 1) % 2 : 0; lastEnd = r.a + Math.min(r.z - r.a, 120); return { ...r, row: bandRow }; });

  // ---- dots: all when there's room, else only the special ones (PR / flagged / excluded) ----
  const roomy = vis.length <= pw / (full ? 7 : 9);
  const clipId = useRef(`tc${Math.random().toString(36).slice(2, 8)}`).current;

  // ---- bars ----
  const bandPx = (m.period / span) * pw;
  const bw = Math.max(1.5, Math.min(24, bandPx * 0.7));
  const col = (p: TPoint) => {
    const x = X(p.t + m.period / 2) - bw / 2, end = Y(p.v), base = Y(0), h = Math.abs(base - end);
    if (h < 0.5) return '';
    const r = Math.min(4, bw / 2, h), sg = end < base ? 1 : -1; // +1 grows up, -1 grows down (negative value); rounded at the data end
    const f = (v: number) => v.toFixed(1);
    return `M${f(x)},${f(base)}V${f(end + sg * r)}Q${f(x)},${f(end)} ${f(x + r)},${f(end)}H${f(x + bw - r)}Q${f(x + bw)},${f(end)} ${f(x + bw)},${f(end + sg * r)}V${f(base)}Z`;
  };

  // ---------- pointer handling ----------
  const svgRef = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion();
  const live = useRef({ win, onWindow, onSelect, m, pw });
  live.current = { win, onWindow, onSelect, m, pw };
  const pickAt = useCallback((clientX: number) => {
    const el = svgRef.current; if (!el) return;
    const { win: [a, b], m: mm, pw: pww, onSelect: sel } = live.current;
    const r = el.getBoundingClientRect();
    const t = a + ((clientX - r.left - PAD.l) / pww) * (b - a);
    const i = nearest(mm.centers, Math.max(a, Math.min(b, t)));
    if (i >= 0) sel(i);
  }, []);
  type Ptr = { x: number; y: number };
  const g = useRef<{ ptrs: Map<number, Ptr>; mode: 'idle' | 'maybe' | 'pan' | 'scrub' | 'pinch' | 'done'; startX: number; startWin: [number, number]; startT: number; hold?: number;
    pinch?: { d0: number; anchor: number; mid0: number }; hist: { x: number; t: number }[]; raf?: number }>({ ptrs: new Map(), mode: 'idle', startX: 0, startWin: win, startT: 0, hist: [] });
  const stopMomentum = () => { if (g.current.raf) cancelAnimationFrame(g.current.raf); g.current.raf = undefined; };
  useEffect(() => () => { stopMomentum(); if (g.current.hold) clearTimeout(g.current.hold); }, []);
  const setWin = (a: number, b: number) => { const { m: mm, onWindow: ow } = live.current; ow?.(clampWindow(a, b, mm.lo, mm.hi, 7 * DAY_MS)); };
  const panBy = (dx: number, base: [number, number]) => { const k = (base[1] - base[0]) / live.current.pw; setWin(base[0] - dx * k, base[1] - dx * k); };

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (!full) { pickAt(e.clientX); return; } // compact: select only (no capture, no preventDefault: page scroll stays native)
    stopMomentum();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    const s = g.current;
    s.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.ptrs.size === 2) {
      if (s.hold) clearTimeout(s.hold);
      const [p, q] = [...s.ptrs.values()];
      const r = e.currentTarget.getBoundingClientRect();
      const mid = (p.x + q.x) / 2;
      const { win: [a, b] } = live.current;
      s.mode = 'pinch'; s.startWin = [a, b];
      s.pinch = { d0: Math.max(20, Math.abs(p.x - q.x)), mid0: mid, anchor: a + ((mid - r.left - PAD.l) / live.current.pw) * (b - a) };
      return;
    }
    s.mode = 'maybe'; s.startX = e.clientX; s.startWin = live.current.win; s.startT = performance.now(); s.hist = [{ x: e.clientX, t: s.startT }];
    if (e.pointerType === 'mouse') return;
    s.hold = window.setTimeout(() => { if (s.mode === 'maybe') { s.mode = 'scrub'; pickAt(s.startX); } }, 320);
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!full) { if (e.pointerType === 'mouse' || e.buttons) pickAt(e.clientX); return; }
    const s = g.current;
    if (!s.ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse' && s.mode === 'idle') pickAt(e.clientX); return; } // mouse hover scrubs
    s.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.mode === 'pinch' && s.pinch && s.ptrs.size >= 2) {
      const [p, q] = [...s.ptrs.values()];
      const d = Math.max(20, Math.abs(p.x - q.x));
      const { m: mm } = live.current;
      const [a, b] = zoomWindow(s.startWin[0], s.startWin[1], s.pinch.d0 / d, s.pinch.anchor, mm.lo, mm.hi);
      const dx = (p.x + q.x) / 2 - s.pinch.mid0; const k = (b - a) / live.current.pw;
      setWin(a - dx * k, b - dx * k);
      return;
    }
    if (s.mode === 'maybe' && Math.abs(e.clientX - s.startX) > 6) { s.mode = 'pan'; if (s.hold) clearTimeout(s.hold); }
    if (s.mode === 'scrub') pickAt(e.clientX);
    if (s.mode === 'pan') {
      panBy(e.clientX - s.startX, s.startWin);
      s.hist.push({ x: e.clientX, t: performance.now() }); if (s.hist.length > 6) s.hist.shift();
    }
  };
  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    if (!full) return;
    const s = g.current;
    if (s.hold) clearTimeout(s.hold);
    const wasMode = s.mode;
    s.ptrs.delete(e.pointerId);
    if (wasMode === 'pinch' || wasMode === 'done') { s.mode = s.ptrs.size ? 'done' : 'idle'; return; } // lifting from a pinch is never a tap
    if (s.ptrs.size) return;
    s.mode = 'idle';
    if (e.type === 'pointercancel') return;
    if (wasMode === 'maybe') { pickAt(e.clientX); return; } // a tap
    if (wasMode === 'pan' && !reduce && s.hist.length >= 2) {
      // momentum: continue at the release velocity, decaying like a scroll view (apple-design §6, d = 0.998 per ms)
      const a = s.hist[0], b = s.hist[s.hist.length - 1];
      let v = (b.x - a.x) / Math.max(1, b.t - a.t); // px / ms
      if (performance.now() - b.t > 80 || Math.abs(v) < 0.05) return;
      let last = performance.now();
      const step = (now: number) => {
        const dt = now - last; last = now;
        v *= Math.pow(0.998, dt);
        if (Math.abs(v) < 0.02) { s.raf = undefined; return; }
        panBy(v * dt, live.current.win);
        s.raf = requestAnimationFrame(step);
      };
      s.raf = requestAnimationFrame(step);
    }
  };
  // wheel / trackpad: vertical = zoom around the cursor, horizontal = pan (needs a non-passive listener)
  useEffect(() => {
    const el = svgRef.current; if (!el || !full) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); stopMomentum();
      const { win: [a, b], m: mm, pw: pww } = live.current;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { panBy(-(e.deltaX || e.deltaY), [a, b]); return; }
      const r = el.getBoundingClientRect();
      const anchor = a + ((e.clientX - r.left - PAD.l) / pww) * (b - a);
      const [na, nb] = zoomWindow(a, b, Math.exp(e.deltaY * 0.002), anchor, mm.lo, mm.hi);
      live.current.onWindow?.([na, nb]);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  const p = m.points[sel];
  const selIn = !!p && m.centers[sel] >= t0 && m.centers[sel] <= t1;
  const sx = p ? X(m.centers[sel]) : 0;
  const nVis = vis.length;
  const latest = m.points[m.points.length - 1];

  return (
    <svg ref={svgRef} width={w} height={h} className={'chart-svg tc-svg' + (full ? ' full' : '')} role="group" tabIndex={0}
      aria-label={`${title}. ${nVis} ${nVis === 1 ? 'point' : 'points'} shown${latest ? `, latest ${prefix(latest)}${fmt(latest.v)} on ${fmtDayLong(latest.t)}` : ''}. Left and right arrow keys step through them${full ? '; plus and minus zoom' : ''}.`}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onPointerLeave={(e) => { if (full && e.pointerType === 'mouse' && !g.current.ptrs.size) g.current.mode = 'idle'; }}>
      <defs>
        <clipPath id={clipId}><rect x={PAD.l - 6} y={0} width={pw + 12} height={h - PAD.b + 2} /></clipPath>
        {area && <linearGradient id={`${clipId}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="tc-fill-stop" stopOpacity="0.28" /><stop offset="1" className="tc-fill-stop" stopOpacity="0" /></linearGradient>}
      </defs>
      {bandLabels.map(({ b, a, z, row }, i) => (
        <g key={`b${i}`}>
          <rect x={a} y={PAD.t} width={Math.max(2, z - a)} height={ph} rx={4} fill={TONE[b.tone ?? 'neutral']} />
          <text x={a + 4} y={PAD.t + 11 + row * 13} className="tc-band-label" fill={TONE_TEXT[b.tone ?? 'neutral']}>{b.label.length > Math.max(4, (z - a) / 6) ? b.label.slice(0, Math.max(3, Math.floor((z - a) / 6))) + '…' : b.label}</text>
        </g>
      ))}
      {yr.ticks.map((v) => (
        <g key={`y${v}`}>
          <line x1={PAD.l} x2={w - PAD.r} y1={Y(v)} y2={Y(v)} className={v === 0 && (bar || zeroBased) ? 'chart-base' : 'chart-gridline'} />
          <text x={PAD.l - 8} y={Y(v)} dy="0.32em" textAnchor="end" className="chart-tick">{fmtAxis(v)}</text>
        </g>
      ))}
      {ticks.map((tk) => {
        const x = X(tk.t); if (x < PAD.l - 1 || x > w - PAD.r + 1) return null;
        return <text key={`x${tk.t}`} x={Math.min(w - PAD.r - 14, Math.max(PAD.l + 14, x))} y={h - 6} textAnchor="middle" className="chart-tick">{tk.label}</text>;
      })}
      <g clipPath={`url(#${clipId})`}>
        {markers.map((mk, i) => { const x = X(mk.t); return x >= PAD.l && x <= PAD.l + pw ? <line key={`m${i}`} x1={x} x2={x} y1={PAD.t} y2={PAD.t + ph} className="tc-marker" /> : null; })}
        {bar && vis.map((i) => <path key={m.points[i].key ?? i} d={col(m.points[i])} className={'chart-col tc-col' + (m.points[i].partial ? ' partial' : '') + (i === sel ? ' on' : '')} />)}
        {segs.breaks.map(([a, b], i) => <line key={`g${i}`} x1={X(a.t)} y1={Y(a.v)} x2={X(b.t)} y2={Y(b.v)} className="tc-break" />)}
        {area && segs.lines.map((s, i) => s.length > 1 && <path key={`a${i}`} d={`${path(s)}L${X(s[s.length - 1].t).toFixed(1)},${PAD.t + ph}L${X(s[0].t).toFixed(1)},${PAD.t + ph}Z`} fill={`url(#${clipId}-fill)`} />)}
        {segs.lines.map((s, i) => <path key={`l${i}`} d={path(s)} className="tc-line" />)}
        {m.kind !== 'dots' && trendSegs.map((s, i) => <path key={`t${i}`} d={path(s)} className="tc-trend" />)}
        {!bar && vis.map((i) => {
          const pt = m.points[i];
          if (pt.excluded) return <circle key={pt.key ?? i} cx={X(pt.t)} cy={Math.max(PAD.t, Math.min(PAD.t + ph, Y(pt.v)))} r={3.5} className="tc-dot excluded" />;
          // dense: only PRs keep a dot (≥ / ≈ stay in the readout, legend and values list), so 400 flagged points don't turn into noise
          if (!roomy && !pt.pr && m.kind === 'line') return null;
          const cls = 'tc-dot' + (pt.lowerBound ? ' hollow' : '') + (pt.unreliable ? ' dim' : '') + (m.kind === 'dots' && trend ? ' raw' : '');
          return (
            <g key={pt.key ?? i}>
              {pt.pr && <circle cx={X(pt.t)} cy={Y(pt.v)} r={roomy ? 7.5 : 5.5} className="tc-pr" />}
              <circle cx={X(pt.t)} cy={Y(pt.v)} r={m.kind === 'dots' ? 3.5 : roomy ? 4 : 3} className={cls} />
            </g>
          );
        })}
        {m.kind === 'dots' && trendSegs.map((s, i) => <path key={`t${i}`} d={path(s)} className="tc-trend" />)}
        {trendSegs.slice(1).map((s, i) => { const a = trendSegs[i][trendSegs[i].length - 1], b = s[0]; return <line key={`tg${i}`} x1={X(a.t)} y1={Y(a.v)} x2={X(b.t)} y2={Y(b.v)} className="tc-break" />; })}
      </g>
      {!nVis && <text x={PAD.l + pw / 2} y={PAD.t + ph / 2} textAnchor="middle" className="chart-tick">No data in this range</text>}
      {selIn && p && (
        <g pointerEvents="none">
          <line x1={sx} x2={sx} y1={PAD.t} y2={PAD.t + ph} className="chart-cross" />
          {!bar && <circle cx={sx} cy={Math.max(PAD.t, Math.min(PAD.t + ph, Y(p.v)))} r={5.5} className={'tc-dot on' + (p.lowerBound ? ' hollow' : '') + (p.excluded ? ' excluded' : '')} />}
        </g>
      )}
    </svg>
  );
}

// ---------- readout / legend ----------
function Readout({ p, fmt, bar, barDateLabel, bands, markers, period }: { p?: TPoint; fmt: (v: number) => string; bar: boolean; barDateLabel?: string; bands?: TBand[]; markers?: TMarker[]; period: number }) {
  if (!p) return <div className="chart-readout" aria-live="polite"><span>No data</span></div>;
  const tags = [...(bands ?? []).filter((b) => p.t >= b.from && p.t <= b.to).map((b) => b.label), ...(markers ?? []).filter((m) => Math.abs(m.t - p.t) < (bar ? period : DAY_MS)).map((m) => m.label)].slice(0, 2);
  return (
    <div className="chart-readout tc-readout" aria-live="polite">
      <b className="num">{prefix(p)}{fmt(p.v)}</b>
      <span>{bar ? [barDateLabel ?? 'Week of', fmtDayShort(p.t)].filter(Boolean).join(' ') : fmtDayLong(p.t)}{p.caption ? ` · ${p.caption}` : ''}{p.partial ? ' · so far' : ''}{p.excluded ? ' · ignored by trend' : ''}</span>
      {p.pr && <span className="badge good tc-badge"><Icon name="flag" size={11} />PR</span>}
      {tags.map((t) => <span key={t} className="dreadout-tag">{t}</span>)}
    </div>
  );
}

function Legend({ points, kind, trend, trendLabel, pointLabel, gaps }: { points: TPoint[]; kind: string; trend?: unknown[]; trendLabel?: string; pointLabel?: string; gaps: boolean }) {
  const has = (f: (p: TPoint) => boolean | undefined) => points.some(f);
  const items: ReactNode[] = [];
  if (trend?.length) { items.push(<span key="pt"><i className="lg-dot raw" />{pointLabel ?? 'Value'}</span>); items.push(<span key="tr"><i className="lg-line" />{trendLabel ?? 'Trend'}</span>); }
  if (kind !== 'bar' && has((p) => p.pr)) items.push(<span key="pr"><i className="lg-dot pr" />PR</span>);
  if (has((p) => p.lowerBound)) items.push(<span key="lb"><i className="lg-dot hollow" />≥ no RIR</span>);
  if (has((p) => p.unreliable)) items.push(<span key="un"><i className="lg-dot dim" />≈ &gt;12 reps</span>);
  if (has((p) => p.excluded)) items.push(<span key="ex"><i className="lg-dot excluded" />Ignored</span>);
  if (gaps && (kind === 'line' || !!trend?.length)) items.push(<span key="gp"><i className="lg-break" />Break</span>);
  if (kind === 'bar' && has((p) => p.partial)) items.push(<span key="pa"><i className="lg-sq partial" />So far</span>);
  return items.length ? <div className="tc-legend">{items}</div> : null;
}

function RangeChips({ value, onChange, label }: { value: RangeKey | null; onChange: (r: RangeKey) => void; label: string }) {
  return (
    <div className="seg range-seg tc-ranges" role="group" aria-label={`${label}: time range`}>
      {RANGES.map((r) => <button key={r.key} aria-pressed={value === r.key} onClick={() => onChange(r.key)}>{r.key}</button>)}
    </div>
  );
}

// ---------- the public component ----------
export function TimeChart(props: TimeChartProps) {
  const { title, note, points, kind = 'line', fmt, trend, zeroBased, integer, gapDays = GAP_DAYS, period = WEEK, defaultRange = 'All', height = 176, header, className, bare } = props;
  const m = useModel(points, kind, period, props.anchorToday ?? true);
  const [range, setRange] = useState<RangeKey>(defaultRange);
  const win = useMemo(() => rangeWindow(m, range), [m, range]);
  const [ref, size] = useSize<HTMLDivElement>();
  const [selRaw, setSel] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  // default selection: the latest point in view (bars: the latest non-empty one; an empty week in progress says little)
  const lastInView = useMemo(() => {
    let any = -1;
    for (let i = m.centers.length - 1; i >= 0; i--) if (m.centers[i] <= win[1] && m.centers[i] >= win[0]) { if (any < 0) any = i; if (kind !== 'bar' || m.points[i].v > 0) return i; }
    return any >= 0 ? any : m.points.length - 1;
  }, [m, win, kind]);
  const sel = selRaw == null || selRaw >= m.points.length ? lastInView : selRaw;
  useEffect(() => setSel(null), [points.length, points[0]?.t, points[points.length - 1]?.t]);
  const onKey = (e: KeyboardEvent) => {
    const n = e.key === 'ArrowLeft' ? sel - 1 : e.key === 'ArrowRight' ? sel + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? m.points.length - 1 : null;
    if (n == null) return; e.preventDefault(); setSel(Math.max(0, Math.min(m.points.length - 1, n)));
  };
  const visPts = useMemo(() => points.filter((_, i) => m.centers[i] >= win[0] && m.centers[i] <= win[1]), [points, m, win]);
  const gaps = useMemo(() => segments(visPts.filter((p) => !p.excluded), gapDays).length > 1, [visPts, gapDays]);

  const body = (
    <>
      <div className="tc-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <h3 className="chart-title">{title}</h3>
          {note && <div className="chart-note">{note}</div>}
        </div>
        <button className="icon-btn sm tc-max" aria-label={`Full screen: ${title}`} onClick={() => setFull(true)} disabled={!points.length}><Icon name="expand" size={18} stroke={2} /></button>
      </div>
      {header}
      <Readout p={m.points[sel]} fmt={fmt} bar={kind === 'bar'} barDateLabel={props.barDateLabel} bands={props.bands} markers={props.markers} period={period} />
      <div ref={ref} className="chart" onKeyDown={onKey}>
        {points.length ? <Plot m={m} win={win} w={size.w} h={height} sel={sel} gapDays={gapDays} full={false} fmt={fmt} trend={trend} area={props.area}
          zeroBased={zeroBased} integer={integer} bands={props.bands} markers={props.markers} title={title} onSelect={setSel} />
          : <div className="chart-empty">No data yet</div>}
      </div>
      <div className="tc-foot">
        <RangeChips value={range} onChange={(r) => { setRange(r); setSel(null); }} label={title} />
      </div>
      <Legend points={visPts} kind={kind} trend={trend} trendLabel={props.trendLabel} pointLabel={props.pointLabel} gaps={gaps} />
      {!!props.markers?.length && (
        <div className="dmarkers">{props.markers.slice(0, 6).map((mk, i) => (
          <button key={i} className="dmarker-chip" onClick={() => { const j = nearest(m.centers, mk.t); if (j >= 0) setSel(j); }}><i />{fmtDayShort(mk.t)} · {mk.label}</button>
        ))}</div>
      )}
      <FullChart open={full} onClose={() => setFull(false)} props={props} m={m} startWin={win} startRange={range} sel={sel} setSel={setSel} />
    </>
  );
  if (bare) return <div className={'tc ' + (className ?? '')}>{body}</div>;
  return <section className={'card chart-card tc ' + (className ?? '')} aria-label={title}>{body}</section>;
}

// ---------- maximized ----------
function FullChart({ open, onClose, props, m, startWin, startRange, sel, setSel }: {
  open: boolean; onClose: () => void; props: TimeChartProps; m: Model; startWin: [number, number]; startRange: RangeKey; sel: number; setSel: (i: number) => void;
}) {
  const { title, fmt, trend, kind = 'line', gapDays = GAP_DAYS, period = WEEK } = props;
  const [win, setWin] = useState<[number, number]>(startWin);
  const [range, setRange] = useState<RangeKey | null>(startRange);
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) { setWin(startWin); setRange(startRange); } }
  const [ref, size] = useSize<HTMLDivElement>();
  const listRef = useRef<HTMLDivElement>(null);
  const fromList = useRef(false);
  const vis = useMemo(() => { const out: number[] = []; m.centers.forEach((c, i) => { if (c >= win[0] && c <= win[1]) out.push(i); }); return out.reverse(); }, [m, win]);
  const gaps = useMemo(() => segments(vis.map((i) => m.points[i]).filter((p) => !p.excluded).reverse(), gapDays).length > 1, [vis, m, gapDays]);
  const select = (i: number) => { fromList.current = false; setSel(i); };
  // keep the selected row in view when the crosshair moves (not when the row itself was tapped)
  useEffect(() => {
    if (!open || fromList.current) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);
  const jump = (i: number) => {
    fromList.current = true; setSel(i);
    const c = m.centers[i];
    if (c < win[0] || c > win[1]) { const w = win[1] - win[0]; setWin(clampWindow(c - w / 2, c + w / 2, m.lo, m.hi)); setRange(null); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault(); const c = m.centers[sel] ?? (win[0] + win[1]) / 2;
      setWin(zoomWindow(win[0], win[1], e.key === '-' ? 1.5 : 1 / 1.5, c, m.lo, m.hi)); setRange(null); return;
    }
    const n = e.key === 'ArrowLeft' ? sel - 1 : e.key === 'ArrowRight' ? sel + 1 : null;
    if (n == null) return; e.preventDefault(); jump(Math.max(0, Math.min(m.points.length - 1, n)));
  };
  const visPts = vis.map((i) => m.points[i]);
  return (
    <Sheet open={open} onClose={onClose} title={title} fullscreen>
      <div className="tc-full">
        <div className="tc-full-chart">
          <Readout p={m.points[sel]} fmt={fmt} bar={kind === 'bar'} barDateLabel={props.barDateLabel} bands={props.bands} markers={props.markers} period={period} />
          <div ref={ref} className="chart tc-full-plot" onKeyDown={onKey}>
            {size.h > 40 && <Plot m={m} win={win} w={size.w} h={size.h} sel={sel} gapDays={gapDays} full fmt={fmt} trend={trend} area={props.area}
              zeroBased={props.zeroBased} integer={props.integer} bands={props.bands} markers={props.markers} title={title} onSelect={select}
              onWindow={(w) => { setWin(w); setRange(null); }} />}
          </div>
          <div className="tc-full-bar">
            <RangeChips value={range} onChange={(r) => { setRange(r); setWin(rangeWindow(m, r)); }} label={title} />
            <span className="tc-span num">{fmtDayShort(win[0])} – {fmtDayShort(win[1])}</span>
          </div>
          <Legend points={visPts} kind={kind} trend={trend} trendLabel={props.trendLabel} pointLabel={props.pointLabel} gaps={gaps} />
          <p className="tc-hint faint">Drag to pan · pinch to zoom · hold to scrub</p>
        </div>
        <div className="tc-list" ref={listRef} role="list" aria-label={`${title}: values shown, newest first`}>
          <div className="tc-list-head num">{vis.length} {kind === 'bar' && period >= WEEK ? (vis.length === 1 ? 'week' : 'weeks') : vis.length === 1 ? 'value' : 'values'}</div>
          {vis.map((i) => {
            const p = m.points[i]; const href = props.rowHref?.(p);
            return (
              <div key={p.key ?? i} role="listitem" className={'tc-row' + (i === sel ? ' on' : '')} data-i={i}>
                <button className="tc-row-main pressable" onClick={() => jump(i)} aria-current={i === sel ? 'true' : undefined}>
                  <span className="tc-row-txt">
                    <span className="tc-row-date num">{fmtDayShort(p.t)}</span>
                    {(p.caption || p.excluded || p.partial) && <span className="tc-row-cap num">{p.caption}{p.excluded ? `${p.caption ? ' · ' : ''}ignored by trend` : ''}{p.partial ? ' · so far' : ''}</span>}
                  </span>
                  {p.pr && <span className="badge good tc-badge"><Icon name="flag" size={11} />PR</span>}
                  <b className={'tc-row-v num' + (p.unreliable || p.excluded ? ' dimv' : '')}>{prefix(p)}{fmt(p.v)}</b>
                </button>
                {href && <Link className="icon-btn sm tc-row-go" to={href} aria-label={`Open ${fmtDayShort(p.t)}`}><Icon name="chevronRight" size={18} /></Link>}
              </div>
            );
          })}
          {!vis.length && <p className="faint" style={{ padding: 12 }}>No values in this range.</p>}
        </div>
      </div>
    </Sheet>
  );
}
