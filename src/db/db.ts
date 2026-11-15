import Dexie, { type Table } from 'dexie';
import type {
  Base, BodyweightEntry, Exercise, OutboxEntry, Plan, Session, SetLog, Settings, Workout,
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
  }
}

export const db = new TapInDB();

export type SyncedTable = 'exercises' | 'plans' | 'workouts' | 'sessions' | 'sets' | 'bodyweight';

export const uuid = () => crypto.randomUUID();

/** Local-first write: record + outbox entry in one transaction. Instant, works offline. */
export async function save<T extends Base>(table: SyncedTable, rec: T): Promise<T> {
  const now = Date.now();
  const next = { ...rec, updatedAt: now, createdAt: rec.createdAt ?? now };
  await db.transaction('rw', db.table(table), db.outbox, async () => {
    await db.table(table).put(next);
    await db.outbox.add({ table, recordId: next.id, at: now });
  });
  return next;
}

export function newRecord<T extends object>(fields: T): T & Base {
  const now = Date.now();
  return { id: uuid(), createdAt: now, updatedAt: now, deletedAt: null, ...fields };
}

/** Soft delete so deletions sync. */
export async function remove(table: SyncedTable, id: string) {
  const rec = await db.table(table).get(id);
  if (rec) await save(table, { ...rec, deletedAt: Date.now() });
}

export const alive = <T extends Base>(r: T | undefined): r is T => !!r && !r.deletedAt;
