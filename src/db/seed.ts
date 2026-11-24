import { db, save } from './db';
import type { Exercise } from './types';

const SEED_VERSION = 3; // bump whenever src/data/exercises.json changes
export const EXERCISE_IMG_BASE = 'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/';

/** Loads the bundled exercise library (free-exercise-db) into IndexedDB once.
 *  Seed exercises are local reference data; they only enter the outbox if the user edits them. */
export async function seedIfNeeded() {
  // one-time: food logging shipped — switch it on for installs that stored food: false
  if (!(await db.meta.get('foodOn'))) {
    const s = await db.settings.get('settings');
    if (s) await db.settings.put({ ...s, features: { ...s.features, food: true } });
    await db.meta.put({ key: 'foodOn', value: true });
  }
  // one-time: supplements shipped — switch them on for installs that stored supplements: false
  if (!(await db.meta.get('suppOn'))) {
    const s = await db.settings.get('settings');
    if (s) await db.settings.put({ ...s, features: { ...s.features, supplements: true } });
    await db.meta.put({ key: 'suppOn', value: true });
  }
  const done = await db.meta.get('seedVersion');
  if (done && (done.value as number) >= SEED_VERSION) return;
  const { default: list } = await import('../data/exercises.json');
  await reconcileSeed(list as SeedExercise[]);
  await db.meta.put({ key: 'seedVersion', value: SEED_VERSION });
}

type SeedExercise = Omit<Exercise, 'createdAt' | 'updatedAt'>;
/** Ids of bundled exercises (free-exercise-db + the few basics we add). Custom exercises and duplicates have UUIDs. */
export const isSeeded = (id: string) => id.startsWith('fedb:') || id.startsWith('tapin:');

/** Brings existing installs in line with the bundled list: new ones inserted, renamed/re-curated ones updated
 *  (the user's stepKg is kept), ones no longer bundled removed. Untouched seed rows (updatedAt 0) are local
 *  reference data and change in place without syncing; rows the user edited go through save() so the change syncs.
 *  A dropped exercise that a set or workout still points at is soft-deleted so history keeps its name. */
async function reconcileSeed(list: SeedExercise[]) {
  const byId = new Map(list.map((e) => [e.id, e]));
  const existing = await db.exercises.toArray();
  const have = new Set(existing.map((e) => e.id));
  const used = new Set<string>();
  await db.sets.each((s) => { used.add(s.exerciseId); });
  for (const w of await db.workouts.toArray()) for (const it of w.items) used.add(it.exerciseId);
  for (const s of await db.sessions.toArray()) for (const it of s.items ?? []) used.add(it.exerciseId);

  const put: Exercise[] = list.filter((e) => !have.has(e.id)).map((e) => ({ ...e, createdAt: 0, updatedAt: 0, deletedAt: null }));
  const del: string[] = [];
  const synced: Exercise[] = [];
  for (const e of existing) {
    if (!isSeeded(e.id) || e.custom) continue;
    const next = byId.get(e.id);
    const edited = e.updatedAt > 0;
    if (next) {
      const merged: Exercise = { ...e, ...next, stepKg: e.stepKg, createdAt: e.createdAt, updatedAt: e.updatedAt, deletedAt: e.deletedAt ?? null };
      if (edited) synced.push(merged); else put.push(merged);
    } else if (!e.deletedAt) {
      if (edited) synced.push({ ...e, deletedAt: Date.now() });
      else if (used.has(e.id)) put.push({ ...e, deletedAt: Date.now() });
      else del.push(e.id);
    }
  }
  await db.transaction('rw', db.exercises, async () => {
    await db.exercises.bulkPut(put);
    await db.exercises.bulkDelete(del);
  });
  for (const e of synced) await save('exercises', e);
}

export function exerciseImage(ex: Pick<Exercise, 'images'> | undefined, i = 0) {
  const p = ex?.images?.[i];
  if (!p) return undefined;
  return p.startsWith('http') || p.startsWith('data:') ? p : EXERCISE_IMG_BASE + p;
}
