// One reusable time-series chart (line, dots or weekly bars) with a compact card mode and a maximized full-screen mode.
// Dataviz rules: one series in the role colour (title names it; legend only for the special marks that are present),
// a 2.5px monotone line (never overshoots, never invents values; scripts/check-series.mjs), soft gradient fill, ≥ 8px
// dots with a surface ring, hollow = lower bound (≥), dim = unreliable (≈), ringed = PR, hairline grid, text in text
// tokens. Honest gaps: no line across a pause longer than gapDays (a faint dashed hairline marks the break).
// Stamps: PR pills (de-cluttered: the highest + the newest, spaced), range high / low pills, a latest-value pill, and
// optional event stamps (journal entries, supplement periods) behind an "Events" chip.
// Headline: the value big + a delta pill (range change, or vs the previous point while one is selected), coloured by
// the metric's good direction (neutral when it has none).
// Gestures, compact: touch-and-hold (HOLD_MS) or a sideways drag starts a scrub (the page can't scroll during it, see
// the touchmove listener); a quick vertical swipe scrolls the page; a tap selects the nearest point (tap again = back
// to latest); lifting a scrub returns to the latest value (any tapped point too), like Apple Stocks / Health.
// Full screen: drag = pan (with momentum), pinch / wheel = zoom the time axis, tap = select, hold then drag = scrub
// (the scrubbed point stays selected, so the values list follows it).
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';
import { Link } from 'react-router';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { fmtAxis, niceTicks } from './Charts';
import { clampWindow, clusterByPx, DAY_MS, dropOverlaps, GAP_DAYS, monotonePath, pickPrStamps, segments, zoomWindow } from '../lib/series';

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
/** A dated event from the user's data (timeline.events): a single day (to undefined), a period (to = end ms) or ongoing (to null). */
export interface TEvent { id: string; kind: 'journal' | 'supplement'; label: string; t: number; to?: number | null; icon: string }
export type RangeKey = '1M' | '3M' | '6M' | '1Y' | 'All';
const RANGES: { key: RangeKey; days: number }[] = [{ key: '1M', days: 31 }, { key: '3M', days: 92 }, { key: '6M', days: 183 }, { key: '1Y', days: 366 }, { key: 'All', days: 0 }];

export interface TimeChartProps {
  title: string;
  note?: ReactNode;
  /** sorted oldest first */
  points: TPoint[];
  kind?: 'line' | 'dots' | 'bar';
  fmt: (v: number) => string;
  /** a smoothed line drawn over the points (weight trend); the headline delta uses it */
  trend?: { t: number; v: number }[];
  trendLabel?: string;
  /** label of the plain point mark in the legend when a trend is drawn ("Weigh-in") */
  pointLabel?: string;
  /** gradient fill under the main line (default on for line charts and for a trend) */
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
  /** event stamps (journal, supplement periods); toggled by the Events chip */
  events?: TEvent[];
  /** which way is better, for the delta pill colour (null / omitted = neutral) */
  good?: 'up' | 'down' | null;
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
const PAD = { l: 44, r: 14, t: 10, b: 24 };
const EV_LANE = 26; // room above the plot for event stamps
const WEEK = 7 * DAY_MS;
/** Touch-and-hold before a scrub starts (Apple Stocks / Health feel; dnd-kit uses the same idea for touch drags). */
export const HOLD_MS = 220;
/** Movement (px) that decides between a tap, a scrub (sideways) and a page scroll (vertical) before the hold fires. */
const SLOP = 8;
const PILL_H = 17;
// small trophy (24-unit grid), drawn in the PR stamps
const TROPHY = 'M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3M8.5 20.5h7M10 17h4v3.5h-4z';
const EV_KEY = 'tapin:chartEvents';
const readEvPref = () => { try { const v = localStorage.getItem(EV_KEY); return v == null ? null : v === '1'; } catch { return null; } };
const writeEvPref = (on: boolean) => { try { localStorage.setItem(EV_KEY, on ? '1' : '0'); } catch { /* private mode */ } };

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
/** "Jan" / "Jan '24" for long spans, "Oct 27" for short ones. */
const fmtSince = (t: number, spanDays: number) => {
  if (spanDays < 120) return fmtDayShort(t);
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short' }) + (d.getFullYear() === thisYear ? '' : ` ’${String(d.getFullYear()).slice(2)}`);
};
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
const inWin = (m: Model, win: [number, number]) => { const out: number[] = []; m.centers.forEach((c, i) => { if (c >= win[0] && c <= win[1]) out.push(i); }); return out; };

// ---------- geometry ----------
interface Geo {
  t0: number; t1: number; w: number; h: number; pw: number; ph: number; top: number;
  X: (t: number) => number; Y: (v: number) => number; vis: number[]; yr: { ticks: number[]; lo: number; hi: number };
}
function useGeo(m: Model, win: [number, number], w: number, h: number, opts: { trend?: { t: number; v: number }[]; zeroBased?: boolean; integer?: boolean; full: boolean; lane: boolean; stamps: boolean }): Geo {
  const { trend, zeroBased, integer, full, lane, stamps } = opts;
  return useMemo(() => {
    const [t0, t1] = win;
    const span = t1 - t0 || 1;
    const bar = m.kind === 'bar';
    const top = PAD.t + (lane ? EV_LANE : 0);
    const pw = w - PAD.l - PAD.r, ph = Math.max(40, h - top - PAD.b);
    const X = (t: number) => PAD.l + ((t - t0) / span) * pw;
    const vis: number[] = [];
    m.centers.forEach((c, i) => { if (c >= t0 - (bar ? m.period / 2 : 0) && c <= t1 + (bar ? m.period / 2 : 0)) vis.push(i); });
    // y range from what's on screen (excluded points never stretch it); extra headroom on top for the stamps
    const vs = vis.filter((i) => !m.points[i].excluded).map((i) => m.points[i].v);
    if (trend) for (const p of trend) if (p.t >= t0 && p.t <= t1) vs.push(p.v);
    let yr: Geo['yr'];
    if (!vs.length) yr = niceTicks(0, 1, 3);
    else {
      let lo = Math.min(...vs), hi = Math.max(...vs);
      if (bar || zeroBased) { lo = Math.min(0, lo); hi = Math.max(0, hi, integer ? 1 : 0); }
      const r = hi - lo;
      const pad = r * 0.08 || Math.abs(hi) * 0.05 || 1;
      const padTop = stamps ? (r * 0.22 || pad * 2) : pad;
      // domain = the data plus a little room (0 stays the floor for zero-based and all-positive data); ticks sit inside it
      const d0 = bar || zeroBased ? (lo < 0 ? lo - pad : 0) : lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
      const d1 = bar || zeroBased ? (hi > 0 ? hi + padTop : 0) : hi + padTop;
      const nt = niceTicks(d0, d1, full ? 5 : 4, integer ? 1 : 0);
      const inside = nt.ticks.filter((v) => v >= d0 - 1e-9 && v <= d1 + 1e-9);
      yr = inside.length >= 2 ? { ticks: inside, lo: d0, hi: d1 } : nt;
    }
    const Y = (v: number) => top + (1 - (v - yr.lo) / (yr.hi - yr.lo || 1)) * ph;
    return { t0, t1, w, h, pw, ph, top, X, Y, vis, yr };
  }, [m, win, w, h, trend, zeroBased, integer, full, lane, stamps]);
}

// ---------- the static layer (memoised: scrubbing never re-renders the marks) ----------
interface LayerProps {
  m: Model; g: Geo; gapDays: number; full: boolean; fmt: (v: number) => string; trend?: { t: number; v: number }[]; area: boolean;
  bands: TBand[]; markers: TMarker[]; events: TEvent[]; activeEv: string[] | null; evHits: { current: { x: number; ids: string[] }[] }; clipId: string;
}
const Layer = memo(function Layer({ m, g, gapDays, full, fmt, trend, area, bands, markers, events, activeEv, evHits, clipId }: LayerProps) {
  const { t0, t1, w, h, pw, ph, top, X, Y, vis, yr } = g;
  const bar = m.kind === 'bar';
  const span = t1 - t0 || 1;
  // entrance animation on first mount only (marks that appear later while panning / zooming don't replay it)
  const [intro, setIntro] = useState(true);
  useEffect(() => { const id = window.setTimeout(() => setIntro(false), 1300); return () => clearTimeout(id); }, []);
  const ticks = timeTicks(t0, t1, Math.max(2, Math.floor(pw / (full ? 64 : 56))));
  const base = top + ph;
  const px = (pts: { t: number; v: number }[]) => pts.map((p) => [X(p.t), Y(p.v)] as [number, number]);

  // ---- line segments (one point beyond each edge so lines run to the frame; clipped) ----
  const lines = (() => {
    if (m.kind !== 'line' || !vis.length) return { lines: [] as TPoint[][], breaks: [] as [TPoint, TPoint][] };
    const a = Math.max(0, vis[0] - 1), b = Math.min(m.points.length - 1, vis[vis.length - 1] + 1);
    const pts = m.points.slice(a, b + 1).filter((p) => !p.excluded);
    const ls = segments(pts, gapDays);
    const breaks: [TPoint, TPoint][] = [];
    for (let i = 1; i < ls.length; i++) breaks.push([ls[i - 1][ls[i - 1].length - 1], ls[i][0]]);
    return { lines: ls, breaks };
  })();
  const trendSegs = trend?.length ? segments(trend.filter((p) => p.t >= t0 - 60 * DAY_MS && p.t <= t1 + 60 * DAY_MS), gapDays) : [];
  const mainSegs: { t: number; v: number }[][] = m.kind === 'line' ? lines.lines : m.kind === 'dots' ? trendSegs : [];
  const fillPath = (s: { t: number; v: number }[]) => { const p = px(s); return `${monotonePath(p)}L${p[p.length - 1][0].toFixed(1)},${base}L${p[0][0].toFixed(1)},${base}Z`; };

  // ---- bands clamped to the plot; labels on alternating rows when they would collide ----
  let lastEnd = -Infinity, bandRow = 0;
  const bandLabels = bands.map((b) => ({ b, a: Math.max(PAD.l, X(b.from)), z: Math.min(PAD.l + pw, X(b.to)) })).filter((r) => r.z > r.a)
    .map((r) => { bandRow = r.a < lastEnd ? (bandRow + 1) % 2 : 0; lastEnd = r.a + Math.min(r.z - r.a, 120); return { ...r, row: bandRow }; });

  // ---- dots: all when there's room, else only the special ones (PR / excluded) ----
  const roomy = vis.length <= pw / (full ? 7 : 9);

  // ---- bars (rounded data end) ----
  const bandPx = (m.period / span) * pw;
  const bw = Math.max(1.5, Math.min(24, bandPx * 0.7));
  const col = (p: TPoint) => barPath(p, X, Y, m.period, bw);

  // ---- stamps: latest, highest (+PR), PRs (de-cluttered), lowest; one stamp per point; dropped when they'd overlap ----
  const pills = (() => {
    if (bar || !vis.length) return [];
    const live = vis.filter((i) => !m.points[i].excluded);
    if (!live.length) return [];
    const lastIdx = (() => { for (let i = m.points.length - 1; i >= 0; i--) if (!m.points[i].excluded) return i; return -1; })();
    const latest = live.includes(lastIdx) ? lastIdx : -1;
    let hiI = live[0], loI = live[0];
    for (const i of live) { if (m.points[i].v >= m.points[hiI].v) hiI = i; if (m.points[i].v < m.points[loI].v) loI = i; }
    const flat = m.points[hiI].v === m.points[loI].v;
    const prs = pickPrStamps(live.filter((i) => m.points[i].pr).map((i) => ({ i, x: X(m.points[i].t), v: m.points[i].v })), full ? 6 : 3, full ? 56 : 44);
    type Want = { i: number; text: string; kind: 'latest' | 'pr' | 'hi' | 'lo'; glyph: boolean; below: boolean };
    const want: Want[] = [];
    const seen = new Set<number>();
    const val = (i: number) => prefix(m.points[i]) + fmt(m.points[i].v);
    const add = (wnt: Want) => { if (!seen.has(wnt.i)) { seen.add(wnt.i); want.push(wnt); } };
    if (latest >= 0) add({ i: latest, text: val(latest), kind: 'latest', glyph: m.points[latest].pr === true, below: false });
    if (!flat && live.length >= 3) add({ i: hiI, text: val(hiI), kind: m.points[hiI].pr ? 'pr' : 'hi', glyph: m.points[hiI].pr === true, below: false });
    for (const i of [...prs].reverse()) add({ i, text: 'PR', kind: 'pr', glyph: true, below: false });
    if (!flat && live.length >= 3) add({ i: loI, text: val(loI), kind: 'lo', glyph: false, below: true });
    const rects = want.map((s) => {
      const p = m.points[s.i], cx = X(p.t), cy = Y(p.v);
      const pwid = Math.round(s.text.length * 6.1 + 14 + (s.glyph ? 11 : 0));
      let y = s.below ? cy + 9 : cy - 9 - PILL_H;
      if (!s.below && y < top - 4) y = cy + 9;
      if (s.below && y + PILL_H > base + 2) y = cy - 9 - PILL_H;
      const x = Math.max(2, Math.min(w - 2 - pwid, cx - pwid / 2));
      return { ...s, x, y, w: pwid, h: PILL_H };
    });
    return dropOverlaps(rects, 3).map((k) => rects[k]);
  })();

  // ---- event stamps (clustered when they'd overlap) ----
  const ev = (() => {
    if (!events.length) return { items: [] as { e: TEvent; a: number; z: number; band: boolean }[], clusters: [] as { x: number; ids: string[]; icon: string; n: number }[] };
    const now = Date.now();
    const items = events.map((e) => {
      const end = e.to === null ? now : e.to ?? e.t;
      return { e, a: X(e.t), z: X(end), band: e.to !== undefined && end - e.t >= DAY_MS };
    }).filter((r) => r.z >= PAD.l - 1 && r.a <= PAD.l + pw + 1);
    const xs = items.map((r) => Math.max(PAD.l + 9, Math.min(PAD.l + pw - 9, r.a)));
    const clusters = clusterByPx(xs, 20).map((ix) => ({ x: xs[ix[0]], ids: ix.map((k) => items[k].e.id), icon: items[ix[0]].e.icon, n: ix.length }));
    return { items, clusters };
  })();
  evHits.current = ev.clusters.map((c) => ({ x: c.x, ids: c.ids }));
  const isActive = (ids: string[]) => !!activeEv && ids.some((id) => activeEv.includes(id));

  return (
    <g className={'tc-layer' + (intro ? ' intro' : '')}>
      {bandLabels.map(({ b, a, z, row }, i) => (
        <g key={`b${i}`}>
          <rect x={a} y={top} width={Math.max(2, z - a)} height={ph} rx={4} fill={TONE[b.tone ?? 'neutral']} />
          <text x={a + 4} y={top + 11 + row * 13} className="tc-band-label" fill={TONE_TEXT[b.tone ?? 'neutral']}>{b.label.length > Math.max(4, (z - a) / 6) ? b.label.slice(0, Math.max(3, Math.floor((z - a) / 6))) + '…' : b.label}</text>
        </g>
      ))}
      {ev.items.filter((r) => r.band).map((r) => (
        <rect key={`eb${r.e.id}`} x={Math.max(PAD.l, r.a)} y={top} width={Math.max(2, Math.min(PAD.l + pw, r.z) - Math.max(PAD.l, r.a))} height={ph} rx={3}
          className={'tc-evband ' + r.e.kind + (isActive([r.e.id]) ? ' on' : '')} />
      ))}
      {yr.ticks.map((v) => (
        <g key={`y${v}`}>
          <line x1={PAD.l} x2={w - PAD.r} y1={Y(v)} y2={Y(v)} className={v === 0 && (bar || m.kind === 'line' && yr.lo === 0) ? 'chart-base' : 'chart-gridline tc-grid'} />
          <text x={PAD.l - 8} y={Y(v)} dy="0.32em" textAnchor="end" className="chart-tick">{fmtAxis(v)}</text>
        </g>
      ))}
      {ticks.map((tk) => {
        const x = X(tk.t); if (x < PAD.l - 1 || x > w - PAD.r + 1) return null;
        return <text key={`x${tk.t}`} x={Math.min(w - PAD.r - 14, Math.max(PAD.l + 14, x))} y={h - 6} textAnchor="middle" className="chart-tick">{tk.label}</text>;
      })}
      <g clipPath={`url(#${clipId})`}>
        {markers.map((mk, i) => { const x = X(mk.t); return x >= PAD.l && x <= PAD.l + pw ? <line key={`m${i}`} x1={x} x2={x} y1={top} y2={base} className="tc-marker" /> : null; })}
        {ev.items.map((r) => r.a >= PAD.l && r.a <= PAD.l + pw ? <line key={`el${r.e.id}`} x1={r.a} x2={r.a} y1={top} y2={base} className={'tc-evline' + (isActive([r.e.id]) ? ' on' : '')} /> : null)}
        {bar && vis.map((i) => <path key={m.points[i].key ?? i} d={col(m.points[i])} className={'chart-col tc-col' + (m.points[i].partial ? ' partial' : '')} />)}
        {lines.breaks.map(([a, b], i) => <line key={`g${i}`} x1={X(a.t)} y1={Y(a.v)} x2={X(b.t)} y2={Y(b.v)} className="tc-break" />)}
        {area && mainSegs.map((s, i) => s.length > 1 && <path key={`a${i}`} d={fillPath(s)} fill={`url(#${clipId}-fill)`} className="tc-area" />)}
        {lines.lines.map((s, i) => <path key={`l${i}`} d={monotonePath(px(s))} className="tc-line" pathLength={1} />)}
        {m.kind !== 'dots' && trendSegs.map((s, i) => <path key={`t${i}`} d={monotonePath(px(s))} className="tc-trend" pathLength={1} />)}
        <g className="tc-dots">
          {!bar && vis.map((i) => {
            const pt = m.points[i];
            if (pt.excluded) return <circle key={pt.key ?? i} cx={X(pt.t)} cy={Math.max(top, Math.min(base, Y(pt.v)))} r={3.5} className="tc-dot excluded" />;
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
        </g>
        {m.kind === 'dots' && trendSegs.map((s, i) => <path key={`t${i}`} d={monotonePath(px(s))} className="tc-trend" pathLength={1} />)}
        {trendSegs.slice(1).map((s, i) => { const a = trendSegs[i][trendSegs[i].length - 1], b = s[0]; return <line key={`tg${i}`} x1={X(a.t)} y1={Y(a.v)} x2={X(b.t)} y2={Y(b.v)} className="tc-break" />; })}
      </g>
      <g className="tc-stamps" aria-hidden>
        {pills.map((s) => (
          <g key={`s${s.i}`} className={'tc-pill ' + s.kind} transform={`translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`}>
            <rect width={s.w} height={PILL_H} rx={PILL_H / 2} />
            {s.glyph && <path d={TROPHY} transform="translate(5,3) scale(0.46)" className="tc-pill-glyph" />}
            <text x={s.glyph ? (s.w + 11) / 2 : s.w / 2} y={PILL_H / 2} dy="0.34em" textAnchor="middle">{s.text}</text>
          </g>
        ))}
        {ev.clusters.map((c) => (
          <g key={`ec${c.ids[0]}`} className={'tc-evstamp' + (isActive(c.ids) ? ' on' : '')} transform={`translate(${c.x.toFixed(1)},${PAD.t + 10})`}>
            <line x1={0} x2={0} y1={9} y2={top - PAD.t - 10} className="tc-evstem" />
            <circle r={10} />
            {c.n > 1 ? <text dy="0.34em" textAnchor="middle" className="tc-evcount">{c.n}</text>
              : <svg x={-6.5} y={-6.5} width={13} height={13} viewBox="0 0 24 24" className="tc-evicon"><path d={ICON_PATHS[c.icon] ?? ICON_PATHS.flag} /></svg>}
          </g>
        ))}
      </g>
      {!vis.length && <text x={PAD.l + pw / 2} y={top + ph / 2} textAnchor="middle" className="chart-tick">No data in this range</text>}
    </g>
  );
});
// icon outlines used inside the svg event stamps (same strokes as components/Icon)
const ICON_PATHS: Record<string, string> = {
  flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
  pill: 'M10.5 3.5a5 5 0 0 1 7 7l-7 7a5 5 0 0 1-7-7zM7 7l7 7',
  syringe: 'M18 2l4 4M20 4l-9.5 9.5M14 6l4 4M9.5 8.5l6 6M4 20l3-3M7 17l-1.5-1.5L14 7l3 3-8.5 8.5z',
  food: 'M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c-2 2-3 4.5-3 7.5 0 1.5 1 2.5 3 2.5v8',
  dumbbell: 'M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11',
  fire: 'M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3 1-5.5 1-7.5z',
};

function barPath(p: TPoint, X: (t: number) => number, Y: (v: number) => number, period: number, bw: number) {
  const x = X(p.t + period / 2) - bw / 2, end = Y(p.v), base = Y(0), h = Math.abs(base - end);
  if (h < 0.5) return '';
  const r = Math.min(5, bw / 2, h), sg = end < base ? 1 : -1; // +1 grows up, -1 grows down (negative value); rounded at the data end
  const f = (v: number) => v.toFixed(1);
  return `M${f(x)},${f(base)}V${f(end + sg * r)}Q${f(x)},${f(end)} ${f(x + r)},${f(end)}H${f(x + bw - r)}Q${f(x + bw)},${f(end)} ${f(x + bw)},${f(end + sg * r)}V${f(base)}Z`;
}

// ---------- the plot: layout + gestures + the selection overlay ----------
interface PlotProps extends Pick<TimeChartProps, 'fmt' | 'trend' | 'zeroBased' | 'integer' | 'title'> {
  m: Model; win: [number, number]; w: number; h: number; gapDays: number; full: boolean; area: boolean;
  bands: TBand[]; markers: TMarker[]; events: TEvent[]; activeEv: string[] | null;
  /** the highlighted point (-1 = none: no crosshair) */
  sel: number; scrubbing: boolean; animKey: string;
  onTap: (i: number) => void;
  onScrub: (i: number) => void;
  /** scrub / hover ended; commit = the point under the finger for a touch scrub (null for a mouse hover leaving) */
  onScrubEnd: (commit: number | null) => void;
  onEvent: (ids: string[]) => void;
  onWindow?: (w: [number, number]) => void;
}

function Plot(props: PlotProps) {
  const { m, win, w, h, gapDays, full, fmt, trend, area, zeroBased, integer, bands, markers, events, activeEv, sel, scrubbing, animKey, title } = props;
  const stamps = m.kind !== 'bar';
  const g = useGeo(m, win, w, h, { trend, zeroBased, integer, full, lane: events.length > 0, stamps });
  const clipId = useRef(`tc${Math.random().toString(36).slice(2, 8)}`).current;
  const evHits = useRef<{ x: number; ids: string[] }[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion();
  const live = useRef({ props, g });
  live.current = { props, g };

  const indexAt = useCallback((clientX: number) => {
    const el = svgRef.current; if (!el) return -1;
    const { props: { m: mm }, g: { t0, t1, pw } } = live.current;
    const r = el.getBoundingClientRect();
    const t = t0 + ((clientX - r.left - PAD.l) / pw) * (t1 - t0);
    return nearest(mm.centers, Math.max(t0, Math.min(t1, t)));
  }, []);
  const tapAt = (clientX: number, clientY: number) => {
    const el = svgRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const { g: gg, props: pp } = live.current;
    if (pp.events.length && clientY - r.top < gg.top + 2) { // the event-stamp lane
      const x = clientX - r.left;
      let best: { x: number; ids: string[] } | null = null;
      for (const c of evHits.current) if (Math.abs(c.x - x) <= 18 && (!best || Math.abs(c.x - x) < Math.abs(best.x - x))) best = c;
      if (best) { pp.onEvent(best.ids); return; }
    }
    const i = indexAt(clientX); if (i >= 0) pp.onTap(i);
  };

  type Ptr = { x: number; y: number };
  const s = useRef<{ ptrs: Map<number, Ptr>; mode: 'idle' | 'maybe' | 'pan' | 'scrub' | 'hover' | 'pinch' | 'done'; pid: number; startX: number; startY: number; lastX: number;
    startWin: [number, number]; hold?: number; pinch?: { d0: number; anchor: number; mid0: number }; hist: { x: number; t: number }[]; raf?: number; pickRaf?: number; lastPick: number }>({
    ptrs: new Map(), mode: 'idle', pid: -1, startX: 0, startY: 0, lastX: 0, startWin: win, hist: [], lastPick: -1 }).current;
  const stopMomentum = () => { if (s.raf) cancelAnimationFrame(s.raf); s.raf = undefined; };
  const clearHold = () => { if (s.hold) clearTimeout(s.hold); s.hold = undefined; };
  useEffect(() => () => { stopMomentum(); clearHold(); if (s.pickRaf) cancelAnimationFrame(s.pickRaf); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // scrub picks are coalesced to one per frame; state changes only when the snapped point changes
  const schedulePick = (x: number) => {
    s.lastX = x;
    if (s.pickRaf) return;
    s.pickRaf = requestAnimationFrame(() => {
      s.pickRaf = undefined;
      const i = indexAt(s.lastX);
      if (i >= 0 && i !== s.lastPick) { s.lastPick = i; live.current.props.onScrub(i); }
    });
  };
  const beginScrub = () => {
    clearHold();
    s.mode = 'scrub'; s.lastPick = -1;
    const el = svgRef.current;
    try { if (el && s.pid >= 0) el.setPointerCapture(s.pid); } catch { /* synthetic pointers */ }
    schedulePick(s.lastX);
  };
  const endScrub = (commit: boolean) => {
    if (s.pickRaf) { cancelAnimationFrame(s.pickRaf); s.pickRaf = undefined; }
    const i = commit ? indexAt(s.lastX) : -1;
    s.mode = 'idle'; s.lastPick = -1;
    live.current.props.onScrubEnd(i >= 0 ? i : null);
  };

  // Scroll lock for the scrub: React's touch listeners are passive, so a native non-passive one cancels touchmove once
  // the hold has fired (before that it does nothing, so a quick vertical swipe scrolls the page as usual).
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const tm = (e: TouchEvent) => { if (s.mode === 'scrub' && e.cancelable) e.preventDefault(); };
    el.addEventListener('touchmove', tm, { passive: false });
    return () => el.removeEventListener('touchmove', tm);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setWin = (a: number, b: number) => { const { props: { m: mm, onWindow: ow } } = live.current; ow?.(clampWindow(a, b, mm.lo, mm.hi, 7 * DAY_MS)); };
  const panBy = (dx: number, base: [number, number]) => { const k = (base[1] - base[0]) / live.current.g.pw; setWin(base[0] - dx * k, base[1] - dx * k); };

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopMomentum();
    if (s.mode === 'hover') endScrub(false);
    if (full) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
      s.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (s.ptrs.size === 2) {
        clearHold();
        if (s.mode === 'scrub') endScrub(false);
        const [p, q] = [...s.ptrs.values()];
        const r = e.currentTarget.getBoundingClientRect();
        const mid = (p.x + q.x) / 2;
        const { t0, t1, pw } = live.current.g;
        s.mode = 'pinch'; s.startWin = [t0, t1];
        s.pinch = { d0: Math.max(20, Math.abs(p.x - q.x)), mid0: mid, anchor: t0 + ((mid - r.left - PAD.l) / pw) * (t1 - t0) };
        return;
      }
    }
    s.mode = 'maybe'; s.pid = e.pointerId; s.startX = s.lastX = e.clientX; s.startY = e.clientY; s.startWin = [live.current.g.t0, live.current.g.t1];
    s.hist = [{ x: e.clientX, t: performance.now() }];
    if (e.pointerType !== 'mouse') s.hold = window.setTimeout(() => { if (s.mode === 'maybe') beginScrub(); }, HOLD_MS);
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && !e.buttons && (s.mode === 'idle' || s.mode === 'hover')) { s.mode = 'hover'; schedulePick(e.clientX); return; } // mouse hover scrubs
    if (full && !s.ptrs.has(e.pointerId)) return;
    if (full) s.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.mode === 'pinch' && s.pinch && s.ptrs.size >= 2) {
      const [p, q] = [...s.ptrs.values()];
      const d = Math.max(20, Math.abs(p.x - q.x));
      const { m: mm } = live.current.props;
      const [a, b] = zoomWindow(s.startWin[0], s.startWin[1], s.pinch.d0 / d, s.pinch.anchor, mm.lo, mm.hi);
      const dx = (p.x + q.x) / 2 - s.pinch.mid0; const k = (b - a) / live.current.g.pw;
      setWin(a - dx * k, b - dx * k);
      return;
    }
    if (e.pointerId !== s.pid) return;
    s.lastX = e.clientX;
    if (s.mode === 'maybe') {
      const dx = Math.abs(e.clientX - s.startX), dy = Math.abs(e.clientY - s.startY);
      if (full) { if (dx > SLOP) { s.mode = 'pan'; clearHold(); } }
      // compact: sideways = scrub right away (pan-y never pans sideways); vertical = let the page scroll, no capture
      else if (dx > SLOP && dx > dy) beginScrub();
      else if (dy > SLOP) { s.mode = 'idle'; clearHold(); }
    }
    if (s.mode === 'scrub') schedulePick(e.clientX);
    if (s.mode === 'pan') {
      panBy(e.clientX - s.startX, s.startWin);
      s.hist.push({ x: e.clientX, t: performance.now() }); if (s.hist.length > 6) s.hist.shift();
    }
  };
  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    const cancel = e.type === 'pointercancel';
    if (full) {
      s.ptrs.delete(e.pointerId);
      const was = s.mode;
      if (was === 'pinch' || was === 'done') { s.mode = s.ptrs.size ? 'done' : 'idle'; return; } // lifting from a pinch is never a tap
      if (s.ptrs.size) return;
    }
    if (e.pointerId !== s.pid && s.mode !== 'hover') return;
    clearHold();
    const was = s.mode;
    if (was === 'scrub') { endScrub(!cancel); return; }
    s.mode = 'idle';
    if (cancel) return;
    if (was === 'maybe') { tapAt(e.clientX, e.clientY); return; } // a tap
    if (full && was === 'pan' && !reduce && s.hist.length >= 2) {
      // momentum: continue at the release velocity, decaying like a scroll view (apple-design §6, d = 0.998 per ms)
      const a = s.hist[0], b = s.hist[s.hist.length - 1];
      let v = (b.x - a.x) / Math.max(1, b.t - a.t); // px / ms
      if (performance.now() - b.t > 80 || Math.abs(v) < 0.05) return;
      let last = performance.now();
      const step = (now: number) => {
        const dt = now - last; last = now;
        v *= Math.pow(0.998, dt);
        if (Math.abs(v) < 0.02) { s.raf = undefined; return; }
        panBy(v * dt, [live.current.g.t0, live.current.g.t1]);
        s.raf = requestAnimationFrame(step);
      };
      s.raf = requestAnimationFrame(step);
    }
  };
  const onLeave = (e: RPointerEvent<SVGSVGElement>) => { if (e.pointerType === 'mouse' && s.mode === 'hover') endScrub(false); };

  // wheel / trackpad (full screen): vertical = zoom around the cursor, horizontal = pan (needs a non-passive listener)
  useEffect(() => {
    const el = svgRef.current; if (!el || !full) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); stopMomentum();
      const { g: { t0, t1, pw }, props: { m: mm } } = live.current;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { panBy(-(e.deltaX || e.deltaY), [t0, t1]); return; }
      const r = el.getBoundingClientRect();
      const anchor = t0 + ((e.clientX - r.left - PAD.l) / pw) * (t1 - t0);
      live.current.props.onWindow?.(zoomWindow(t0, t1, Math.exp(e.deltaY * 0.002), anchor, mm.lo, mm.hi));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [full]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = sel >= 0 ? m.points[sel] : undefined;
  const selIn = !!p && m.centers[sel] >= g.t0 && m.centers[sel] <= g.t1;
  const sx = p ? g.X(m.centers[sel]) : 0;
  const sy = p ? Math.max(g.top, Math.min(g.top + g.ph, g.Y(p.v))) : 0;
  const bar = m.kind === 'bar';
  const nVis = g.vis.length;
  const latest = m.points[m.points.length - 1];
  const bw = Math.max(1.5, Math.min(24, (m.period / (g.t1 - g.t0 || 1)) * g.pw * 0.7));

  return (
    <svg ref={svgRef} width={w} height={h} className={'chart-svg tc-svg' + (full ? ' full' : '') + (selIn ? ' has-sel' : '') + (scrubbing ? ' scrubbing' : '')} role="group" tabIndex={0}
      aria-label={`${title}. ${nVis} ${nVis === 1 ? 'point' : 'points'} shown${latest ? `, latest ${prefix(latest)}${fmt(latest.v)} on ${fmtDayLong(latest.t)}` : ''}. Left and right arrow keys step through them${full ? '; plus and minus zoom' : ''}.`}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onLeave}
      onContextMenu={(e) => e.preventDefault()}>
      <defs>
        <clipPath id={clipId}><rect x={PAD.l - 6} y={0} width={g.pw + 12} height={h - PAD.b + 2} /></clipPath>
        <linearGradient id={`${clipId}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="tc-fill-stop" stopOpacity="0.32" /><stop offset="0.75" className="tc-fill-stop" stopOpacity="0.06" /><stop offset="1" className="tc-fill-stop" stopOpacity="0" /></linearGradient>
      </defs>
      <Layer key={animKey} m={m} g={g} gapDays={gapDays} full={full} fmt={fmt} trend={trend} area={area} bands={bands} markers={markers} events={events} activeEv={activeEv} evHits={evHits} clipId={clipId} />
      {selIn && p && (
        <g pointerEvents="none" className={'tc-sel' + (scrubbing ? ' scrub' : '')}>
          {bar && <path d={barPath(p, g.X, g.Y, m.period, bw)} className="chart-col tc-col on" />}
          <g className="tc-cross" style={{ transform: `translateX(${sx.toFixed(1)}px)` }}><line x1={0} x2={0} y1={g.top} y2={g.top + g.ph} className="chart-cross" /></g>
          {!bar && (
            <g className="tc-seldot" style={{ transform: `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)` }}>
              <g key={sel} className="tc-pop">
                <circle r={12} className="tc-halo" />
                <circle r={5.5} className={'tc-dot on' + (p.lowerBound ? ' hollow' : '') + (p.unreliable ? ' dim' : '') + (p.excluded ? ' excluded' : '')} />
              </g>
            </g>
          )}
        </g>
      )}
    </svg>
  );
}

// ---------- headline / readout ----------
type Delta = { d: number; since?: string; approx: boolean } | null;
function DeltaPill({ delta, good, fmt }: { delta: Delta; good?: 'up' | 'down' | null; fmt: (v: number) => string }) {
  if (!delta) return null;
  const { d, since, approx } = delta;
  const zero = Math.abs(d) < 1e-9 || fmt(Math.abs(d)) === fmt(0);
  const tone = zero || !good ? 'neutral' : (d > 0) === (good === 'up') ? 'good' : 'bad';
  return (
    <span className={'tc-delta num ' + tone}>
      <span aria-hidden>{zero ? '=' : d > 0 ? '▲' : '▼'}</span>
      <span className="sr-only">{zero ? 'no change' : d > 0 ? 'up' : 'down'} </span>
      {approx && !zero ? '≈' : ''}{zero ? fmt(0) : fmt(Math.abs(d))}
      {since ? <span className="tc-since"> since {since}</span> : <span className="tc-since"> vs prev<span className="sr-only">ious</span></span>}
    </span>
  );
}

function Headline({ m, idx, mode, fmt, bar, barDateLabel, bands, markers, events, activeEv, rangeDelta, good, period }: {
  m: Model; idx: number; mode: 'idle' | 'sel' | 'scrub'; fmt: (v: number) => string; bar: boolean; barDateLabel?: string; bands?: TBand[]; markers?: TMarker[];
  events: TEvent[]; activeEv: string[] | null; rangeDelta: Delta; good?: 'up' | 'down' | null; period: number;
}) {
  const p = m.points[idx];
  if (!p) return <div className="chart-readout tc-head2" aria-live="polite"><span className="tc-sub">No data</span></div>;
  // vs the previous (non-excluded) point when one is picked
  let delta: Delta = rangeDelta;
  if (mode !== 'idle' || bar) {
    let j = idx - 1; while (j >= 0 && m.points[j].excluded) j--;
    const q = j >= 0 ? m.points[j] : undefined;
    delta = q && !p.excluded ? { d: p.v - q.v, approx: !!(p.lowerBound || p.unreliable || q.lowerBound || q.unreliable) } : null;
  }
  const tags = [...(bands ?? []).filter((b) => p.t >= b.from && p.t <= b.to).map((b) => b.label), ...(markers ?? []).filter((mk) => Math.abs(mk.t - p.t) < (bar ? period : DAY_MS)).map((mk) => mk.label)].slice(0, 2);
  const evs = activeEv ? events.filter((e) => activeEv.includes(e.id)) : [];
  const date = bar ? [barDateLabel ?? 'Week of', fmtDayShort(p.t)].filter(Boolean).join(' ') : fmtDayLong(p.t);
  return (
    <div className={'chart-readout tc-head2' + (mode === 'scrub' ? ' scrub' : '')} aria-live={mode === 'scrub' ? 'off' : 'polite'}>
      <div className="tc-hl">
        <b className="num tc-value">{prefix(p)}{fmt(p.v)}</b>
        <DeltaPill delta={delta} good={good} fmt={fmt} />
        {p.pr && <span className="badge good tc-badge"><TrophyIcon />PR</span>}
      </div>
      <div className="tc-sub">
        {evs.length ? (
          <span className="tc-evtext"><Icon name={evs[0].icon} size={13} stroke={2} /> {evs.map((e) => `${e.label} · ${evRange(e)}`).join('  ·  ')}</span>
        ) : (
          <>
            <span>{mode === 'idle' && !bar ? 'Latest · ' : ''}{date}{p.caption ? ` · ${p.caption}` : ''}{p.partial ? ' · so far' : ''}{p.excluded ? ' · ignored by trend' : ''}</span>
            {tags.map((t) => <span key={t} className="dreadout-tag">{t}</span>)}
          </>
        )}
      </div>
    </div>
  );
}
const evRange = (e: TEvent) => (e.to === undefined ? fmtDayShort(e.t) : `${fmtDayShort(e.t)} – ${e.to === null ? 'now' : fmtDayShort(e.to)}`);
const TrophyIcon = () => <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={TROPHY} /></svg>;

/** Change over the window: first → last trend value when there is a trend (the honest weight change), else first → last point. */
function useRangeDelta(m: Model, win: [number, number], trend?: { t: number; v: number }[]): Delta {
  return useMemo(() => {
    if (m.kind === 'bar') return null;
    const spanDays = (win[1] - win[0]) / DAY_MS;
    if (trend?.length) {
      const tv = trend.filter((p) => p.t >= win[0] && p.t <= win[1]);
      if (tv.length < 2) return null;
      return { d: tv[tv.length - 1].v - tv[0].v, since: fmtSince(tv[0].t, spanDays), approx: false };
    }
    const vis = inWin(m, win).filter((i) => !m.points[i].excluded);
    if (vis.length < 2) return null;
    const a = m.points[vis[0]], b = m.points[vis[vis.length - 1]];
    return { d: b.v - a.v, since: fmtSince(a.t, spanDays), approx: !!(a.lowerBound || a.unreliable || b.lowerBound || b.unreliable) };
  }, [m, win, trend]);
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

/** Event chips under the chart (44px targets, keyboard reachable): the same events as the stamps in view. */
function EventChips({ events, win, activeEv, onPick }: { events: TEvent[]; win: [number, number]; activeEv: string[] | null; onPick: (ids: string[]) => void }) {
  const now = Date.now();
  const shown = events.filter((e) => e.t <= win[1] && (e.to === null ? now : e.to ?? e.t) >= win[0]).slice(-8).reverse();
  if (!shown.length) return null;
  return (
    <div className="dmarkers tc-evchips" role="group" aria-label="Events in view">
      {shown.map((e) => (
        <button key={e.id} className={'dmarker-chip tc-evchip ' + e.kind} aria-pressed={!!activeEv?.includes(e.id)} onClick={() => onPick([e.id])}>
          <Icon name={e.icon} size={14} stroke={2} />{e.label}<span className="faint num">{fmtDayShort(e.t)}</span>
        </button>
      ))}
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
  const [scrub, setScrub] = useState<number | null>(null);
  const [activeEv, setActiveEv] = useState<string[] | null>(null);
  const [full, setFull] = useState(false);
  const events = useMemo(() => props.events ?? [], [props.events]);
  const evInView = useMemo(() => events.filter((e) => e.t <= win[1] && (e.to === null ? Date.now() : e.to ?? e.t) >= win[0]).length, [events, win]);
  const [evPref, setEvPref] = useState<boolean | null>(readEvPref);
  const evOn = events.length > 0 && (evPref ?? evInView <= 6); // busy charts start clean
  const shownEvents = evOn ? events : NO_EVENTS;
  // default: the latest point in view (bars: the latest non-empty one; an empty week in progress says little)
  const lastInView = useMemo(() => {
    let any = -1;
    for (let i = m.centers.length - 1; i >= 0; i--) if (m.centers[i] <= win[1] && m.centers[i] >= win[0]) { if (any < 0) any = i; if (kind !== 'bar' || m.points[i].v > 0) return i; }
    return any >= 0 ? any : m.points.length - 1;
  }, [m, win, kind]);
  const sel = selRaw != null && selRaw < m.points.length ? selRaw : null;
  const shown = scrub ?? sel ?? lastInView;
  const mode = scrub != null ? 'scrub' : sel != null ? 'sel' : 'idle';
  useEffect(() => { setSel(null); setScrub(null); }, [points.length, points[0]?.t, points[points.length - 1]?.t]);
  const onKey = (e: KeyboardEvent) => {
    const cur = sel ?? lastInView;
    const n = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? m.points.length - 1 : e.key === 'Escape' ? -1 : null;
    if (n == null) return; e.preventDefault(); setSel(n < 0 ? null : Math.max(0, Math.min(m.points.length - 1, n)));
  };
  const visPts = useMemo(() => points.filter((_, i) => m.centers[i] >= win[0] && m.centers[i] <= win[1]), [points, m, win]);
  const gaps = useMemo(() => segments(visPts.filter((p) => !p.excluded), gapDays).length > 1, [visPts, gapDays]);
  const rangeDelta = useRangeDelta(m, win, trend);
  const area = props.area ?? (kind === 'line' || (kind === 'dots' && !!trend?.length));
  const pickEv = (ids: string[]) => setActiveEv((cur) => (cur && cur.join() === ids.join() ? null : ids));
  const toggleEv = () => { const next = !evOn; setEvPref(next); writeEvPref(next); if (!next) setActiveEv(null); };

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
      <Headline m={m} idx={shown} mode={mode} fmt={fmt} bar={kind === 'bar'} barDateLabel={props.barDateLabel} bands={props.bands} markers={props.markers}
        events={events} activeEv={activeEv} rangeDelta={rangeDelta} good={props.good} period={period} />
      <div ref={ref} className="chart" onKeyDown={onKey}>
        {points.length ? <Plot m={m} win={win} w={size.w} h={height + (shownEvents.length ? EV_LANE : 0)} sel={scrub ?? sel ?? -1} scrubbing={scrub != null} gapDays={gapDays} full={false} fmt={fmt} trend={trend} area={area}
          zeroBased={zeroBased} integer={integer} bands={props.bands ?? NO_BANDS} markers={props.markers ?? NO_MARKERS} events={shownEvents} activeEv={activeEv} title={title} animKey={title}
          onTap={(i) => { setActiveEv(null); setSel((c) => (c === i ? null : i)); }} onScrub={setScrub} onScrubEnd={() => { setScrub(null); setSel(null); }} onEvent={pickEv} />
          : <div className="chart-empty">No data yet</div>}
      </div>
      <div className="tc-foot">
        <RangeChips value={range} onChange={(r) => { setRange(r); setSel(null); }} label={title} />
        {events.length > 0 && <button className="tc-evtoggle" aria-pressed={evOn} onClick={toggleEv} aria-label="Show events"><Icon name="flag" size={15} stroke={2.2} /><span>Events</span></button>}
      </div>
      <Legend points={visPts} kind={kind} trend={trend} trendLabel={props.trendLabel} pointLabel={props.pointLabel} gaps={gaps} />
      {evOn && <EventChips events={events} win={win} activeEv={activeEv} onPick={pickEv} />}
      {!!props.markers?.length && (
        <div className="dmarkers">{props.markers.slice(0, 6).map((mk, i) => (
          <button key={i} className="dmarker-chip" onClick={() => { const j = nearest(m.centers, mk.t); if (j >= 0) setSel(j); }}><i />{fmtDayShort(mk.t)} · {mk.label}</button>
        ))}</div>
      )}
      <FullChart open={full} onClose={() => setFull(false)} props={props} m={m} startWin={win} startRange={range} sel={sel ?? lastInView} setSel={setSel}
        events={shownEvents} allEvents={events} area={area} />
    </>
  );
  if (bare) return <div className={'tc ' + (className ?? '')}>{body}</div>;
  return <section className={'card chart-card tc ' + (className ?? '')} aria-label={title}>{body}</section>;
}
const NO_EVENTS: TEvent[] = [];
const NO_BANDS: TBand[] = [];
const NO_MARKERS: TMarker[] = [];

// ---------- maximized ----------
function FullChart({ open, onClose, props, m, startWin, startRange, sel, setSel, events, allEvents, area }: {
  open: boolean; onClose: () => void; props: TimeChartProps; m: Model; startWin: [number, number]; startRange: RangeKey; sel: number; setSel: (i: number | null) => void;
  events: TEvent[]; allEvents: TEvent[]; area: boolean;
}) {
  const { title, fmt, trend, kind = 'line', gapDays = GAP_DAYS, period = WEEK } = props;
  const [win, setWin] = useState<[number, number]>(startWin);
  const [range, setRange] = useState<RangeKey | null>(startRange);
  const [scrub, setScrub] = useState<number | null>(null);
  const [activeEv, setActiveEv] = useState<string[] | null>(null);
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) { setWin(startWin); setRange(startRange); setScrub(null); setActiveEv(null); } }
  const [ref, size] = useSize<HTMLDivElement>();
  const listRef = useRef<HTMLDivElement>(null);
  const fromList = useRef(false);
  const vis = useMemo(() => inWin(m, win).reverse(), [m, win]);
  const gaps = useMemo(() => segments(vis.map((i) => m.points[i]).filter((p) => !p.excluded).reverse(), gapDays).length > 1, [vis, m, gapDays]);
  const rangeDelta = useRangeDelta(m, win, trend);
  const shown = scrub ?? sel;
  const select = (i: number) => { fromList.current = false; setActiveEv(null); setSel(i); };
  // keep the selected row in view when the crosshair moves (not when the row itself was tapped)
  useEffect(() => {
    if (!open || fromList.current) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${shown}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [shown, open]);
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
          <Headline m={m} idx={shown} mode={scrub != null ? 'scrub' : 'sel'} fmt={fmt} bar={kind === 'bar'} barDateLabel={props.barDateLabel} bands={props.bands} markers={props.markers}
            events={allEvents} activeEv={activeEv} rangeDelta={rangeDelta} good={props.good} period={period} />
          <div ref={ref} className="chart tc-full-plot" onKeyDown={onKey}>
            {size.h > 40 && <Plot m={m} win={win} w={size.w} h={size.h} sel={shown} scrubbing={scrub != null} gapDays={gapDays} full fmt={fmt} trend={trend} area={area}
              zeroBased={props.zeroBased} integer={props.integer} bands={props.bands ?? NO_BANDS} markers={props.markers ?? NO_MARKERS} events={events} activeEv={activeEv} title={title} animKey="full"
              onTap={select} onScrub={setScrub} onScrubEnd={(c) => { setScrub(null); if (c != null) select(c); }} onEvent={(ids) => setActiveEv((cur) => (cur && cur.join() === ids.join() ? null : ids))}
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
              <div key={p.key ?? i} role="listitem" className={'tc-row' + (i === shown ? ' on' : '')} data-i={i}>
                <button className="tc-row-main pressable" onClick={() => jump(i)} aria-current={i === shown ? 'true' : undefined}>
                  <span className="tc-row-txt">
                    <span className="tc-row-date num">{fmtDayShort(p.t)}</span>
                    {(p.caption || p.excluded || p.partial) && <span className="tc-row-cap num">{p.caption}{p.excluded ? `${p.caption ? ' · ' : ''}ignored by trend` : ''}{p.partial ? ' · so far' : ''}</span>}
                  </span>
                  {p.pr && <span className="badge good tc-badge"><TrophyIcon />PR</span>}
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
