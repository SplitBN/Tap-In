import { db } from './db';
import type { Exercise } from './types';
import { rank, tokenize } from '../lib/search';
import { equipmentLabel } from '../lib/equipment';

/** The standard version of each big lift (by id, so it survives renames), nudged above other variants until your own usage takes over. */
export const STAPLES = new Set([
  'Barbell_Bench_Press_-_Medium_Grip', 'Barbell_Squat', 'Barbell_Deadlift', 'Pullups', 'Chin-Up', 'Dips_-_Triceps_Version', 'Standing_Military_Press',
  'Bent_Over_Barbell_Row', 'Romanian_Deadlift', 'Barbell_Hip_Thrust', 'Leg_Press', 'Wide-Grip_Lat_Pulldown', 'Seated_Cable_Rows', 'Dumbbell_Bench_Press',
  'Incline_Dumbbell_Press', 'Dumbbell_Shoulder_Press', 'Side_Lateral_Raise', 'Barbell_Curl', 'Dumbbell_Bicep_Curl', 'Hammer_Curls', 'Triceps_Pushdown',
  'Leg_Extensions', 'Lying_Leg_Curls', 'Seated_Leg_Curl', 'Standing_Calf_Raises', 'Pushups', 'Barbell_Incline_Bench_Press_-_Medium_Grip',
  'Front_Barbell_Squat', 'Dumbbell_Lunges', 'Plank', 'Cable_Crossover', 'Sumo_Deadlift', 'Close-Grip_Barbell_Bench_Press', 'Machine_Bench_Press',
].map((id) => 'fedb:' + id));

/** Breaks ties between same-named variants (Bench Press barbell vs dumbbell vs smith …): free weights first. */
const EQUIPMENT_BIAS: Record<string, number> = { barbell: 0, dumbbell: 0.02, machine: 0.04, cable: 0.04, 'body only': 0.04, 'smith machine': 0.06 };

/** Other words people use for a movement, so either name finds every equipment variant ("ohp" → Shoulder Press · Dumbbell). */
const SYNONYMS: [RegExp, string][] = [[/shoulder press/i, 'overhead'], [/overhead press/i, 'shoulder'], [/pec deck/i, 'fly']];

const cache = new WeakMap<Exercise, string[]>();
export const exerciseTokens = (e: Exercise) => {
  let t = cache.get(e);
  if (!t) { t = tokenize(`${e.name} ${e.equipment} ${equipmentLabel(e.equipment)} ${e.muscles.join(' ')} ${SYNONYMS.filter(([re]) => re.test(e.name)).map(([, w]) => w).join(' ')}`); cache.set(e, t); }
  return t;
};

export type Usage = Map<string, { n: number; last: number }>;

/** Sessions each exercise was done in (completed sets) and when last — your staples float up. */
export async function exerciseUsage(): Promise<Usage> {
  const m = new Map<string, { n: number; last: number; sessions: Set<string> }>();
  await db.sets.each((s) => {
    if (!s.doneAt || s.deletedAt) return;
    const u = m.get(s.exerciseId) ?? { n: 0, last: 0, sessions: new Set<string>() };
    if (!u.sessions.has(s.sessionId)) { u.sessions.add(s.sessionId); u.n++; }
    u.last = Math.max(u.last, s.doneAt); m.set(s.exerciseId, u);
  });
  return m;
}

/** Shared ranking for the picker and the command API: match quality, then usage, staples, custom. */
export function searchExercises(pool: Exercise[], query: string, usage?: Usage, limit = 150) {
  return rank(pool, query, {
    tokensOf: exerciseTokens, keyOf: (e) => e.id, nameLength: (e) => e.name.length, usage, limit,
    bias: (e) => (e.custom ? -0.5 : 0) + (STAPLES.has(e.id) ? -1.2 : 0) + (EQUIPMENT_BIAS[e.equipment] ?? 0.08),
  });
}
