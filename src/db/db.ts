import Dexie, { type Table } from 'dexie';
import type {
  Base, BodyweightEntry, DayStatus, Exercise, Food, FoodEntry, Note, NutritionGoal, OutboxEntry, Plan, Session, SetLog, Settings, Stack, SuppLog, Supplement, Workout,
} from './types';

export class TapInDB extends Dexie {
  exercises!: Table<Exercise, string>;
  plans!: Table<Plan, string>;
  workouts!: Table<Workout, string>;
  sessions!: Table<Session, string>;
  sets!: Table<SetLog, string>;
  bodyweight!: Table<BodyweightEntry, string>;
  settings!: Table<Settings, string>;
  outbox!: Table<OutboxEntry, number>;
  meta!: Table<{ key: string; value: unknown }, string>;
  foods!: Table<Food, string>;
  entries!: Table<FoodEntry, string>;
  days!: Table<DayStatus, string>;
  goals!: Table<NutritionGoal, string>;
  supplements!: Table<Supplement, string>;
  stacks!: Table<Stack, string>;
  supplogs!: Table<SuppLog, string>;
  notes!: Table<Note, string>;

  constructor() {
    super('tapin-db'); // namespaced: all apps share the github.io origin
    this.version(1).stores({
      exercises: 'id, name, updatedAt',
      plans: 'id, updatedAt',
      workouts: 'id, planId, updatedAt',
      sessions: 'id, startedAt, endedAt, workoutId, updatedAt',
      sets: 'id, sessionId, exerciseId, [exerciseId+doneAt], updatedAt',
      bodyweight: 'id, at, updatedAt',
      settings: 'id',
      outbox: '++seq, table, recordId',
      meta: 'key',
    });
    this.version(2).stores({
      foods: 'id, barcode, name, updatedAt',
      entries: 'id, date, foodId, at, updatedAt',
      days: 'id, updatedAt',
      goals: 'id, effectiveFrom, updatedAt',
    });
    this.version(3).stores({
      supplements: 'id, name, updatedAt',
      stacks: 'id, updatedAt',
      supplogs: 'id, date, supplementId, [supplementId+date], takenAt, updatedAt',
      notes: 'id, at, updatedAt',
    });
  }
}

export const db = new TapInDB();

export type SyncedTable = 'settings' | 'exercises' | 'plans' | 'workouts' | 'sessions' | 'sets' | 'bodyweight' | 'foods' | 'entries' | 'days' | 'goals' | 'supplements' | 'stacks' | 'supplogs' | 'notes';

export const uuid = () => crypto.randomUUID();

/** Local-first write: record + outbox entry in one transaction. Instant, works offline. */
export async function save<T extends Base>(table: SyncedTable, rec: T): Promise<T> {
  const now = Date.now();
  const next = { ...rec, updatedAt: now, createdAt: rec.createdAt ?? now };
  await db.transaction('rw', db.table(table), db.outbox, async () => {
    await db.table(table).put(next);
    await db.outbox.add({ table, recordId: next.id, at: now });
  });
  changed();
  return next;
}

/** Listeners notified after every local write (the sync scheduler subscribes). */
// kept on globalThis so a hot-reloaded module (dev) shares the same set the sync scheduler subscribed to
const g = globalThis as unknown as { __tapinListeners?: Set<() => void> };
const listeners = (g.__tapinListeners ??= new Set<() => void>());
export const onLocalChange = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const changed = () => listeners.forEach((f) => f());

export function newRecord<T extends object>(fields: T): T & Base {
  const now = Date.now();
  return { id: uuid(), createdAt: now, updatedAt: now, deletedAt: null, ...fields };
}

/** Soft delete so deletions sync. */
export async function remove(table: SyncedTable, id: string) {
  const rec = await db.table(table).get(id);
  if (!rec) throw new Error(`No ${table} record with id "${id}"`); // never report success for an unknown id
  if (!rec.deletedAt) await save(table, { ...rec, deletedAt: Date.now() }); // deleting twice is a no-op
}

export const alive = <T extends Base>(r: T | undefined): r is T => !!r && !r.deletedAt;
