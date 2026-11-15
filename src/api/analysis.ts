import { z } from 'zod';
import { defineCommand, zDate } from './registry';
import { alive, db } from '../db/db';
import type { SetLog } from '../db/types';
import { e1rm, totalLoadKg } from '../lib/science';
import { welch } from '../lib/stats';
import { dateKey, keyToDate, sum } from '../lib/nutrition';

const TABLES = ['exercises', 'plans', 'workouts', 'sessions', 'sets', 'bodyweight', 'foods', 'entries', 'days', 'goals', 'supplements', 'stacks', 'supplogs', 'notes'] as const;

/** Generic read access so an agent can "see all": raw records of any table, optionally filtered. */
export const dataQuery = defineCommand({ name: 'data.query', kind: 'query',
  description: `Read raw records from any table (${TABLES.join(', ')}). where = exact field matches; from/to filter by the table's date (entries/supplogs: date; sessions: startedAt; bodyweight: at; notes: at; sets: doneAt). Use when no specific command fits. Bundled food databases are searched with foods.search instead.`,
  input: z.object({ table: z.enum(TABLES), where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    from: zDate.optional(), to: zDate.optional(), limit: z.number().int().min(1).max(2000).default(200) }),
  run: async ({ table, where, from, to, limit }) => {
    const lo = from ? keyToDate(from).getTime() : -Infinity; const hi = to ? keyToDate(to).getTime() + 86400000 : Infinity;
    const timeField: Record<string, string> = { sessions: 'startedAt', bodyweight: 'at', notes: 'at', sets: 'doneAt' };
    const rows = await db.table(table).filter((r: Record<string, unknown>) => {
      if (r.deletedAt) return false;
      if (where && !Object.entries(where).every(([k, v]) => r[k] === v)) return false;
      if (table === 'entries' || table === 'supplogs') { const d = r.date as string; if ((from && d < from) || (to && d > to)) return false; }
      else if (timeField[table] && (from || to)) { const t = r[timeField[table]] as number; if (!(t >= lo && t < hi)) return false; }
      return true;
    }).limit(limit).toArray();
    return rows.map(({ deletedAt: _d, ...rest }: Record<string, unknown>) => rest);
  } });

/** Per-day metric series for analysis. */
async function series(metric: 'e1rm' | 'bodyweight' | 'kcal' | 'protein', exerciseIds?: string[]): Promise<{ date: string; value: number; group?: string }[]> {
  if (metric === 'bodyweight') return (await db.bodyweight.filter(alive).toArray()).map((b) => ({ date: dateKey(b.at), value: b.kg }));
  if (metric === 'kcal' || metric === 'protein') {
    const complete = new Set((await db.days.filter((d) => alive(d) && d.complete).toArray()).map((d) => d.id));
    const byDay = new Map<string, { kcal: number; p: number; c: number; f: number }[]>();
    (await db.entries.filter(alive).toArray()).forEach((e) => byDay.set(e.date, [...(byDay.get(e.date) ?? []), e.n]));
    // only fully-logged days when any are marked; otherwise every logged day
    return [...byDay].filter(([d]) => !complete.size || complete.has(d)).map(([date, list]) => ({ date, value: metric === 'kcal' ? sum(list).kcal : sum(list).p }));
  }
  // e1rm: best estimated 1RM per session per exercise, expressed relative to that exercise's overall mean so
  // different lifts can be pooled (1.05 = 5% above that lift's average)
  const sets = await db.sets.filter((s: SetLog) => alive(s) && !!s.doneAt && s.kind !== 'warmup' && !!s.reps && (!exerciseIds || exerciseIds.includes(s.exerciseId))).toArray();
  const best = new Map<string, { date: string; ex: string; kg: number }>();
  for (const s of sets) {
    const sess = await db.sessions.get(s.sessionId); if (!sess || !alive(sess)) continue;
    const est = e1rm(totalLoadKg(s.loadType, s.loadKg, s.bodyweightKg), s.reps!, s.rir ?? 0);
    if (!est.reliable) continue; // >10 reps to failure: estimate too noisy (Reynolds et al. 2006)
    const k = `${s.sessionId}:${s.exerciseId}`;
    if (!best.has(k) || est.kg > best.get(k)!.kg) best.set(k, { date: dateKey(sess.startedAt), ex: s.exerciseId, kg: est.kg });
  }
  const byEx = new Map<string, number[]>(); [...best.values()].forEach((b) => byEx.set(b.ex, [...(byEx.get(b.ex) ?? []), b.kg]));
  const mean = new Map([...byEx].map(([e, v]) => [e, v.reduce((a, x) => a + x, 0) / v.length]));
  return [...best.values()].map((b) => ({ date: b.date, value: b.kg / mean.get(b.ex)!, group: b.ex }));
}

/** Least-squares slope in value-units per week. */
function slopePerWeek(pts: { date: string; value: number }[]) {
  if (pts.length < 3) return null;
  const xs = pts.map((p) => keyToDate(p.date).getTime() / (7 * 86400000)); const ys = pts.map((p) => p.value);
  const mx = xs.reduce((a, x) => a + x, 0) / xs.length; const my = ys.reduce((a, y) => a + y, 0) / ys.length;
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den : null;
}

export const statsCompare = defineCommand({ name: 'stats.compareBeforeAfter', kind: 'query',
  description: 'Compare a metric before vs after a date (e.g. when a supplement was started — find it with supplements.history). Metrics: e1rm (strength, each lift relative to its own average; pass exerciseIds to restrict), bodyweight, kcal, protein (fully-logged days). windowDays (default 56) days on each side. Returns n, mean, trend per week in each window and a Welch t-test p-value (welch is null when a side has fewer than 2 points). Small samples, training age and diet changes confound — report as an observation, not proof.',
  input: z.object({ metric: z.enum(['e1rm', 'bodyweight', 'kcal', 'protein']), splitDate: zDate, windowDays: z.number().int().min(7).max(365).default(56), exerciseIds: z.array(z.string()).optional() }),
  run: async ({ metric, splitDate, windowDays, exerciseIds }) => {
    const all = await series(metric, exerciseIds);
    const start = dateKey(keyToDate(splitDate).getTime() - windowDays * 86400000); const end = dateKey(keyToDate(splitDate).getTime() + windowDays * 86400000);
    const before = all.filter((p) => p.date >= start && p.date < splitDate); const after = all.filter((p) => p.date >= splitDate && p.date <= end);
    const summary = (pts: typeof all) => ({ n: pts.length, mean: pts.length ? pts.reduce((a, p) => a + p.value, 0) / pts.length : null, trendPerWeek: slopePerWeek(pts) });
    const t = before.length >= 2 && after.length >= 2 ? welch(before.map((p) => p.value), after.map((p) => p.value)) : null;
    return { metric, unit: metric === 'e1rm' ? 'ratio to each lift\'s mean' : metric === 'bodyweight' ? 'kg' : metric === 'kcal' ? 'kcal/day' : 'g/day',
      window: { before: [start, splitDate], after: [splitDate, end] }, before: summary(before), after: summary(after), welch: t,
      caveat: 'Observational before/after comparison; progress usually slows over time and other changes (diet, sleep, program) confound.' };
  } });

export const statsDaily = defineCommand({ name: 'stats.dailyNutrition', kind: 'query', description: 'Calories and macros per day between dates, with whether each day was marked fully logged.',
  input: z.object({ from: zDate, to: zDate }),
  run: async ({ from, to }) => {
    const entries = await db.entries.where('date').between(from, to, true, true).filter(alive).toArray();
    const days = new Map<string, { kcal: number; p: number; c: number; f: number }[]>(); entries.forEach((e) => days.set(e.date, [...(days.get(e.date) ?? []), e.n]));
    const complete = new Set((await db.days.filter((d) => alive(d) && d.complete).toArray()).map((d) => d.id));
    return [...days].sort().map(([date, list]) => { const t = sum(list); return { date, kcal: Math.round(t.kcal), p: Math.round(t.p), c: Math.round(t.c), f: Math.round(t.f), complete: complete.has(date) }; });
  } });
