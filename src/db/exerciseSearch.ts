import { db } from './db';
import type { Exercise } from './types';
import { rank, tokenize } from '../lib/search';

/** The standard version of each big lift, nudged above niche variants (chains, bands, …) until your own usage takes over. */
export const STAPLES = new Set(['Barbell Bench Press - Medium Grip', 'Barbell Squat', 'Barbell Deadlift', 'Pullups', 'Chin-Up', 'Dips - Triceps Version',
  'Standing Military Press', 'Bent Over Barbell Row', 'Romanian Deadlift', 'Barbell Hip Thrust', 'Leg Press', 'Wide-Grip Lat Pulldown',
  'Seated Cable Rows', 'Dumbbell Bench Press', 'Incline Dumbbell Press', 'Dumbbell Shoulder Press', 'Side Lateral Raise', 'Barbell Curl',
  'Dumbbell Bicep Curl', 'Hammer Curls', 'Triceps Pushdown', 'Leg Extensions', 'Lying Leg Curls', 'Standing Calf Raises', 'Pushups',
  'Barbell Incline Bench Press - Medium Grip', 'Front Barbell Squat', 'Dumbbell Lunges', 'Plank', 'Cable Crossover', 'Face Pull']);

const cache = new WeakMap<Exercise, string[]>();
export const exerciseTokens = (e: Exercise) => {
  let t = cache.get(e);
  if (!t) { t = tokenize(`${e.name} ${e.equipment} ${e.muscles.join(' ')}`); cache.set(e, t); }
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
    bias: (e) => (e.custom ? -0.5 : 0) + (STAPLES.has(e.name) ? -1.2 : 0),
  });
}
