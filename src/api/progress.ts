// Progress queries: per-exercise series + records, weekly totals, per-session rows and the exercise library.
// Everything is computed on read from raw sets (store raw, compute on read) with the same definitions as the
// workout summary (src/lib/workoutStats.ts, docs/SPEC.md → "Workout summary" and "Science sources"), so a PR shown
// here is the same PR the summary showed for that session.
import { z } from 'zod';
import { defineCommand, zDate, zId } from './registry';
import { alive, db } from '../db/db';
import { setOrder } from '../db/gym';
import type { Exercise, LoadType, Session, SetLog } from '../db/types';
import { exerciseUsage, searchExercises } from '../db/exerciseSearch';
import { dateKey, keyToDate } from '../lib/nutrition';
import { exerciseLabel } from '../lib/equipment';
import { e1rm, RELIABLE_MAX_RTF } from '../lib/science';
import {
  bestSet, compareToPrevious, effLoad, personalRecords, setE1rmView, setsByMuscle, toStatSet, volumeKg, weekStartMs, workingSetCount,
  type BestSet, type PRs, type StatSet, type Trend,
} from '../lib/workoutStats';

const r1 = (v: number) => Math.round(v * 10) / 10;
const minutesOf = (s: Session) => ((s.endedAt ?? s.startedAt) - s.startedAt) / 60000;
const prCount = (p: PRs) => Number(!!p.e1rm) + Number(!!p.weight) + Number(!!p.reps);

/** One exercise within one finished session, with its comparison against every earlier session. */
interface ExEntry {
  session: Session;
  exerciseId: string;
  loadType: LoadType;
  sets: StatSet[]; // done sets, warm-ups included (volume/best-set helpers skip them)
  raw: SetLog[];
  working: number;
  volume: number;
  best: BestSet | null;
  prs: PRs;
  trend: Trend;
}

/** Chronological pass over every finished session: same inputs and rules as sessions.summary (buildSummary in gym.ts). */
async function timeline() {
  const sessions = (await db.sessions.orderBy('startedAt').filter((s) => alive(s) && !!s.endedAt).toArray());
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const sets = await db.sets.filter((x) => alive(x) && !!x.doneAt && byId.has(x.sessionId)).toArray();
  const exList = await db.exercises.toArray();
  const exMap: Record<string, Exercise | undefined> = Object.fromEntries(exList.map((e) => [e.id, e]));
  // bodyweight fallback when a set has no snapshot: last weigh-in at/before the session, else the first one after
  // (copy of the private bwAt in gym.ts buildSummary, kept identical so numbers match the summary)
  const bw = await db.bodyweight.orderBy('at').filter(alive).toArray();
  const bwAt = (ts: number) => { let v: number | undefined; for (const b of bw) { if (b.at <= ts) v = b.kg; else return v ?? b.kg; } return v; };

  const bySession = new Map<string, SetLog[]>();
  sets.forEach((x) => bySession.set(x.sessionId, [...(bySession.get(x.sessionId) ?? []), x]));

  const prior = new Map<string, StatSet[]>(); // exerciseId → non-warm-up sets of earlier sessions
  const prevOf = new Map<string, StatSet[]>(); // exerciseId → non-warm-up sets of the latest earlier session
  const entries: ExEntry[] = [];
  const sessionStats = new Map<string, StatSet[]>();
  for (const s of sessions) {
    const raw = (bySession.get(s.id) ?? []).sort(setOrder);
    const st = raw.map((x) => toStatSet(x, bwAt(s.startedAt)));
    sessionStats.set(s.id, st);
    const order = [...new Set(st.map((x) => x.exerciseId))];
    const done: [string, StatSet[]][] = [];
    for (const exId of order) {
      const mine = st.filter((x) => x.exerciseId === exId);
      const loadType = exMap[exId]?.loadType ?? mine[0].loadType;
      const past = prior.get(exId) ?? [];
      const cmp = compareToPrevious(mine, prevOf.get(exId) ?? null, loadType);
      const prs = personalRecords(mine, past, loadType);
      entries.push({ session: s, exerciseId: exId, loadType, sets: mine, raw: raw.filter((x) => x.exerciseId === exId),
        working: workingSetCount(mine), volume: volumeKg(mine), best: bestSet(mine), prs,
        trend: prs.e1rm || prs.weight || prs.reps ? 'up' : cmp.trend });
      done.push([exId, mine.filter((x) => x.kind !== 'warmup')]);
    }
    // only after the whole session: sets of the same session never count as "earlier"
    for (const [exId, nw] of done) { prior.set(exId, [...(prior.get(exId) ?? []), ...nw]); if (nw.length) prevOf.set(exId, nw); }
  }
  return { sessions, entries, exMap, sessionStats };
}

const bestOut = (b: BestSet | null) => b && ({ loadKg: r1(b.loadKg), totalKg: r1(b.totalKg), reps: b.reps, rir: b.rir, e1rmKg: b.e1rmKg > 0 ? r1(b.e1rmKg) : null, e1rmReliable: b.reliable, e1rmLowerBound: b.lowerBound });
const prsOut = (p: PRs) => ({
  e1rm: p.e1rm && { kg: r1(p.e1rm.kg), previousKg: r1(p.e1rm.previousKg) },
  weight: p.weight && { loadKg: r1(p.weight.loadKg), totalKg: r1(p.weight.totalKg), previousLoadKg: r1(p.weight.previousLoadKg) },
  reps: p.reps && { loadKg: r1(p.reps.loadKg), totalKg: r1(p.reps.totalKg), reps: p.reps.reps, previousReps: p.reps.previousReps },
});

/** Heaviest working set on the logged-load axis (added weight / least assistance for bodyweight lifts), ties → more reps. */
function heaviest(sets: StatSet[]) {
  let h: StatSet | null = null;
  for (const s of sets) if (s.kind === 'working' && s.reps > 0 && (!h || effLoad(s) > effLoad(h) || (effLoad(s) === effLoad(h) && s.reps > h.reps))) h = s;
  return h && { loadKg: r1(h.loadKg), totalKg: r1(h.totalKg), reps: h.reps };
}
const mostReps = (sets: StatSet[]) => Math.max(0, ...sets.filter((s) => s.kind === 'working').map((s) => s.reps));

// ---------------- progress.exercise ----------------
export const progressExercise = defineCommand({ name: 'progress.exercise', kind: 'query',
  description: 'Progress of one exercise over time: one row per finished session (optionally within from/to dates, oldest first) and all-time records. ' +
    'Per session: workingSets, volumeKg (Σ total load × reps of working sets + drop steps, warm-ups excluded), bestSet (working set with the highest e1RM: Wathen on reps-to-failure = reps + RIR; ' +
    `e1rmKg null when it cannot be estimated, e.g. a bodyweight lift with no weigh-in; e1rmReliable false past ${RELIABLE_MAX_RTF} reps to failure; e1rmLowerBound true when no effort was logged (reps alone, so the real e1RM is at least this)), heaviest (heaviest` + ' working set on the logged-load axis: ' +
    'the weight; added weight for bodyweight lifts; least assistance for assisted), mostReps (most reps in one working set), prs (all-time PRs set that session, same rules as sessions.summary), ' +
    'trend up|same|down|new vs the previous session, and the raw sets (each with e1rm: {kg, reliable, lowerBound, repsToFailure} for working sets, null otherwise — the set table score). Loads are kg; totalKg includes bodyweight for bodyweight/assisted lifts. ' +
    'records (always all-time, ignoring from/to): bestE1rm (reliable estimates preferred), heaviest, bestVolume, mostReps, and repRecords = most reps ever done at each logged load (heaviest loads first). Each record has its date and sessionId.',
  input: z.object({ exerciseId: zId, from: zDate.optional(), to: zDate.optional() }),
  run: async ({ exerciseId, from, to }) => {
    const { entries, exMap } = await timeline();
    const ex = exMap[exerciseId];
    const mine = entries.filter((e) => e.exerciseId === exerciseId);
    const row = (e: ExEntry) => ({
      sessionId: e.session.id, name: e.session.name, date: dateKey(e.session.startedAt), startedAt: new Date(e.session.startedAt).toISOString(),
      workingSets: e.working, volumeKg: r1(e.volume), bestSet: bestOut(e.best), heaviest: heaviest(e.sets), mostReps: mostReps(e.sets),
      prs: prsOut(e.prs), prCount: prCount(e.prs), trend: e.trend,
      bodyweight: e.loadType === 'weighted' ? null : e.sets.some((x) => x.bwMissing) ? 'missing' as const : e.sets.some((x) => x.bwEstimated) ? 'estimated' as const : 'logged' as const,
      sets: e.raw.map((x) => ({ id: x.id, kind: x.kind, setNo: x.setNo, dropNo: x.dropNo, side: x.side, loadType: x.loadType, loadKg: x.loadKg, reps: x.reps, rir: x.rir, rpe: x.rpe, effortInput: x.effortInput, bodyweightKg: x.bodyweightKg ?? null, e1rm: setE1rmView(x) })),
    });
    const all = mine.map(row);

    // ---- all-time records ----
    const at = (e: ExEntry) => ({ date: dateKey(e.session.startedAt), sessionId: e.session.id });
    let bestE: { kg: number; reliable: boolean; lowerBound: boolean; loadKg: number; totalKg: number; reps: number; rir: number | null; date: string; sessionId: string } | null = null;
    let heavy: { loadKg: number; totalKg: number; reps: number; eff: number; date: string; sessionId: string } | null = null;
    let vol: { kg: number; date: string; sessionId: string } | null = null;
    let reps: { reps: number; loadKg: number; totalKg: number; eff: number; date: string; sessionId: string } | null = null;
    const repAt = new Map<number, { loadKg: number; reps: number; date: string; sessionId: string }>(); // effLoad → most reps
    for (const e of mine) {
      for (const s of e.sets) {
        if (s.kind !== 'working' || s.reps <= 0) continue;
        const est = e1rm(s.totalKg, s.reps, s.rir);
        // reliable estimates beat unreliable ones; within the same class the higher estimate wins
        if (est.kg > 0 && (!bestE || (est.reliable && !bestE.reliable) || (est.reliable === bestE.reliable && est.kg > bestE.kg)))
          bestE = { kg: est.kg, reliable: est.reliable, lowerBound: est.lowerBound, loadKg: s.loadKg, totalKg: s.totalKg, reps: s.reps, rir: s.rir, ...at(e) };
        if (!heavy || effLoad(s) > heavy.eff || (effLoad(s) === heavy.eff && s.reps > heavy.reps)) heavy = { loadKg: s.loadKg, totalKg: s.totalKg, reps: s.reps, eff: effLoad(s), ...at(e) };
        if (!reps || s.reps > reps.reps || (s.reps === reps.reps && effLoad(s) > reps.eff)) reps = { reps: s.reps, loadKg: s.loadKg, totalKg: s.totalKg, eff: effLoad(s), ...at(e) };
        const k = Math.round(effLoad(s) * 100) / 100; const cur = repAt.get(k);
        if (!cur || s.reps > cur.reps) repAt.set(k, { loadKg: s.loadKg, reps: s.reps, ...at(e) });
      }
      if (e.volume > 0 && (!vol || e.volume > vol.kg)) vol = { kg: e.volume, ...at(e) };
    }
    // a rep record only matters if no heavier load was done for at least as many reps
    const repRecords = [...repAt.entries()].sort((a, b) => b[0] - a[0])
      .filter(([, v], i, arr) => !arr.slice(0, i).some(([, h]) => h.reps >= v.reps))
      .map(([, v]) => ({ loadKg: r1(v.loadKg), reps: v.reps, date: v.date, sessionId: v.sessionId }));

    return {
      exercise: ex ? { id: ex.id, name: ex.name, label: exerciseLabel(ex), equipment: ex.equipment, loadType: ex.loadType, muscles: ex.muscles } : { id: exerciseId, name: exerciseId, label: exerciseId, equipment: 'other', loadType: (mine[0]?.loadType ?? 'weighted') as LoadType, muscles: [] },
      unit: 'kg' as const,
      totalSessions: mine.length, firstDate: all[0]?.date ?? null, lastDate: all.at(-1)?.date ?? null,
      sessions: all.filter((r) => (!from || r.date >= from) && (!to || r.date <= to)),
      records: {
        bestE1rm: bestE && { kg: r1(bestE.kg), reliable: bestE.reliable, lowerBound: bestE.lowerBound, loadKg: r1(bestE.loadKg), totalKg: r1(bestE.totalKg), reps: bestE.reps, rir: bestE.rir, date: bestE.date, sessionId: bestE.sessionId },
        heaviest: heavy && { loadKg: r1(heavy.loadKg), totalKg: r1(heavy.totalKg), reps: heavy.reps, date: heavy.date, sessionId: heavy.sessionId },
        bestVolume: vol && { kg: r1(vol.kg), date: vol.date, sessionId: vol.sessionId },
        mostReps: reps && { reps: reps.reps, loadKg: r1(reps.loadKg), totalKg: r1(reps.totalKg), date: reps.date, sessionId: reps.sessionId },
        repRecords,
      },
    };
  } });
export type ExerciseProgress = Awaited<ReturnType<typeof progressExercise.run>>;

// ---------------- progress.weekly ----------------
export const progressWeekly = defineCommand({ name: 'progress.weekly', kind: 'query',
  description: 'Training per calendar week (weeks start Monday 00:00 local), the last `weeks` weeks including the current one (oldest first). Per week: workouts (finished sessions), ' +
    'minutes (total workout time = end − start), avgMinutes, workingSets, volumeKg (Σ total load × reps, working sets + drop steps, warm-ups excluded), prs (all-time PRs set that week: ' +
    'e1RM, weight and rep PRs each count 1, same rules as sessions.summary), inProgress (the current week). ' +
    'muscles[]: hard (working) sets per muscle this week vs the average of earlier full weeks in the window (weeksAveraged; weeks before the first logged workout are not counted): ' +
    'direct = 1 per set for primary muscles; indirect = sets where it is a secondary muscle; fractional = direct + 0.5 × secondary-muscle sets (0.5 is a convention). Weekly sets per muscle is the dose studied by Schoenfeld, Ogborn & Krieger 2017 ' +
    '(J Sports Sci 35(11):1073–1082: ≥10 weekly sets per muscle was their highest category and gave more growth than <5; it is not an upper limit). totals sums the whole window.',
  input: z.object({ weeks: z.number().int().min(1).max(104).default(12) }),
  run: async ({ weeks }) => {
    const { sessions, entries, exMap, sessionStats } = await timeline();
    const starts: number[] = [weekStartMs(Date.now())];
    while (starts.length < weeks) starts.unshift(weekStartMs(starts[0] - 1)); // DST-safe: step back into the previous week and snap to its Monday
    const lo = starts[0];
    const idx = (ts: number) => { for (let i = starts.length - 1; i >= 0; i--) if (ts >= starts[i]) return i; return -1; };
    const W = starts.map((ws) => ({ weekStart: dateKey(ws), workouts: 0, minutes: 0, workingSets: 0, volumeKg: 0, prs: 0, stats: [] as StatSet[] }));
    for (const s of sessions) {
      if (s.startedAt < lo) continue;
      const w = W[idx(s.startedAt)];
      const st = sessionStats.get(s.id) ?? [];
      w.workouts++; w.minutes += minutesOf(s); w.workingSets += workingSetCount(st); w.volumeKg += volumeKg(st);
      w.stats.push(...st.map((x) => ({ ...x, itemKey: `${s.id}:${x.itemKey}` }))); // slot keys repeat across sessions
    }
    for (const e of entries) if (e.session.startedAt >= lo) W[idx(e.session.startedAt)].prs += prCount(e.prs);

    const muscleWeeks = W.map((w) => setsByMuscle(w.stats, exMap));
    const first = sessions[0]?.startedAt;
    const cur = W.length - 1;
    // earlier full weeks that are on or after the week of the first ever workout
    const avgIdx = W.map((_, i) => i).filter((i) => i < cur && first != null && starts[i] >= weekStartMs(first));
    const names = new Set(muscleWeeks.flatMap((m) => Object.keys(m)));
    const muscles = [...names].map((muscle) => {
      const t = muscleWeeks[cur][muscle];
      const avg = (k: 'direct' | 'fractional') => (avgIdx.length ? r1(avgIdx.reduce((a, i) => a + (muscleWeeks[i][muscle]?.[k] ?? 0), 0) / avgIdx.length) : null);
      return { muscle, thisWeek: { direct: t?.direct ?? 0, indirect: t?.indirect ?? 0, fractional: t?.fractional ?? 0 }, average: { direct: avg('direct'), fractional: avg('fractional') } };
    }).sort((a, b) => b.thisWeek.direct - a.thisWeek.direct || (b.average.direct ?? 0) - (a.average.direct ?? 0) || a.muscle.localeCompare(b.muscle));

    const out = W.map((w, i) => ({ weekStart: w.weekStart, workouts: w.workouts, minutes: Math.round(w.minutes), avgMinutes: w.workouts ? Math.round(w.minutes / w.workouts) : null,
      workingSets: w.workingSets, volumeKg: Math.round(w.volumeKg), prs: w.prs, inProgress: i === cur }));
    const sum = (k: 'workouts' | 'minutes' | 'volumeKg' | 'prs' | 'workingSets') => out.reduce((a, w) => a + w[k], 0);
    return {
      weeks: out, muscles, weeksAveraged: avgIdx.length,
      totals: { workouts: sum('workouts'), minutes: sum('minutes'), avgMinutes: sum('workouts') ? Math.round(sum('minutes') / sum('workouts')) : null, volumeKg: sum('volumeKg'), prs: sum('prs'), workingSets: sum('workingSets') },
      reference: { source: 'Schoenfeld, Ogborn & Krieger 2017, J Sports Sci 35(11):1073–1082', note: 'Highest weekly-sets category studied was 10+ sets per muscle; more sets gave more growth on average. Context, not a target or a limit.', setsPerWeek: 10 },
    };
  } });
export type WeeklyProgress = Awaited<ReturnType<typeof progressWeekly.run>>;

// ---------------- progress.sessions ----------------
export const progressSessions = defineCommand({ name: 'progress.sessions', kind: 'query',
  description: 'Finished workouts, newest first, with per-session totals: minutes, workingSets, volumeKg (Σ total load × reps, working sets + drop steps, warm-ups excluded), ' +
    'prs (all-time PRs set that session: e1RM, weight and rep PRs each count 1, same as the highlights in sessions.summary), exercises (count). Optional from/to dates.',
  input: z.object({ from: zDate.optional(), to: zDate.optional(), limit: z.number().int().min(1).max(1000).default(200) }),
  run: async ({ from, to, limit }) => {
    const { sessions, entries, sessionStats } = await timeline();
    const prs = new Map<string, number>(); const exs = new Map<string, number>();
    entries.forEach((e) => { prs.set(e.session.id, (prs.get(e.session.id) ?? 0) + prCount(e.prs)); exs.set(e.session.id, (exs.get(e.session.id) ?? 0) + 1); });
    const lo = from ? keyToDate(from).getTime() : -Infinity; const hi = to ? keyToDate(to).getTime() + 86400000 : Infinity;
    return sessions.filter((s) => s.startedAt >= lo && s.startedAt < hi).reverse().slice(0, limit).map((s) => {
      const st = sessionStats.get(s.id) ?? [];
      return { id: s.id, name: s.name, date: dateKey(s.startedAt), startedAt: new Date(s.startedAt).toISOString(), minutes: Math.round(minutesOf(s)),
        workingSets: workingSetCount(st), volumeKg: Math.round(volumeKg(st)), prs: prs.get(s.id) ?? 0, exercises: exs.get(s.id) ?? 0 };
    });
  } });

// ---------------- progress.exercises ----------------
export const progressExercises = defineCommand({ name: 'progress.exercises', kind: 'query',
  description: 'Exercise library with usage: search by name (same ranking as exercises.search) or list (no query: done exercises first, most recent first, then A–Z). ' +
    'Each: id, name, equipment, muscles, loadType, custom, sessions (finished sessions it was done in), lastDate (date of the latest one, null if never). onlyDone=true lists only exercises with history.',
  input: z.object({ query: z.string().default(''), muscle: z.string().optional(), onlyDone: z.boolean().default(false), limit: z.number().int().min(1).max(1000).default(150) }),
  run: async ({ query, muscle, onlyDone, limit }) => {
    const sessions = await db.sessions.filter((s) => alive(s) && !!s.endedAt).toArray();
    const start = new Map(sessions.map((s) => [s.id, s.startedAt]));
    const use = new Map<string, { n: number; last: number; seen: Set<string> }>();
    await db.sets.each((x) => {
      if (!x.doneAt || x.deletedAt || !start.has(x.sessionId)) return;
      const u = use.get(x.exerciseId) ?? { n: 0, last: 0, seen: new Set<string>() };
      if (!u.seen.has(x.sessionId)) { u.seen.add(x.sessionId); u.n++; u.last = Math.max(u.last, start.get(x.sessionId)!); }
      use.set(x.exerciseId, u);
    });
    let pool = (await db.exercises.toArray()).filter((e) => alive(e) && (!muscle || e.muscles.includes(muscle)) && (!onlyDone || use.has(e.id)));
    if (query.trim()) pool = searchExercises(pool, query, await exerciseUsage(), limit);
    else pool = pool.sort((a, b) => (use.get(b.id)?.last ?? 0) - (use.get(a.id)?.last ?? 0) || a.name.localeCompare(b.name)).slice(0, limit);
    return pool.map((e) => ({ id: e.id, name: e.name, equipment: e.equipment, muscles: e.muscles, loadType: e.loadType, custom: !!e.custom, images: e.images.slice(0, 1),
      sessions: use.get(e.id)?.n ?? 0, lastDate: use.get(e.id) ? dateKey(use.get(e.id)!.last) : null }));
  } });
