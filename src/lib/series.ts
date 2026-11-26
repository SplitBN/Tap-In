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
