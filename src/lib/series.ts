// Time-series helpers for the progress charts (progress.exerciseSeries, bodyweight.series, components/TimeChart).
// Pure (no db / browser APIs; erasable TS, `.ts` imports) so scripts/check-series.mjs runs it in Node.
// Formulas are listed in docs/SPEC.md → "Science sources" (e1RM / 10RM rows).
import { nRepMax } from './science.ts';

export const DAY_MS = 864e5;
/** A pause longer than this (days) breaks a chart line: no line is drawn across it, so a 3-month break never looks
 *  like a smooth decline. Our own display rule (a convention, not from a study). */
export const GAP_DAYS = 42;

/** Reps the "e10RM" metric is defined at. */
export const E10_REPS = 10;
/** e10RM = estimated 10-rep max: the load you could lift for exactly 10 reps to failure, from the same Wathen model as
 *  e1RM, inverted (science.ts nRepMax): e10RM = e1RM × (0.488 + 0.538·e^(−0.075·10)) ≈ 0.742 × e1RM. It carries the
 *  same flags as the e1RM it comes from (≥ lower bound when no RIR was logged, ≈ past 12 reps to failure). */
export const e10rm = (e1rmKg: number) => nRepMax(e1rmKg, E10_REPS);

/** Monday 00:00 (local) of the week containing ts — the app's week convention (Home week strip, progress.weekly). */
export function weekStartMs(ts: number) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime();
}
/** Monday of the following week. DST-safe: jump 8 days (lands on Tuesday whatever the clock change) and snap back. */
export const nextWeekStart = (ws: number) => weekStartMs(ws + 8 * DAY_MS);

/** ISO-8601 week label ("2025-W01"): the week belongs to the year of its Thursday, so Dec 29 2025 → 2026-W01. */
export function isoWeekLabel(ts: number) {
  const d = new Date(weekStartMs(ts)); d.setDate(d.getDate() + 3); // Thursday of this week
  const year = d.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week = 1 + Math.round((weekStartMs(d.getTime()) - weekStartMs(jan4.getTime())) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Local calendar date key YYYY-MM-DD. */
export const localKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** One session's per-week contribution. */
export interface WeekInput { t: number; volumeKg: number; hardSets: number; totalReps: number }
export interface WeekRow { weekStart: string; isoWeek: string; t: number; sessions: number; volumeKg: number; hardSets: number; totalReps: number; inProgress: boolean }
/** Per-week sums, every week from the first session's week to the week containing `until` (default the last session),
 *  empty weeks included as zeros (a week without training is a real 0, not missing data). Sets are summed per session
 *  (never pooled across sessions: slot keys repeat between sessions of the same plan workout). */
export function weeklyBuckets(rows: WeekInput[], until?: number, now = Date.now()): WeekRow[] {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const last = weekStartMs(Math.max(sorted[sorted.length - 1].t, until ?? -Infinity));
  const cur = weekStartMs(now);
  const out: WeekRow[] = [];
  let i = 0;
  for (let ws = weekStartMs(sorted[0].t); ws <= last; ws = nextWeekStart(ws)) {
    const next = nextWeekStart(ws);
    const w: WeekRow = { weekStart: localKey(ws), isoWeek: isoWeekLabel(ws), t: ws, sessions: 0, volumeKg: 0, hardSets: 0, totalReps: 0, inProgress: ws === cur };
    while (i < sorted.length && sorted[i].t < next) { const r = sorted[i++]; w.sessions++; w.volumeKg += r.volumeKg; w.hardSets += r.hardSets; w.totalReps += r.totalReps; }
    out.push(w);
  }
  return out;
}

/** true at every index that starts a new line segment (the gap before it is longer than gapDays). */
export function gapStarts(ts: number[], gapDays = GAP_DAYS): boolean[] {
  return ts.map((t, i) => i > 0 && t - ts[i - 1] > gapDays * DAY_MS);
}
/** Points split into segments at long gaps (sorted by t). */
export function segments<T extends { t: number }>(pts: T[], gapDays = GAP_DAYS): T[][] {
  const out: T[][] = [];
  const starts = gapStarts(pts.map((p) => p.t), gapDays);
  pts.forEach((p, i) => { if (i === 0 || starts[i]) out.push([]); out[out.length - 1].push(p); });
  return out;
}

/** PR flag for a metric with no dedicated PR rule (volume, total reps, sets): true where the value beats every earlier
 *  one. Never on the first value (same as the app's PRs: no PR the first time). null values are skipped. */
export function runningBest(values: (number | null)[]): boolean[] {
  let best = -Infinity, seen = false;
  return values.map((v) => {
    if (v == null) return false;
    const pr = seen && v > best + 1e-9;
    if (v > best) best = v;
    seen = true;
    return pr;
  });
}

/** Viewport helpers for the chart: clamp a [t0, t1] window inside [lo, hi] keeping its width (min width minSpan). */
export function clampWindow(t0: number, t1: number, lo: number, hi: number, minSpan = 7 * DAY_MS): [number, number] {
  let w = Math.max(minSpan, t1 - t0);
  const full = hi - lo;
  if (w >= full) return [lo, hi];
  if (t0 < lo) { t0 = lo; t1 = lo + w; }
  else if (t0 + w > hi) { t1 = hi; t0 = hi - w; }
  else t1 = t0 + w;
  return [t0, t1];
}
/** Zoom a window by factor k (< 1 = zoom in) around the anchor time. */
export function zoomWindow(t0: number, t1: number, k: number, anchor: number, lo: number, hi: number, minSpan = 7 * DAY_MS): [number, number] {
  const w = Math.min(hi - lo, Math.max(minSpan, (t1 - t0) * k));
  const f = (anchor - t0) / (t1 - t0 || 1);
  return clampWindow(anchor - f * w, anchor - f * w + w, lo, hi, minSpan);
}

// ---------- drawing helpers (pure; checked in scripts/check-series.mjs) ----------

/** Tangents for a monotone cubic through (xs, ys) (Fritsch–Butland weighted harmonic mean, as Fritsch–Carlson): a local
 *  extremum gets a flat tangent and every tangent is at most 3× the smaller neighbouring slope, so the curve never
 *  overshoots: between two points it stays inside their y range. xs must be non-decreasing. */
export function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length, dx: number[] = [], m: number[] = [], t: number[] = Array.from({ length: n }, () => 0);
  if (n < 2) return t;
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i]; m[i] = dx[i] ? (ys[i + 1] - ys[i]) / dx[i] : 0; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0 || !dx[i - 1] || !dx[i] ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  }
  // end tangents: keep them inside the monotone region too (α ≤ 3 with the neighbour's tangent)
  if (m[0] === 0 || Math.sign(t[0]) !== Math.sign(m[0])) t[0] = 0;
  if (m[n - 2] === 0 || Math.sign(t[n - 1]) !== Math.sign(m[n - 2])) t[n - 1] = 0;
  return t;
}
/** The cubic Bézier control points between point i and i+1 for the monotone curve (Hermite → Bézier, h = dx / 3). */
export function monotoneSegments(p: [number, number][]): { a: [number, number]; c1: [number, number]; c2: [number, number]; b: [number, number] }[] {
  const t = monotoneTangents(p.map((q) => q[0]), p.map((q) => q[1]));
  const out = [];
  for (let i = 0; i < p.length - 1; i++) {
    const h = (p[i + 1][0] - p[i][0]) / 3;
    out.push({ a: p[i], c1: [p[i][0] + h, p[i][1] + h * t[i]] as [number, number], c2: [p[i + 1][0] - h, p[i + 1][1] - h * t[i + 1]] as [number, number], b: p[i + 1] });
  }
  return out;
}
/** SVG path for a smooth monotone line through pixel points (sorted by x). Never invents values: it passes through every
 *  point and never overshoots between two of them. 1–2 points → straight. */
export function monotonePath(p: [number, number][]): string {
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  if (!p.length) return '';
  if (p.length < 3) return p.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)},${f(y)}`).join('');
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (const s of monotoneSegments(p)) d += `C${f(s.c1[0])},${f(s.c1[1])} ${f(s.c2[0])},${f(s.c2[1])} ${f(s.b[0])},${f(s.b[1])}`;
  return d;
}

/** PR stamp de-cluttering. Candidates are the PR points in view ({i, x px, v}). Keeps at most `max` stamps: the highest
 *  value first (the record that matters), then the newest ones, skipping any closer than minGapPx to one already kept.
 *  The rest stay as plain rings. Returns the kept indices, oldest first. */
export function pickPrStamps(cands: { i: number; x: number; v: number }[], max: number, minGapPx: number): number[] {
  if (!cands.length || max <= 0) return [];
  const kept: { i: number; x: number }[] = [];
  const top = cands.reduce((a, b) => (b.v > a.v || (b.v === a.v && b.i > a.i) ? b : a));
  kept.push(top);
  for (let k = cands.length - 1; k >= 0 && kept.length < max; k--) {
    const c = cands[k];
    if (kept.some((q) => q.i === c.i || Math.abs(q.x - c.x) < minGapPx)) continue;
    kept.push(c);
  }
  return kept.map((q) => q.i).sort((a, b) => a - b);
}

/** Label placement by priority: rects in priority order; a rect overlapping (with `pad` px of air) one already placed is
 *  dropped. Returns the indices kept. */
export function dropOverlaps(rects: { x: number; y: number; w: number; h: number }[], pad = 2): number[] {
  const kept: number[] = [];
  rects.forEach((r, i) => {
    const hit = kept.some((k) => { const q = rects[k]; return r.x < q.x + q.w + pad && q.x < r.x + r.w + pad && r.y < q.y + q.h + pad && q.y < r.y + r.h + pad; });
    if (!hit) kept.push(i);
  });
  return kept;
}

/** Groups sorted pixel positions into clusters: a position closer than minGap to the previous one joins its cluster
 *  (event stamps that would overlap become one stamp with a count). Returns arrays of input indices. */
export function clusterByPx(xs: number[], minGap: number): number[][] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out: number[][] = [];
  let last = -Infinity;
  for (const [x, i] of order) { if (out.length && x - last < minGap) out[out.length - 1].push(i); else out.push([i]); last = x; }
  return out;
}
