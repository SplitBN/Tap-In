// Workout summary math: pure functions over raw logged sets (store raw, compute on read).
// Every formula here is listed in docs/SPEC.md → "Science sources".
import type { Exercise, LoadType, SetLog } from '../db/types';
import { e1rm, totalLoadKg } from './science';

/** A done set with its total load resolved (bodyweight snapshot, or a fallback weigh-in when the snapshot is missing). */
export interface StatSet {
  exerciseId: string;
  itemKey: string;
  kind: SetLog['kind'];
  setNo: number;
  side: SetLog['side'];
  loadType: LoadType;
  loadKg: number; // as logged: weight / added weight / assistance
  totalKg: number; // load actually moved, never negative
  reps: number;
  rir: number | null;
  bwEstimated: boolean; // bodyweight snapshot was missing, a weigh-in near the session was used instead
  bwMissing: boolean; // no weigh-in at all: bodyweight counted as 0
}

export function toStatSet(s: SetLog, bwFallback: number | undefined): StatSet {
  const needsBw = s.loadType !== 'weighted';
  const snap = s.bodyweightKg ?? null;
  const bw = needsBw ? snap ?? bwFallback ?? null : null;
  return {
    exerciseId: s.exerciseId, itemKey: s.itemKey, kind: s.kind, setNo: s.setNo, side: s.side, loadType: s.loadType,
    loadKg: s.loadKg ?? 0,
    // assisted with no bodyweight would go negative; clamp so volume is never wrong in the other direction
    totalKg: Math.max(0, totalLoadKg(s.loadType, s.loadKg, bw)),
    reps: s.reps ?? 0, rir: s.rir ?? null,
    bwEstimated: needsBw && snap == null && bwFallback != null,
    bwMissing: needsBw && bw == null,
  };
}

/** Load on the axis that defines "heavier" for this load type, independent of bodyweight drift:
 *  weighted → the weight, bodyweight → added weight, assisted → less assistance is heavier. */
export const effLoad = (s: StatSet) => (s.loadType === 'assisted' ? -s.loadKg : s.loadKg);

/** Volume load = Σ load × reps (kg), working sets + drop steps, warm-ups excluded. Both sides of one-side sets count. */
export const volumeKg = (sets: StatSet[]) => sets.filter((s) => s.kind !== 'warmup' && s.reps > 0).reduce((a, s) => a + s.totalKg * s.reps, 0);

/** Working sets: one per (slot, set number) — a left+right pair is one set, drop steps fold into their parent set. */
export const workingSetCount = (sets: StatSet[]) => new Set(sets.filter((s) => s.kind === 'working').map((s) => `${s.itemKey}:${s.setNo}`)).size;

export interface BestSet { loadKg: number; totalKg: number; reps: number; rir: number | null; e1rmKg: number; reliable: boolean }
/** Best working set = highest estimated 1RM (Epley on reps + RIR, see science.ts e1rm); ties (incl. e1RM 0 when a
 *  bodyweight lift has no weigh-in) → heavier logged load, then more reps. Drops excluded. */
export function bestSet(sets: StatSet[]): BestSet | null {
  let best: (BestSet & { eff: number }) | null = null;
  for (const s of sets) {
    if (s.kind !== 'working' || s.reps <= 0) continue;
    const est = e1rm(s.totalKg, s.reps, s.rir ?? 0);
    const better = !best || est.kg > best.e1rmKg + 1e-9 || (Math.abs(est.kg - best.e1rmKg) < 1e-9 && (effLoad(s) > best.eff || (effLoad(s) === best.eff && s.reps > best.reps)));
    if (better) best = { loadKg: s.loadKg, totalKg: s.totalKg, reps: s.reps, rir: s.rir, e1rmKg: est.kg, reliable: est.reliable, eff: effLoad(s) };
  }
  if (!best) return null;
  const { eff: _e, ...out } = best;
  return out;
}

/** Margin an e1RM must clear to count as higher/lower. Weighted lifts: any real increase.
 *  Bodyweight/assisted: 1%, so a few hundred grams of bodyweight drift alone never reads as progress (our own tolerance). */
const margin = (loadType: LoadType, kg: number) => (loadType === 'weighted' ? 0.05 : kg * 0.01);

export type Trend = 'up' | 'same' | 'down' | 'new';
export interface Comparison {
  trend: Trend;
  beatByE1rm: boolean; // higher best e1RM than last time
  beatByReps: boolean; // more reps at last time's top weight (or heavier)
  e1rmDeltaKg: number | null;
}
/** vs the previous session of the same exercise. "Beat last time" = higher e1RM, or more reps at ≥ last time's top weight. */
export function compareToPrevious(cur: StatSet[], prev: StatSet[] | null, loadType: LoadType): Comparison {
  const pw = (prev ?? []).filter((s) => s.kind === 'working' && s.reps > 0);
  if (!pw.length) return { trend: 'new', beatByE1rm: false, beatByReps: false, e1rmDeltaKg: null };
  const cb = bestSet(cur), pb = bestSet(pw);
  // reps at last time's top weight work even when e1RM can't be estimated (bodyweight lift without a weigh-in)
  const top = Math.max(...pw.map(effLoad));
  const topReps = Math.max(...pw.filter((s) => effLoad(s) >= top - 0.01).map((s) => s.reps));
  const beatByReps = cur.some((s) => s.kind === 'working' && effLoad(s) >= top - 0.01 && s.reps > topReps);
  const hasE1rm = !!cb && !!pb && cb.e1rmKg > 0 && pb.e1rmKg > 0;
  const m = pb ? margin(loadType, pb.e1rmKg) : 0;
  const beatByE1rm = hasE1rm && cb!.e1rmKg > pb!.e1rmKg + m;
  const trend: Trend = beatByE1rm || beatByReps ? 'up' : !cb || (hasE1rm && cb.e1rmKg < pb!.e1rmKg - m) ? 'down' : 'same';
  return { trend, beatByE1rm, beatByReps, e1rmDeltaKg: hasE1rm ? cb!.e1rmKg - pb!.e1rmKg : null };
}

export interface PRs {
  e1rm: { kg: number; previousKg: number } | null; // best reliable e1RM (≤10 reps to failure) above every earlier one
  weight: { loadKg: number; totalKg: number; previousLoadKg: number } | null; // heaviest set ever (logged-load axis)
  reps: { loadKg: number; totalKg: number; reps: number; previousReps: number } | null; // most reps ever at ≥ this load
}
/** All-time PRs against every earlier session (prior = working sets from sessions that started before this one). */
export function personalRecords(cur: StatSet[], prior: StatSet[], loadType: LoadType): PRs {
  const cw = cur.filter((s) => s.kind === 'working' && s.reps > 0);
  const pw = prior.filter((s) => s.kind === 'working' && s.reps > 0);
  const out: PRs = { e1rm: null, weight: null, reps: null };
  if (!cw.length || !pw.length) return out;

  // e1RM: reliable estimates only (Reynolds et al. 2006: accuracy drops past ~10 reps to failure)
  const rel = (list: StatSet[]) => list.map((s) => e1rm(s.totalKg, s.reps, s.rir ?? 0)).filter((e) => e.reliable).map((e) => e.kg);
  const cE = rel(cw), pE = rel(pw);
  if (cE.length && pE.length) {
    const c = Math.max(...cE), p = Math.max(...pE);
    if (c > p + margin(loadType, p)) out.e1rm = { kg: c, previousKg: p };
  }
  // weight: compares the logged load (added weight / less assistance for bodyweight lifts), so bodyweight drift isn't a PR
  const heaviest = cw.reduce((a, s) => (effLoad(s) > effLoad(a) ? s : a));
  const priorTop = Math.max(...pw.map(effLoad));
  if (effLoad(heaviest) > priorTop + 0.01 && !(loadType === 'bodyweight' && heaviest.loadKg === 0))
    out.weight = { loadKg: heaviest.loadKg, totalKg: heaviest.totalKg, previousLoadKg: loadType === 'assisted' ? -priorTop : priorTop };
  // reps: more reps than ever done at this load or heavier (only where that load was done before)
  let bestRep: PRs['reps'] = null;
  let bestEff = -Infinity; // report the heaviest set that set a rep record
  for (const s of cw) {
    const atOrAbove = pw.filter((p) => effLoad(p) >= effLoad(s) - 0.01);
    if (!atOrAbove.length) continue;
    const prevMax = Math.max(...atOrAbove.map((p) => p.reps));
    if (s.reps > prevMax && effLoad(s) > bestEff) {
      bestEff = effLoad(s);
      bestRep = { loadKg: s.loadKg, totalKg: s.totalKg, reps: s.reps, previousReps: prevMax };
    }
  }
  out.reps = bestRep;
  return out;
}

export interface MuscleSets { direct: number; indirect: number; fractional: number }
/** Hard sets per muscle. A working set counts 1 for each of the exercise's primary muscles (direct) and 0.5 for each
 *  secondary muscle (indirect) in the `fractional` total. Weekly sets per muscle is the dose measured by
 *  Schoenfeld, Ogborn & Krieger 2017 (J Sports Sci 35(11):1073–1082); the 0.5 weight for secondary muscles is a
 *  convention (fractional counting, as proposed in Pelland et al., SportRxiv preprint), not an established standard.
 *  Warm-ups excluded; drop steps fold into their parent set; a left+right pair is one set. */
export function setsByMuscle(sets: StatSet[], exercises: Record<string, Pick<Exercise, 'muscles' | 'secondary'> | undefined>) {
  const out: Record<string, MuscleSets> = {};
  const seen = new Set<string>();
  const add = (m: string, k: 'direct' | 'indirect') => {
    const r = (out[m] ??= { direct: 0, indirect: 0, fractional: 0 });
    r[k] += 1; r.fractional += k === 'direct' ? 1 : 0.5;
  };
  for (const s of sets) {
    if (s.kind !== 'working') continue;
    const key = `${s.itemKey}:${s.exerciseId}:${s.setNo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ex = exercises[s.exerciseId];
    if (!ex) continue;
    const primary = new Set(ex.muscles);
    primary.forEach((m) => add(m, 'direct'));
    (ex.secondary ?? []).filter((m) => !primary.has(m)).forEach((m) => add(m, 'indirect'));
  }
  return out;
}

/** Monday 00:00 (local) of the week containing ts — same week convention as the Home week widget. */
export function weekStartMs(ts: number) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime();
}

export const r1 = (v: number) => Math.round(v * 10) / 10;
