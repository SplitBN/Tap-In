import { db } from './db';
import type { Exercise } from './types';

const SEED_VERSION = 1;
export const EXERCISE_IMG_BASE = 'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/';

/** Loads the bundled exercise library (free-exercise-db) into IndexedDB once.
 *  Seed exercises are local reference data; they only enter the outbox if the user edits them. */
export async function seedIfNeeded() {
  const done = await db.meta.get('seedVersion');
  if (done && (done.value as number) >= SEED_VERSION) return;
  const { default: list } = await import('../data/exercises.json');
  const existing = new Set(await db.exercises.toCollection().primaryKeys());
  const rows: Exercise[] = (list as Omit<Exercise, 'createdAt' | 'updatedAt'>[])
    .filter((e) => !existing.has(e.id))
    .map((e) => ({ ...e, createdAt: 0, updatedAt: 0, deletedAt: null }));
  await db.exercises.bulkPut(rows);
  await db.meta.put({ key: 'seedVersion', value: SEED_VERSION });
}

export function exerciseImage(ex: Pick<Exercise, 'images'> | undefined, i = 0) {
  const p = ex?.images?.[i];
  if (!p) return undefined;
  return p.startsWith('http') || p.startsWith('data:') ? p : EXERCISE_IMG_BASE + p;
}
