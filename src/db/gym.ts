import { db, newRecord, save, uuid, alive } from './db';
import { getSettings, updateSettings } from './settings';
import type { Exercise, Plan, Session, SetLog, Workout, WorkoutItem } from './types';

export function newItem(ex: Exercise): WorkoutItem {
  return { key: uuid(), exerciseId: ex.id, sets: 3, rest: { mode: 'timer' } };
}

export async function createPlan(name: string) {
  const plan: Plan = await save('plans', newRecord({ name, workoutIds: [] as string[] }));
  const s = await getSettings();
  if (!s.activePlanId) await updateSettings({ activePlanId: plan.id }); // via outbox so it syncs
  return plan;
}

export async function createWorkout(plan: Plan, name: string) {
  const w = await save('workouts', newRecord({ planId: plan.id, name, items: [] as WorkoutItem[] }));
  await save('plans', { ...plan, workoutIds: [...plan.workoutIds, w.id] });
  return w;
}

/** Next workout in the rotation = the one after the most recently finished workout of this plan. */
export async function nextWorkoutId(plan: Plan): Promise<string | undefined> {
  const ids = plan.workoutIds;
  if (!ids.length) return undefined;
  const last = await db.sessions
    .orderBy('startedAt').reverse()
    .filter((s) => alive(s) && s.planId === plan.id && !!s.endedAt && !!s.workoutId)
    .first();
  const i = last?.workoutId ? ids.indexOf(last.workoutId) : -1;
  return ids[(i + 1) % ids.length];
}

export async function activeSession(): Promise<Session | undefined> {
  return db.sessions.filter((s) => alive(s) && !s.endedAt).first();
}

export async function startSession(w?: Workout): Promise<Session> {
  const items = (w?.items ?? []).map((i) => ({ ...i }));
  return save('sessions', newRecord({
    workoutId: w?.id, planId: w?.planId, name: w?.name ?? 'Workout',
    startedAt: Date.now(), endedAt: null, items, currentKey: items[0]?.key,
  }));
}

/** Plan structure fields that matter when asking "save changes to the plan?" */
/** Session slots that belong in the plan (not ones kept only to hold the done sets of a replaced exercise). */
export const planItems = (items: WorkoutItem[]) => items.filter((i) => !i.replacedBy);
const sig = (all: WorkoutItem[]) => { const items = planItems(all); return JSON.stringify(items.map((i) => [
  i.exerciseId, i.sets, i.repsMin ?? null, i.repsMax ?? null, i.rest.mode, i.rest.sec ?? null,
  i.supersetId ? items.findIndex((j) => j.supersetId === i.supersetId) : null, i.drops ?? 0, i.warmups ?? 0,
])); };

export async function sessionDiffersFromPlan(s: Session) {
  if (!s.workoutId) return false;
  const w = await db.workouts.get(s.workoutId);
  return !!w && alive(w) && sig(w.items) !== sig(s.items);
}

export async function finishSession(s: Session, updatePlan: boolean) {
  if (updatePlan && s.workoutId) {
    const w = await db.workouts.get(s.workoutId);
    if (w) await save('workouts', { ...w, items: planItems(s.items).map((i) => ({ ...i })) });
  }
  // Drop untouched, unfinished rows so history only holds what happened.
  const sets = await db.sets.where('sessionId').equals(s.id).toArray();
  for (const x of sets) if (!x.doneAt && alive(x)) await save('sets', { ...x, deletedAt: Date.now() });
  await save('sessions', { ...s, endedAt: Date.now() });
}

export async function latestBodyweightKg(): Promise<number | undefined> {
  const e = await db.bodyweight.orderBy('at').reverse().filter(alive).first();
  return e?.kg;
}

/** Done sets of the most recent other session containing this exercise. */
export async function lastPerformance(exerciseId: string, excludeSessionId?: string) {
  const sets = await db.sets
    .where('exerciseId').equals(exerciseId)
    .filter((x) => alive(x) && !!x.doneAt && x.sessionId !== excludeSessionId)
    .toArray();
  if (!sets.length) return undefined;
  const latest = sets.reduce((a, b) => ((a.doneAt ?? 0) > (b.doneAt ?? 0) ? a : b));
  const session = await db.sessions.get(latest.sessionId);
  return { session, sets: sets.filter((x) => x.sessionId === latest.sessionId).sort(setOrder) };
}

export const setOrder = (a: SetLog, b: SetLog) =>
  kindRank(a) - kindRank(b) || a.setNo - b.setNo || (a.dropNo ?? 0) - (b.dropNo ?? 0) || sideRank(a) - sideRank(b);
const kindRank = (s: SetLog) => (s.kind === 'warmup' ? 0 : 1);
const sideRank = (s: SetLog) => (s.side === 'left' ? 0 : s.side === 'right' ? 1 : 0);
