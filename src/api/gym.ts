import { z } from 'zod';
import { defineCommand, zDate, zId } from './registry';
import { alive, db, newRecord, remove, save, uuid } from '../db/db';
import { createPlan, createWorkout, finishSession, latestBodyweightKg, newItem, planItems, setOrder, startSession } from '../db/gym';
import { getSettings, updateSettings } from '../db/settings';
import type { Exercise, Session, SetLog, SurveyBody, SurveySleep, Workout, WorkoutItem } from '../db/types';
import { normalizeSupersets, toggleSupersetWithNext } from '../components/ItemSettings';
import { defaultStepKg, e1rm, progressionTarget, RELIABLE_MAX_RTF, rirToRpe, rpeToRir, setE1rm, snappedStepKg, totalLoadKg, TARGET_RIR } from '../lib/science';
import { exerciseUsage, searchExercises } from '../db/exerciseSearch';
import { dateKey, keyToDate } from '../lib/nutrition';
import { exerciseLabel } from '../lib/equipment';
import { planStart, planWeek } from '../lib/planWeek';
import { bestSet, compareToPrevious, e1rmMargin, personalRecords, setE1rmView, setsByMuscle, toStatSet, volumeKg, weekStartMs, workingSetCount, type BestSet } from '../lib/workoutStats';

const zLoadType = z.enum(['weighted', 'bodyweight', 'assisted']);
const zItemPatch = z.object({
  sets: z.number().int().min(1).max(20).optional(),
  repsMin: z.number().int().min(0).nullable().optional(), repsMax: z.number().int().min(0).nullable().optional(),
  warmups: z.number().int().min(0).max(6).optional(), drops: z.number().int().min(0).max(4).optional(),
  rest: z.object({ mode: z.enum(['timer', 'countup']), sec: z.number().int().min(15).max(600).optional() }).optional(),
  notes: z.string().nullable().optional(),
}).describe('Fields of an exercise slot to change');

const need = async <T>(p: Promise<T | undefined>, what: string) => { const v = await p; if (!v || (v as { deletedAt?: number | null }).deletedAt) throw new Error(`${what} not found`); return v; };
// name + equipment ("Bench Press · Dumbbell") so same-named variants are distinguishable to the agent
const exName = async (id: string) => { const e = await db.exercises.get(id); return e ? exerciseLabel(e) : id; };
const applyPatch = (it: WorkoutItem, p: z.infer<typeof zItemPatch>): WorkoutItem => ({
  ...it, ...p, repsMin: p.repsMin === null ? undefined : p.repsMin ?? it.repsMin, repsMax: p.repsMax === null ? undefined : p.repsMax ?? it.repsMax,
  notes: p.notes === null ? undefined : p.notes ?? it.notes, rest: p.rest ?? it.rest,
});

// ---------------- exercises ----------------
export const exercisesSearch = defineCommand({
  name: 'exercises.search', kind: 'query',
  description: 'Find exercises by name (typo-tolerant, any word order, gym shorthand like "db", "rdl", "ohp"). Returns id, name, muscles, equipment, loadType, unilateral.',
  input: z.object({ query: z.string(), muscle: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }),
  run: async ({ query, muscle, limit }) => {
    const all = (await db.exercises.toArray()).filter((e) => alive(e) && (!muscle || e.muscles.includes(muscle)));
    return searchExercises(all, query, await exerciseUsage(), limit)
      .map((e) => ({ id: e.id, name: e.name, muscles: e.muscles, equipment: e.equipment, loadType: e.loadType, unilateral: e.unilateral, mechanic: e.mechanic, custom: !!e.custom }));
  },
});

export const exercisesCreate = defineCommand({
  name: 'exercises.create', kind: 'action',
  description: 'Create a custom exercise. loadType: weighted (log the weight), bodyweight (log added weight), assisted (log assistance). unilateral = log left/right separately. muscles: main muscle first. Returns the saved exercise record (use its id with items.add).',
  input: z.object({ name: z.string().min(1), mechanic: z.enum(['compound', 'isolation']).default('compound'), equipment: z.string().default('other'),
    loadType: zLoadType.default('weighted'), unilateral: z.boolean().default(false), muscles: z.array(z.string()).default([]) }),
  run: async (i) => save('exercises', newRecord({ ...i, secondary: [], images: [], custom: true })),
});

export const exercisesUpdate = defineCommand({
  name: 'exercises.update', kind: 'action',
  description: 'Change an exercise (name, type, equipment, load type, one-side flag, muscles with the main one first, stepKg = preferred weight-wheel increment in kg). Only given fields change. Returns the updated exercise record.',
  input: z.object({ id: zId, name: z.string().min(1).optional(), mechanic: z.enum(['compound', 'isolation']).optional(), equipment: z.string().optional(),
    loadType: zLoadType.optional(), unilateral: z.boolean().optional(), muscles: z.array(z.string()).optional(),
    stepKg: z.number().positive().optional().describe('Weight step in kg used by the weight picker for this exercise') }),
  run: async ({ id, ...p }) => { const e = await need(db.exercises.get(id), 'Exercise'); return save('exercises', { ...e, ...p } as Exercise); },
});

export const exercisesDuplicate = defineCommand({
  name: 'exercises.duplicate', kind: 'action',
  description: 'Make a custom copy of an exercise (same type, equipment, load type, one-side flag, muscles, images and instructions) with its own separate history. Use it when the user has two versions of the same exercise whose loads are not comparable, e.g. two different chest press machines at different gyms ("Chest Press · Gym A"). name defaults to "<original name> (copy)". Returns the new exercise record.',
  input: z.object({ id: zId, name: z.string().trim().min(1).optional().describe('Name for the copy; defaults to "<original name> (copy)"') }),
  run: async ({ id, name }) => {
    const e = await need(db.exercises.get(id), 'Exercise');
    return save('exercises', newRecord({
      name: name ?? `${e.name} (copy)`, mechanic: e.mechanic, equipment: e.equipment, loadType: e.loadType, unilateral: e.unilateral,
      muscles: [...e.muscles], secondary: [...e.secondary], images: [...e.images], instructions: e.instructions && [...e.instructions],
      stepKg: e.stepKg, custom: true,
    }) as Exercise);
  },
});

export const exercisesDelete = defineCommand({
  name: 'exercises.delete', kind: 'action',
  description: 'Delete a custom exercise (built-in library exercises cannot be deleted). Refused while it is used in a plan workout or in the workout in progress (the error names them; remove or replace it there first). Past sessions keep their logged sets and still show the exercise in history and summaries; it just disappears from search and the picker.',
  input: z.object({ id: zId }),
  run: async ({ id }) => {
    const e = await need(db.exercises.get(id), 'Exercise');
    if (!e.custom) throw new Error(`"${exerciseLabel(e)}" is a built-in exercise and can't be deleted`);
    const plans = new Map((await db.plans.filter(alive).toArray()).map((p) => [p.id, p]));
    const inPlans = (await db.workouts.filter((w) => alive(w) && plans.has(w.planId) && w.items.some((i) => i.exerciseId === id)).toArray())
      .map((w) => `${plans.get(w.planId)!.name} → ${w.name}`);
    const live = await db.sessions.filter((x) => alive(x) && !x.endedAt && x.items.some((i) => i.exerciseId === id)).first();
    if (inPlans.length || live) throw new Error(`"${exerciseLabel(e)}" is still used in ${[...inPlans, ...(live ? ['the workout in progress'] : [])].join(', ')}. Remove or replace it there first.`);
    await remove('exercises', id);
    return { ok: true };
  },
});

// ---------------- plans & workouts ----------------
export const plansList = defineCommand({
  name: 'plans.list', kind: 'query',
  description: 'All workout plans with their workouts (in rotation order), each workout\'s exercises, which plan is active, startDate (YYYY-MM-DD the plan\'s weeks count from: the start date set with plans.update, else the day the plan was created) and week (the plan\'s current week number, 1-based; Week 1 is the Monday-start week holding startDate).',
  input: z.object({}),
  run: async () => {
    const s = await getSettings();
    const plans = await db.plans.filter(alive).toArray();
    return Promise.all(plans.map(async (p) => ({
      id: p.id, name: p.name, active: s.activePlanId === p.id, startDate: planStart(p), week: planWeek(p),
      workouts: await Promise.all((await db.workouts.bulkGet(p.workoutIds)).filter((w) => w && alive(w)).map(async (w) => ({
        id: w!.id, name: w!.name,
        items: await Promise.all(w!.items.map(async (i) => ({ key: i.key, exerciseId: i.exerciseId, exercise: await exName(i.exerciseId), sets: i.sets, repsMin: i.repsMin, repsMax: i.repsMax, warmups: i.warmups, drops: i.drops, rest: i.rest, supersetId: i.supersetId, notes: i.notes }))),
      }))),
    })));
  },
});

export const plansCreate = defineCommand({ name: 'plans.create', kind: 'action', description: 'Create an empty workout plan (becomes the active plan if none is). Returns the plan record (id, name, workoutIds).',
  input: z.object({ name: z.string().min(1) }), run: async ({ name }) => createPlan(name) });
export const plansRename = defineCommand({ name: 'plans.rename', kind: 'action', description: 'Rename a plan. Returns the plan record.',
  input: z.object({ id: zId, name: z.string().min(1) }), run: async ({ id, name }) => save('plans', { ...(await need(db.plans.get(id), 'Plan')), name }) });
export const plansUpdate = defineCommand({ name: 'plans.update', kind: 'action',
  description: 'Change a plan\'s name and/or startDate; only the fields you pass change. startDate (YYYY-MM-DD) sets where "Week N" counts from (Week 1 = the Monday-start week holding it); null goes back to counting from the day the plan was created. Returns the plan record.',
  input: z.object({ id: zId, name: z.string().trim().min(1).optional(), startDate: zDate.nullable().optional() }),
  run: async ({ id, name, startDate }) => {
    const p = { ...(await need(db.plans.get(id), 'Plan')) };
    if (name !== undefined) p.name = name;
    if (startDate !== undefined) p.startDate = startDate ?? undefined;
    return save('plans', p);
  } });
export const plansDelete = defineCommand({ name: 'plans.delete', kind: 'action', description: 'Delete a plan and its workouts (past workout sessions stay in history). If it was the active plan, no plan is active afterwards.',
  input: z.object({ id: zId }), run: async ({ id }) => {
    const plan = await need(db.plans.get(id), 'Plan');
    for (const w of await db.workouts.bulkGet(plan.workoutIds)) if (w && !w.deletedAt) await remove('workouts', w.id);
    await remove('plans', id); const s = await getSettings(); if (s.activePlanId === id) await updateSettings({ activePlanId: undefined }); return { ok: true }; } });
export const plansSetActive = defineCommand({ name: 'plans.setActive', kind: 'action', description: 'Make a plan the active one (Home suggests its next workout).',
  input: z.object({ id: zId }), run: async ({ id }) => { await need(db.plans.get(id), 'Plan'); await updateSettings({ activePlanId: id }); return { ok: true }; } });
export const plansReorder = defineCommand({ name: 'plans.reorderWorkouts', kind: 'action', description: 'Set the rotation order of a plan\'s workouts: pass the full list of workout ids in the new order. Returns the plan record.',
  input: z.object({ id: zId, workoutIds: z.array(zId) }), run: async ({ id, workoutIds }) => save('plans', { ...(await need(db.plans.get(id), 'Plan')), workoutIds }) });

export const workoutsCreate = defineCommand({ name: 'workouts.create', kind: 'action', description: 'Add an empty workout (e.g. "Push A") to the end of a plan\'s rotation. Returns the workout record. To build a whole workout in one request, follow it with items.add using workoutId "$<index>.id" (see request_changes).',
  input: z.object({ planId: zId, name: z.string().min(1) }), run: async ({ planId, name }) => createWorkout(await need(db.plans.get(planId), 'Plan'), name) });
export const workoutsRename = defineCommand({ name: 'workouts.rename', kind: 'action', description: 'Rename a plan workout. Returns the workout record.',
  input: z.object({ id: zId, name: z.string().min(1) }), run: async ({ id, name }) => save('workouts', { ...(await need(db.workouts.get(id), 'Workout')), name }) });
export const workoutsDelete = defineCommand({ name: 'workouts.delete', kind: 'action', description: 'Delete a workout and take it out of its plan\'s rotation. Past sessions of it stay in history.',
  input: z.object({ id: zId }), run: async ({ id }) => {
    const w = await need(db.workouts.get(id), 'Workout'); const p = await db.plans.get(w.planId);
    if (p) await save('plans', { ...p, workoutIds: p.workoutIds.filter((x) => x !== id) });
    await remove('workouts', id); return { ok: true };
  } });

/** Structure edits shared by plan workouts and live/finished sessions (same rules everywhere). */
async function editItems(target: { workoutId?: string; sessionId?: string }, fn: (items: WorkoutItem[]) => WorkoutItem[] | Promise<WorkoutItem[]>,
  pickCurrent?: (before: WorkoutItem[], after: WorkoutItem[], currentKey?: string) => string | undefined) {
  if (target.sessionId) {
    const s = await need(db.sessions.get(target.sessionId), 'Session');
    const before = s.items;
    const items = normalizeSupersets(await fn(s.items));
    const picked = pickCurrent?.(before, items, s.currentKey);
    return save('sessions', { ...s, items, currentKey: picked ?? (items.some((i) => i.key === s.currentKey) ? s.currentKey : items[0]?.key) } as Session);
  }
  const w = await need(db.workouts.get(target.workoutId!), 'Workout');
  return save('workouts', { ...w, items: normalizeSupersets(await fn(w.items)) } as Workout);
}
const mustHave = (items: WorkoutItem[], key: string) => { if (!items.some((i) => i.key === key)) throw new Error(`Item ${key} not found (item keys come from plans.list or sessions.active/get)`); return items; };
const zTarget = {
  workoutId: zId.optional().describe('Id of a plan workout to edit (from plans.list). Give this OR sessionId, not both.'),
  sessionId: zId.optional().describe('Id of a workout session to edit (live or finished, from sessions.active/get). Give this OR workoutId.'),
};
const zTargetRefine = <T extends z.ZodObject>(o: T) => o.refine((v: { workoutId?: string; sessionId?: string }) => !!v.workoutId !== !!v.sessionId, 'Give exactly one of workoutId or sessionId');

const zNewItem = zItemPatch.omit({ notes: true, repsMin: true, repsMax: true }).extend({
  exerciseId: zId, repsMin: z.number().int().min(0).optional(), repsMax: z.number().int().min(0).optional(), notes: z.string().optional(),
}).refine((v) => v.repsMin == null || v.repsMax == null || v.repsMin <= v.repsMax, 'repsMin must be ≤ repsMax').describe('One exercise to add, with its targets (same fields as items.update patch)');
export const itemsAdd = defineCommand({ name: 'items.add', kind: 'action',
  description: 'Add exercises (each with its own sets, rep range, rest, warm-ups, drop sets and notes) to the end of a plan workout or a workout session (mid-workout too). ' +
    'Give items: [{ exerciseId, sets?, repsMin?, repsMax?, warmups?, drops?, rest?: { mode: "timer", sec? } | { mode: "countup" }, notes? }] for fully specified exercises, ' +
    'or the short form exerciseIds + sets (same set count for all, no targets). Default 3 sets, timer rest at the default length. In a session, makeCurrent=true also switches the current exercise to the first one added. Returns the updated workout/session record (new slots are at the end of items).',
  input: zTargetRefine(z.object({ ...zTarget, exerciseIds: z.array(zId).min(1).optional(), items: z.array(zNewItem).min(1).max(30).optional(),
    sets: z.number().int().min(1).max(20).optional().describe('Short form only: sets for every exercise in exerciseIds'),
    makeCurrent: z.boolean().optional().describe('Session only: make the first added exercise the current one') }))
    .refine((v) => !!v.exerciseIds !== !!v.items, 'Give exactly one of exerciseIds or items'),
  run: async ({ exerciseIds, items: specs, sets, makeCurrent, ...t }) => editItems(t, async (items) => {
    const list = specs ?? exerciseIds!.map((exerciseId) => ({ exerciseId, sets }));
    const ids = list.map((x) => x.exerciseId);
    const found = await db.exercises.bulkGet(ids);
    const missing = ids.filter((_, i) => !found[i] || found[i]!.deletedAt);
    if (missing.length) throw new Error(`Exercise not found: ${missing.join(', ')} (use exercises.search to get ids)`);
    const defined = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    return [...items, ...list.map(({ exerciseId: _id, ...p }, i) => applyPatch({ ...newItem(found[i] as Exercise), sets: 3 }, defined(p)))];
  }, makeCurrent ? (before, after) => after[before.length]?.key : undefined) });
export const itemsUpdate = defineCommand({ name: 'items.update', kind: 'action',
  description: 'Change an exercise slot: sets, target reps, warm-ups, drop sets, rest, notes. Only fields in patch change; null clears repsMin/repsMax/notes. Works on plan workouts and sessions (in a session it edits the session copy only; sessions.finish with updatePlan=true carries it to the plan). In a session, lowering sets / warmups / drops deletes the extra sets of that slot beyond the new count (done ones too, so they no longer count anywhere); check sessions.get first if done sets would be lost. Returns the updated workout/session record.',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string(), patch: zItemPatch })),
  run: async ({ itemKey, patch, ...t }) => {
    if (t.sessionId) {
      const sess = await need(db.sessions.get(t.sessionId), 'Session');
      const it = mustHave(sess.items, itemKey).find((i) => i.key === itemKey)!;
      const next = applyPatch(it, patch);
      for (const x of await setsBeyond(t.sessionId, next)) await remove('sets', x.id);
    }
    return editItems(t, (items) => mustHave(items, itemKey).map((i) => (i.key === itemKey ? applyPatch(i, patch) : i)));
  } });
/** Session sets of a slot that no longer have a row after a structure change (fewer sets / warm-ups / drops). */
export const setBeyond = (x: Pick<SetLog, 'itemKey' | 'kind' | 'setNo' | 'dropNo'>, it: WorkoutItem) => x.itemKey === it.key && (
  x.kind === 'warmup' ? x.setNo > (it.warmups ?? 0) : x.setNo > it.sets || (x.kind === 'drop' && (x.dropNo ?? 0) > (it.drops ?? 0)));
export async function setsBeyond(sessionId: string, it: WorkoutItem) {
  return db.sets.where('sessionId').equals(sessionId).filter((x) => alive(x) && setBeyond(x, it)).toArray();
}
export const itemsRemove = defineCommand({ name: 'items.remove', kind: 'action',
  description: 'Remove an exercise slot. In a session this also deletes all of that slot’s sets (done or not) in the session. Returns the updated workout/session record.',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string() })),
  run: async ({ itemKey, ...t }) => {
    if (t.sessionId) for (const s of await db.sets.where('sessionId').equals(t.sessionId).filter((x) => x.itemKey === itemKey).toArray()) await remove('sets', s.id);
    return editItems(t, (items) => mustHave(items, itemKey).filter((i) => i.key !== itemKey));
  } });
export const itemsRestore = defineCommand({ name: 'items.restore', kind: 'action',
  description: 'Put back an exercise slot removed from a plan workout with items.remove (undo): pass the removed item exactly as it was and the position it had. Plan workouts only (a session slot’s sets are deleted with it). No-op if the item key is already there. supersetWith: keys of the slots that were in the same superset as the removed one (removing it may have dissolved that superset), so the group comes back too. Returns the updated workout.',
  input: z.object({ workoutId: zId, index: z.number().int().min(0), item: z.looseObject({ key: z.string(), exerciseId: zId, sets: z.number().int().min(1).max(20), supersetId: z.string().optional() }),
    supersetWith: z.array(z.string()).optional() }),
  run: async ({ workoutId, index, item, supersetWith }) => {
    await need(db.exercises.get(item.exerciseId), 'Exercise');
    return editItems({ workoutId }, (items) => {
      if (items.some((i) => i.key === item.key)) return items;
      const back = items.map((i) => (item.supersetId && supersetWith?.includes(i.key) ? { ...i, supersetId: item.supersetId } : i));
      return [...back.slice(0, index), item as unknown as WorkoutItem, ...back.slice(index)];
    });
  } });
export const itemsReplace = defineCommand({ name: 'items.replace', kind: 'action',
  description: 'Swap the exercise in a slot for another (keeps sets/reps/supersets/notes). The new exercise gets a NEW item key. In a plan workout, or in a session where the old exercise has no done sets, it simply takes over that position. In a session where the old exercise already has done sets, those stay as that exercise: the old slot is kept (trimmed to its done sets, out of any superset, marked replacedBy=<new key>, never copied to the plan by sessions.finish updatePlan) and placed just before the new one (before the superset, which the new exercise stays in). Unfinished sets of the old exercise are cleared. If the old slot was current, the new one becomes current. Returns the updated workout/session record.',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string(), exerciseId: zId })),
  run: async ({ itemKey, exerciseId, ...t }) => {
    await need(db.exercises.get(exerciseId), 'Exercise');
    let done: SetLog[] = [];
    if (t.sessionId) {
      const mine = await db.sets.where('sessionId').equals(t.sessionId).filter((x) => alive(x) && x.itemKey === itemKey).toArray();
      for (const s of mine.filter((x) => !x.doneAt)) await remove('sets', s.id);
      done = mine.filter((x) => !!x.doneAt);
    }
    const key = uuid();
    return editItems(t, (items) => {
      const i = mustHave(items, itemKey).findIndex((x) => x.key === itemKey);
      const old = items[i];
      const fresh: WorkoutItem = { ...old, key, exerciseId, rest: { mode: old.rest.mode }, replacedBy: undefined };
      if (!done.length) return items.map((x) => (x.key === itemKey ? fresh : x));
      const maxNo = (k: SetLog['kind']) => Math.max(0, ...done.filter((x) => x.kind === k).map((x) => x.setNo));
      const kept: WorkoutItem = { ...old, sets: Math.max(1, maxNo('working'), maxNo('drop')), warmups: maxNo('warmup'),
        drops: Math.max(0, ...done.map((x) => x.dropNo ?? 0)), supersetId: undefined, replacedBy: key };
      // the kept slot leaves its superset and goes just before it (or just before the new slot), so the group stays together
      const out = items.map((x) => (x.key === itemKey ? fresh : x));
      const at = old.supersetId ? out.findIndex((x) => x.supersetId === old.supersetId) : i;
      out.splice(at, 0, kept);
      return out;
    }, t.sessionId ? (_b, _a, cur) => (cur === itemKey || !cur ? key : undefined) : undefined);
  } });
export const itemsReorder = defineCommand({ name: 'items.reorder', kind: 'action',
  description: 'Put all exercise slots of a plan workout or session in a new order: itemKeys must list every current item key exactly once, in the new order. Supersets that end up split apart are dissolved. Returns the updated workout/session record.',
  input: zTargetRefine(z.object({ ...zTarget, itemKeys: z.array(z.string()) })),
  run: async ({ itemKeys, ...t }) => editItems(t, (items) => {
    const byKey = new Map(items.map((i) => [i.key, i]));
    if (itemKeys.length !== items.length || new Set(itemKeys).size !== itemKeys.length || itemKeys.some((k) => !byKey.has(k)))
      throw new Error(`itemKeys must contain each current item key exactly once (current: ${items.map((i) => i.key).join(', ')})`);
    return itemKeys.map((k) => byKey.get(k)!);
  }) });
export const itemsMove = defineCommand({ name: 'items.move', kind: 'action', description: 'Move one exercise slot to a new position (0-based). To apply a whole new order use items.reorder.',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string(), toIndex: z.number().int().min(0) })),
  run: async ({ itemKey, toIndex, ...t }) => editItems(t, (items) => {
    const from = items.findIndex((i) => i.key === itemKey); if (from < 0) throw new Error('Item not found');
    const next = [...items]; const [it] = next.splice(from, 1); next.splice(Math.min(toIndex, next.length), 0, it); return next;
  }) });
export const itemsSuperset = defineCommand({ name: 'items.toggleSupersetWithNext', kind: 'action',
  description: 'Join an exercise and the one after it into a superset (alternating sets), or split them if already joined.',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string() })),
  run: async ({ itemKey, ...t }) => editItems(t, (items) => {
    const i = mustHave(items, itemKey).findIndex((x) => x.key === itemKey);
    if (i === items.length - 1) throw new Error('This is the last exercise — there is no next one to superset with');
    return toggleSupersetWithNext(items, i);
  }) });

// ---------------- sessions ----------------
async function sessionView(s: Session) {
  const sets = (await db.sets.where('sessionId').equals(s.id).filter(alive).toArray()).sort(setOrder);
  const setOut = (x: SetLog) => ({ id: x.id, kind: x.kind, setNo: x.setNo, dropNo: x.dropNo, side: x.side, loadKg: x.loadKg, loadType: x.loadType, bodyweightKg: x.bodyweightKg, reps: x.reps, rir: x.rir, rpe: x.rpe, effortInput: x.effortInput ?? null, done: !!x.doneAt, e1rm: setE1rmView(x) });
  return {
    id: s.id, name: s.name, startedAt: new Date(s.startedAt).toISOString(), endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    live: !s.endedAt, currentItemKey: s.currentKey, notes: s.notes, workoutId: s.workoutId,
    survey: { sessionRpe: s.sessionRpe ?? null, sleep: s.sleep ?? null, soreness: s.soreness ?? null, ratedAt: s.ratedAt ? new Date(s.ratedAt).toISOString() : null },
    items: await Promise.all(s.items.map(async (i) => ({
      key: i.key, exerciseId: i.exerciseId, exercise: await exName(i.exerciseId), plannedSets: i.sets, repsMin: i.repsMin, repsMax: i.repsMax,
      warmups: i.warmups, drops: i.drops, supersetId: i.supersetId, notes: i.notes, replacedBy: i.replacedBy,
      sets: sets.filter((x) => x.itemKey === i.key).map(setOut),
    }))),
  };
}

export const sessionsActive = defineCommand({ name: 'sessions.active', kind: 'query', description: 'The workout in progress (with exercises and logged sets), or null.',
  input: z.object({}), run: async () => { const s = await db.sessions.filter((x) => alive(x) && !x.endedAt).first(); return s ? sessionView(s) : null; } });
export const sessionsGet = defineCommand({ name: 'sessions.get', kind: 'query', description: 'One workout session with every exercise and set. Each set has rir/rpe as stored (effortInput = the scale the user entered; the other is derived only where the RIR-based RPE scale maps one-to-one, else null) and e1rm = the set table score for working sets: {kg, reliable (≤' + RELIABLE_MAX_RTF + ' reps to failure), lowerBound (no effort logged: reps alone, real e1RM ≥ kg), repsToFailure} (Wathen on reps + RIR, total load incl. bodyweight), null for warm-ups/drops or when it cannot be estimated.',
  input: z.object({ id: zId }), run: async ({ id }) => sessionView(await need(db.sessions.get(id), 'Session')) });
export const sessionsList = defineCommand({ name: 'sessions.list', kind: 'query',
  description: 'Finished workout sessions between two dates (inclusive), newest first: id, name, date, duration, setsDone (working sets, counted like sessions.summary totals.workingSets: a left+right pair is 1, drop steps fold in, warm-ups excluded).',
  input: z.object({ from: zDate.optional(), to: zDate.optional(), limit: z.number().int().min(1).max(500).default(50) }),
  run: async ({ from, to, limit }) => {
    const lo = from ? keyToDate(from).getTime() : 0; const hi = to ? keyToDate(to).getTime() + 86400000 : Date.now() + 86400000;
    const list = await db.sessions.where('startedAt').between(lo, hi).filter((s) => alive(s) && !!s.endedAt).reverse().limit(limit).toArray();
    return Promise.all(list.map(async (s) => ({ id: s.id, name: s.name, date: dateKey(s.startedAt), minutes: Math.round(((s.endedAt ?? s.startedAt) - s.startedAt) / 60000),
      setsDone: workingSetCount(await db.sets.where('sessionId').equals(s.id).filter((x) => alive(x) && !!x.doneAt).toArray()) })));
  } });
export const sessionsStart = defineCommand({ name: 'sessions.start', kind: 'action',
  description: 'Start a workout. With workoutId it copies that plan workout; without, starts an empty workout. If one is already running, returns it instead.',
  input: z.object({ workoutId: zId.optional() }),
  run: async ({ workoutId }) => {
    const cur = await db.sessions.filter((x) => alive(x) && !x.endedAt).first();
    if (cur) return { alreadyRunning: true, session: await sessionView(cur) };
    const s = await startSession(workoutId ? await need(db.workouts.get(workoutId), 'Workout') : undefined);
    return { alreadyRunning: false, session: await sessionView(s) };
  } });
export const sessionsFinish = defineCommand({ name: 'sessions.finish', kind: 'action',
  description: 'Finish a live workout (end time = now). Unchecked sets are deleted. updatePlan=true copies the session structure (exercises, order, sets, reps, rest, supersets, warm-ups, drops, notes) back to the plan workout it came from.',
  input: z.object({ id: zId, updatePlan: z.boolean().default(false) }),
  run: async ({ id, updatePlan }) => { await finishSession(await need(db.sessions.get(id), 'Session'), updatePlan); return { ok: true }; } });
export const sessionsUpdate = defineCommand({ name: 'sessions.update', kind: 'action',
  description: 'Edit a session\'s name, notes (null clears), start time (ISO), duration in minutes (finished sessions only), current exercise (currentItemKey), or resume=true to reopen a finished one as live. Only given fields change. Returns the session record.',
  input: z.object({ id: zId, name: z.string().optional(), notes: z.string().nullable().optional(), startedAt: z.string().datetime({ offset: true }).optional(),
    durationMin: z.number().positive().optional(), currentItemKey: z.string().optional(), resume: z.boolean().optional() }),
  run: async ({ id, name, notes, startedAt, durationMin, currentItemKey, resume }) => {
    const s = await need(db.sessions.get(id), 'Session');
    const start = startedAt ? Date.parse(startedAt) : s.startedAt;
    return save('sessions', { ...s, name: name ?? s.name, notes: notes === null ? undefined : notes ?? s.notes, startedAt: start,
      endedAt: resume ? null : durationMin && s.endedAt ? start + durationMin * 60000 : s.endedAt, currentKey: currentItemKey ?? s.currentKey });
  } });
/** A finished session's structure as fresh slots: replaced-exercise slots dropped (they only hold old done sets),
 *  slots whose exercise was deleted skipped, new item keys and superset ids so nothing collides with the original. */
async function copySessionItems(s: Session) {
  const src = planItems(s.items);
  const exs = await db.exercises.bulkGet(src.map((i) => i.exerciseId));
  const skipped: string[] = [];
  const groups = new Map<string, string>();
  const items: WorkoutItem[] = [];
  src.forEach((i, k) => {
    const ex = exs[k];
    if (!ex || ex.deletedAt) { skipped.push(ex ? exerciseLabel(ex) : i.exerciseId); return; }
    const supersetId = i.supersetId ? groups.get(i.supersetId) ?? (groups.set(i.supersetId, uuid()), groups.get(i.supersetId)!) : undefined;
    items.push({ ...i, key: uuid(), supersetId, replacedBy: undefined, rest: { ...i.rest } });
  });
  return { items: normalizeSupersets(items), skipped };
}

export const sessionsRepeat = defineCommand({ name: 'sessions.repeat', kind: 'action',
  description: 'Repeat a past (finished) workout: starts a NEW live session with the same exercises in the same order, set counts, rep targets, rest, supersets, warm-ups, drop sets and notes (no sets are copied: ' +
    'what to lift comes from history as usual, see exercises.nextTarget). Slots of exercises replaced mid-workout and exercises that were deleted since are left out (listed in skipped). ' +
    'If the original came from a plan workout that still exists, the new session stays linked to it (plan rotation, "save changes to plan" on finish). ' +
    'Refused when a workout is already in progress: then returns { alreadyRunning: true, session } (the live one; resume it or finish/discard it first) and starts nothing. ' +
    'Otherwise returns { alreadyRunning: false, session, skipped }.',
  input: z.object({ id: zId.describe('Id of the finished session to repeat (from sessions.list / progress.sessions)') }),
  run: async ({ id }) => {
    const src = await need(db.sessions.get(id), 'Session');
    if (!src.endedAt) throw new Error('That workout is still in progress; only finished workouts can be repeated');
    const cur = await db.sessions.filter((x) => alive(x) && !x.endedAt).first();
    if (cur) return { alreadyRunning: true as const, session: await sessionView(cur), skipped: [] as string[] };
    const { items, skipped } = await copySessionItems(src);
    if (!items.length) throw new Error('Nothing to repeat: that workout has no exercises left');
    const w = src.workoutId ? await db.workouts.get(src.workoutId) : undefined;
    const linked = !!w && alive(w) && !!(await db.plans.get(w.planId).then((p) => p && alive(p)));
    const s = await save('sessions', newRecord({
      workoutId: linked ? w!.id : undefined, planId: linked ? w!.planId : undefined, name: src.name,
      startedAt: Date.now(), endedAt: null, items, currentKey: items[0].key,
    }) as Session);
    return { alreadyRunning: false as const, session: await sessionView(s), skipped };
  } });

export const workoutsCreateFromSession = defineCommand({ name: 'workouts.createFromSession', kind: 'action',
  description: 'Save a past workout session as a new plan workout ("Save as workout"): copies its exercises, order, set counts, rep targets, rest, supersets, warm-ups, drop sets and notes ' +
    '(not the logged weights/reps) into a new workout at the end of the plan\'s rotation. name defaults to the session name. Replaced-exercise slots and deleted exercises are left out (listed in skipped). ' +
    'Returns { workout, skipped }.',
  input: z.object({ sessionId: zId, planId: zId.describe('Plan to add the workout to (from plans.list)'), name: z.string().trim().min(1).optional() }),
  run: async ({ sessionId, planId, name }) => {
    const s = await need(db.sessions.get(sessionId), 'Session');
    const plan = await need(db.plans.get(planId), 'Plan');
    const { items, skipped } = await copySessionItems(s);
    if (!items.length) throw new Error('Nothing to save: that workout has no exercises left');
    const w = await createWorkout(plan, name ?? s.name);
    return { workout: await save('workouts', { ...w, items } as Workout), skipped };
  } });

export const sessionsDelete = defineCommand({ name: 'sessions.delete', kind: 'action', description: 'Discard a live workout or delete a finished one, with all its sets.',
  input: z.object({ id: zId }), run: async ({ id }) => {
    for (const s of await db.sets.where('sessionId').equals(id).toArray()) await remove('sets', s.id);
    await remove('sessions', id); return { ok: true };
  } });

// ---------------- sets ----------------
/** Effort fields from rir/rpe input: the entered value is stored as given (+ effortInput); the other scale is derived only
 *  where the RIR-based RPE table maps one-to-one, else null (see science.ts rpeToRir/rirToRpe). null -> both cleared; undefined -> unchanged. */
const effortPatch = (rir?: number | null, rpe?: number | null): Partial<SetLog> =>
  rir != null ? { rir, rpe: rirToRpe(rir), effortInput: 'rir' } : rpe != null ? { rpe, rir: rpeToRir(rpe), effortInput: 'rpe' }
    : rir === null || rpe === null ? { rir: null, rpe: null } : {};
/** Load type + bodyweight snapshot, taken once: when the set is created or first checked off. Later edits keep it,
 *  so correcting an old set never rewrites it with today's bodyweight. bodyweightKg given explicitly wins. */
const loadSnapshot = async (ex: Exercise, bodyweightKg?: number | null): Promise<Partial<SetLog>> =>
  ({ loadType: ex.loadType, bodyweightKg: bodyweightKg !== undefined ? bodyweightKg : ex.loadType === 'weighted' ? null : (await latestBodyweightKg()) ?? null });
const zBw = z.number().min(20).max(400).nullable().optional()
  .describe('Bodyweight in kg to store on the set (bodyweight/assisted lifts). Omit to keep the stored snapshot; it is taken automatically from the latest weigh-in when the set is created or first marked done. null clears it.');
export const setsLog = defineCommand({ name: 'sets.log', kind: 'action',
  description: 'Record or correct a set in a session (creates it or updates the matching one). itemKey is the exercise slot key from sessions.active / sessions.get (items[].key). setNo is 1-based within its kind; drop steps use kind "drop" with dropNo; one-side exercises use side left/right. loadKg means: the weight (weighted), added weight (bodyweight) or assistance (assisted). Give rir or rpe (per-set RPE on the RIR-based scale, Zourdos 2016: 10 = failure, 9.5 = no more reps but slightly more load, 9 = 1 rep left … 7 = 3 left, 5–6 = 4–6 left, below 5 = not defined in reps). Pass what the user said, in the scale they used; the other field is derived only where the scale maps one-to-one (else null), never as a plain 10 − x. null clears effort. Omitted fields keep their value. done: true checks it off, false unchecks; omitted keeps an existing set\'s state and marks a new set done. When the set is created it snapshots the exercise load type and (for bodyweight/assisted) the latest bodyweight so e1RM stays right (if no bodyweight was stored, it is filled when the set is checked off); later corrections, un-ticking and re-ticking keep that snapshot unless bodyweightKg is given. Returns the set record.',
  input: z.object({ sessionId: zId, itemKey: z.string(), setNo: z.number().int().min(1), kind: z.enum(['warmup', 'working', 'drop']).default('working'),
    dropNo: z.number().int().min(1).optional(), side: z.enum(['both', 'left', 'right']).default('both'),
    loadKg: z.number().min(0).nullable().optional(), reps: z.number().int().min(0).nullable().optional(),
    rir: z.number().min(0).max(10).nullable().optional(), rpe: z.number().min(1).max(10).nullable().optional(), done: z.boolean().optional(), bodyweightKg: zBw }),
  run: async (i) => {
    const sess = await need(db.sessions.get(i.sessionId), 'Session');
    const item = sess.items.find((x) => x.key === i.itemKey); if (!item) throw new Error('Exercise slot not found in session');
    const ex = await db.exercises.get(item.exerciseId); if (!ex) throw new Error('Exercise not found'); // a deleted custom exercise stays loggable in old sessions
    const existing = await db.sets.where('sessionId').equals(i.sessionId)
      .filter((x) => alive(x) && x.itemKey === i.itemKey && x.kind === i.kind && x.setNo === i.setNo && (x.dropNo ?? 0) === (i.dropNo ?? 0) && x.side === i.side).first();
    const s = await getSettings();
    const base = existing ?? newRecord({ sessionId: i.sessionId, itemKey: i.itemKey, exerciseId: ex.id, setNo: i.setNo, kind: i.kind, dropNo: i.dropNo, side: i.side,
      loadType: ex.loadType, inputUnit: s.unit, loadKg: null, reps: null, doneAt: null } as Omit<SetLog, 'id' | 'createdAt' | 'updatedAt'>);
    const done = i.done ?? (existing ? !!existing.doneAt : true);
    // snapshot on create; on a later first tick only when nothing was stored (no weigh-in back then), so un-tick / re-tick never rewrites it
    const fill = done && !base.doneAt && base.bodyweightKg == null && ex.loadType !== 'weighted';
    const snap = !existing || fill ? await loadSnapshot(ex, i.bodyweightKg) : i.bodyweightKg !== undefined ? { bodyweightKg: i.bodyweightKg } : {};
    return save('sets', { ...base, loadKg: i.loadKg !== undefined ? i.loadKg : base.loadKg, reps: i.reps !== undefined ? i.reps : base.reps,
      ...effortPatch(i.rir, i.rpe), ...snap,
      ...(i.loadKg !== undefined || (done && !base.doneAt) ? { inputUnit: s.unit } : {}),
      doneAt: done ? base.doneAt ?? Date.now() : null } as SetLog);
  } });
export const setsUpdate = defineCommand({ name: 'sets.update', kind: 'action', description: 'Correct a logged set by id (loadKg, reps, rir or rpe with null clearing effort, done, bodyweightKg). Only given fields change. The load type / bodyweight snapshot is kept as stored, except that a missing bodyweight snapshot is filled from the latest weigh-in when the set is checked off (like sets.log), or bodyweightKg is given. Returns the set record.',
  input: z.object({ id: zId, loadKg: z.number().min(0).nullable().optional(), reps: z.number().int().min(0).nullable().optional(),
    rir: z.number().min(0).max(10).nullable().optional(), rpe: z.number().min(1).max(10).nullable().optional(), done: z.boolean().optional(), bodyweightKg: zBw }),
  run: async ({ id, rir, rpe, done, bodyweightKg, ...p }) => {
    const x = await need(db.sets.get(id), 'Set');
    const ex = await db.exercises.get(x.exerciseId);
    const firstDone = !!done && !x.doneAt;
    const unit = p.loadKg !== undefined || firstDone ? { inputUnit: (await getSettings()).unit } : {};
    const fill = firstDone && !!ex && ex.loadType !== 'weighted' && x.bodyweightKg == null; // only fills a missing snapshot
    const snap = fill ? await loadSnapshot(ex!, bodyweightKg) : bodyweightKg !== undefined ? { bodyweightKg } : {};
    return save('sets', { ...x, ...p, ...effortPatch(rir, rpe), ...snap, ...unit,
      doneAt: done === undefined ? x.doneAt : done ? x.doneAt ?? Date.now() : null });
  } });
export const setsDelete = defineCommand({ name: 'sets.delete', kind: 'action', description: 'Delete a logged set by id.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('sets', id); return { ok: true }; } });

// ---------------- history & analysis ----------------
export const exerciseHistory = defineCommand({ name: 'exercises.history', kind: 'query',
  description: 'Every session an exercise was done in (optionally within dates): date, sets, and the best estimated 1RM per session (working sets; Wathen on reps-to-failure = reps + RIR, same as the set table; "reliable" false when >' + RELIABLE_MAX_RTF + ' reps to failure, "lowerBound" true when that set had no effort logged). Use for progress questions.',
  input: z.object({ exerciseId: zId, from: zDate.optional(), to: zDate.optional() }),
  run: async ({ exerciseId, from, to }) => {
    const sets = await db.sets.where('exerciseId').equals(exerciseId).filter((x) => alive(x) && !!x.doneAt).toArray();
    const bySession = new Map<string, SetLog[]>(); sets.forEach((s) => bySession.set(s.sessionId, [...(bySession.get(s.sessionId) ?? []), s]));
    const out = [];
    for (const [sid, list] of bySession) {
      const sess = await db.sessions.get(sid); if (!sess || !alive(sess)) continue;
      const date = dateKey(sess.startedAt); if ((from && date < from) || (to && date > to)) continue;
      let best: { kg: number; reliable: boolean; lowerBound: boolean } | null = null;
      for (const l of list) {
        if (l.kind !== 'working') continue;
        const est = setE1rm(l);
        if (est && (!best || est.kg > best.kg)) best = est;
      }
      out.push({ sessionId: sid, date, e1rmKg: best ? Math.round(best.kg * 10) / 10 : null, reliable: best?.reliable ?? null, lowerBound: best?.lowerBound ?? null,
        sets: list.sort(setOrder).map((l) => ({ kind: l.kind, setNo: l.setNo, side: l.side, loadKg: l.loadKg, totalKg: totalLoadKg(l.loadType, l.loadKg, l.bodyweightKg), reps: l.reps, rir: l.rir, rpe: l.rpe, e1rm: setE1rmView(l) })) });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  } });

// ---------------- workout summary & post-workout survey ----------------
const r1 = (v: number) => Math.round(v * 10) / 10;
const bestOut = (b: BestSet | null) => b && ({ loadKg: r1(b.loadKg), totalKg: r1(b.totalKg), reps: b.reps, rir: b.rir, e1rmKg: b.e1rmKg > 0 ? r1(b.e1rmKg) : null, e1rmReliable: b.reliable, e1rmLowerBound: b.lowerBound });

/** Weeks in a row (Monday weeks, local time) with at least one workout, counting back from the week of `ts`.
 *  `starts` = start times of the workouts that count. The week of `ts` itself must have one (the summary's own session). */
async function weekStreakAt(ts: number, starts: number[]) {
  const weeks = new Set(starts.filter((t) => t <= ts).map(weekStartMs));
  let n = 0;
  for (let w = weekStartMs(ts); weeks.has(w); w = weekStartMs(w - 3600000)) n++; // 1 h before Monday 00:00 = the week before (DST-safe)
  return n;
}

async function buildSummary(s: Session) {
  const endMs = s.endedAt ?? Date.now();
  const bw = await db.bodyweight.orderBy('at').filter(alive).toArray();
  // bodyweight fallback when a set has no snapshot: last weigh-in at/before the session, else the first one after
  const bwAt = (ts: number) => { let v: number | undefined; for (const b of bw) { if (b.at <= ts) v = b.kg; else return v ?? b.kg; } return v; };
  const doneSets = async (sessionId: string) => (await db.sets.where('sessionId').equals(sessionId).filter((x) => alive(x) && !!x.doneAt).toArray()).sort(setOrder);
  const statsOf = async (sess: Session) => (await doneSets(sess.id)).map((x) => toStatSet(x, bwAt(sess.startedAt)));

  const cur = await statsOf(s);
  const order = [...new Set([...s.items.map((i) => i.exerciseId), ...cur.map((x) => x.exerciseId)])].filter((e) => cur.some((x) => x.exerciseId === e));
  const exMap: Record<string, Exercise | undefined> = {};
  const ensureEx = async (ids: string[]) => { const miss = ids.filter((i) => !(i in exMap)); (await db.exercises.bulkGet(miss)).forEach((e, k) => { exMap[miss[k]] = e; }); };
  await ensureEx(order);

  // earlier = finished sessions that started before this one (never later ones, so a past summary stays as it was)
  const earlier = (await db.sessions.where('startedAt').below(s.startedAt).filter((x) => alive(x) && !!x.endedAt && x.id !== s.id).toArray())
    .sort((a, b) => b.startedAt - a.startedAt);
  const earlierById = new Map(earlier.map((x) => [x.id, x]));
  const priorRaw = order.length ? await db.sets.where('exerciseId').anyOf(order).filter((x) => alive(x) && !!x.doneAt && earlierById.has(x.sessionId)).toArray() : [];
  const prior = priorRaw.map((x) => ({ sid: x.sessionId, st: toStatSet(x, bwAt(earlierById.get(x.sessionId)!.startedAt)) }));

  const exercises = order.map((exId) => {
    const ex = exMap[exId];
    const mine = cur.filter((x) => x.exerciseId === exId);
    const loadType = ex?.loadType ?? mine[0].loadType;
    const past = prior.filter((p) => p.st.exerciseId === exId && p.st.kind !== 'warmup');
    const prevSess = earlier.find((e) => past.some((p) => p.sid === e.id));
    const prevSets = prevSess ? past.filter((p) => p.sid === prevSess.id).map((p) => p.st) : null;
    const cmp = compareToPrevious(mine, prevSets, loadType);
    const prs = personalRecords(mine, past.map((p) => p.st), loadType);
    return {
      exerciseId: exId, exercise: ex ? exerciseLabel(ex) : exId, loadType,
      sets: workingSetCount(mine), volumeKg: r1(volumeKg(mine)), bestSet: bestOut(bestSet(mine)),
      firstTime: !past.length,
      // any all-time PR also counts as progress (↑), so the screen never shows a PR next to "=" or "↓"
      trend: prs.e1rm || prs.weight || prs.reps ? 'up' as const : cmp.trend, beatLastTime: cmp.trend === 'up', beatByE1rm: cmp.beatByE1rm, beatByReps: cmp.beatByReps,
      e1rmDeltaKg: cmp.e1rmDeltaKg == null ? null : r1(cmp.e1rmDeltaKg),
      previous: prevSess && prevSets ? { sessionId: prevSess.id, date: dateKey(prevSess.startedAt), sets: workingSetCount(prevSets), volumeKg: r1(volumeKg(prevSets)), bestSet: bestOut(bestSet(prevSets)) } : null,
      prs: {
        e1rm: prs.e1rm && { kg: r1(prs.e1rm.kg), previousKg: r1(prs.e1rm.previousKg) },
        weight: prs.weight && { loadKg: r1(prs.weight.loadKg), totalKg: r1(prs.weight.totalKg), previousLoadKg: r1(prs.weight.previousLoadKg) },
        reps: prs.reps && { loadKg: r1(prs.reps.loadKg), totalKg: r1(prs.reps.totalKg), reps: prs.reps.reps, previousReps: prs.reps.previousReps },
      },
      bodyweight: loadType === 'weighted' ? null : mine.some((x) => x.bwMissing) ? 'missing' as const : mine.some((x) => x.bwEstimated) ? 'estimated' as const : 'logged' as const,
    };
  });

  type HighlightKind = 'e1rmPR' | 'weightPR' | 'repPR' | 'beatLastTime';
  const highlights = exercises.flatMap((e) => {
    const kinds: HighlightKind[] = [];
    if (e.prs.e1rm) kinds.push('e1rmPR');
    if (e.prs.weight) kinds.push('weightPR');
    if (e.prs.reps) kinds.push('repPR');
    if (!kinds.length && e.beatLastTime) kinds.push('beatLastTime');
    return kinds.map((kind) => ({ exerciseId: e.exerciseId, exercise: e.exercise, kind }));
  }).sort((a, b) => Number(a.kind === 'beatLastTime') - Number(b.kind === 'beatLastTime'));

  // this session's muscles + the week so far (Monday → this session, inclusive)
  const ws = weekStartMs(s.startedAt);
  const weekSessions = [s, ...earlier.filter((e) => e.startedAt >= ws)];
  const weekSets = (await Promise.all(weekSessions.map((w) => (w.id === s.id ? cur : statsOf(w))))).flat();
  await ensureEx([...new Set(weekSets.map((x) => x.exerciseId))]);
  const mThis = setsByMuscle(cur, exMap), mWeek = setsByMuscle(weekSets, exMap);
  const muscles = Object.entries(mThis).map(([muscle, m]) => ({ muscle, ...m, week: mWeek[muscle] }))
    .sort((a, b) => b.fractional - a.fractional || b.week.fractional - a.week.fractional);

  // per-set badges (same rules as the live screen): PR sets and sets that beat the same set last time
  const live = await liveProgress(s);
  const badges = (exId: string, b: SetBadge) => live.sets.filter((x) => x.exerciseId === exId && x.badge === b).length;
  const exercisesOut = exercises.map((e) => ({ ...e, prSets: badges(e.exerciseId, 'pr'), upSets: badges(e.exerciseId, 'up') }));
  const improvements = exercisesOut.reduce((a, e) => a + e.prSets + e.upSets, 0);
  const finishedBefore = earlier.length; // finished sessions that started before this one
  const workoutNumber = finishedBefore + 1;
  const weekStreak = await weekStreakAt(s.startedAt, [s.startedAt, ...earlier.map((e) => e.startedAt)]);

  const durationMin = r1((endMs - s.startedAt) / 60000);
  const totalVolume = volumeKg(cur), totalSets = workingSetCount(cur);
  const prevW = s.workoutId ? earlier.find((e) => e.workoutId === s.workoutId) : undefined;
  let vsLastWorkout = null;
  if (prevW) {
    const ps = await statsOf(prevW);
    const pv = volumeKg(ps), pd = ((prevW.endedAt ?? prevW.startedAt) - prevW.startedAt) / 60000;
    vsLastWorkout = { sessionId: prevW.id, date: dateKey(prevW.startedAt), durationMin: r1(pd), volumeKg: r1(pv), sets: workingSetCount(ps),
      volumeDeltaKg: r1(totalVolume - pv), volumeDeltaPct: pv > 0 ? r1(((totalVolume - pv) / pv) * 100) : null,
      durationDeltaMin: r1(durationMin - pd), setsDelta: totalSets - workingSetCount(ps) };
  }

  return {
    sessionId: s.id, name: s.name, date: dateKey(s.startedAt), live: !s.endedAt,
    startedAt: new Date(s.startedAt).toISOString(), endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    durationMin, totals: { workingSets: totalSets, volumeKg: r1(totalVolume), exercises: exercises.length },
    vsLastWorkout, highlights, exercises: exercisesOut, muscles, improvements, workoutNumber, weekStreak,
    week: { from: dateKey(ws), sessions: weekSessions.length },
    survey: { sessionRpe: s.sessionRpe ?? null, sleep: s.sleep ?? null, soreness: s.soreness ?? null, note: s.notes ?? null, ratedAt: s.ratedAt ? new Date(s.ratedAt).toISOString() : null },
    sessionLoadAU: s.sessionRpe != null ? Math.round(s.sessionRpe * durationMin) : null,
  };
}
export type WorkoutSummaryData = Awaited<ReturnType<typeof buildSummary>>;

export const sessionsSummary = defineCommand({ name: 'sessions.summary', kind: 'query',
  description: 'End-of-workout summary of one session (live or finished), computed from the logged sets. Returns: durationMin (end − start; live = so far); ' +
    'totals.workingSets (one per exercise slot + set number: a left+right pair is 1 set, drop steps fold into their set, warm-ups excluded); ' +
    'totals.volumeKg = Σ total load × reps over working sets AND drop steps (warm-ups excluded; both sides of one-side sets; dumbbell loads as logged, i.e. per dumbbell; ' +
    'bodyweight lifts use the bodyweight snapshot + added weight, assisted = bodyweight − assistance). ' +
    'exercises[]: sets, volumeKg, bestSet (highest e1RM — Wathen on reps + RIR — working sets only; e1rmLowerBound = no effort logged), previous (the last earlier session with that exercise), ' +
    'trend up|same|down|new vs previous (up = beat last time: higher e1RM, or more reps at ≥ last time\'s top weight; bodyweight/assisted e1RM needs a 1% change so bodyweight drift alone doesn\'t count), ' +
    'prs vs every earlier session (e1rm: reliable estimates ≤' + RELIABLE_MAX_RTF + ' reps to failure only; weight: heaviest logged load, i.e. added weight / least assistance for bodyweight lifts; reps: most reps ever at ≥ that load); firstTime = no earlier history (no PRs then); ' +
    'bodyweight logged|estimated|missing tells whether bodyweight lifts had a bodyweight snapshot. highlights[] lists PRs first, then beat-last-time. ' +
    'muscles[]: working sets per muscle this session: direct (primary muscles, 1 per set), indirect (secondary muscles), fractional = direct + 0.5 × indirect (0.5 is a convention), and week = the same counts for Monday → this session. ' +
    'vsLastWorkout compares with the previous session of the same plan workout (null if none). survey = post-workout answers; sessionLoadAU = session RPE × minutes (Foster et al. 2001). ' +
    'exercises[].prSets / upSets = how many of its working sets got a PR / beat-the-same-set-last-time badge (same per-set rules as sessions.liveProgress); improvements = the sum of both over all exercises. ' +
    'workoutNumber = 1 + finished workouts that started before this one ("Nth workout"); weekStreak = Monday-start weeks in a row with a workout, counting back from this session’s week (this week included). ' +
    'Only sessions that started before this one are used for comparisons, so a past summary is stable.',
  input: z.object({ id: zId }),
  run: async ({ id }) => buildSummary(await need(db.sessions.get(id), 'Session')) });

export const sessionsStreak = defineCommand({ name: 'sessions.streak', kind: 'query',
  description: 'Training streak: weeks in a row (Monday-start weeks, local time) with at least one finished workout, up to the week of `date` (default today). ' +
    'A week with no workout yet does not break the streak until it is over: if the week of `date` has none, counting starts from the week before. ' +
    'Returns weeks (the streak), thisWeek (finished workouts in the week of date) and total (finished workouts up to that date).',
  input: z.object({ date: zDate.optional() }),
  run: async ({ date }) => {
    const end = date ? keyToDate(date).getTime() + 86400000 - 1 : Date.now();
    const starts = (await db.sessions.where('startedAt').belowOrEqual(end).filter((x) => alive(x) && !!x.endedAt).toArray()).map((x) => x.startedAt);
    const ws = weekStartMs(end);
    const thisWeek = starts.filter((t) => t >= ws).length;
    const weeks = await weekStreakAt(thisWeek ? end : ws - 3600000, starts);
    return { weeks, thisWeek, total: starts.length };
  } });

export const sessionsRate = defineCommand({ name: 'sessions.rate', kind: 'action',
  description: 'Save the post-workout survey on a session (every field optional and skippable; only given fields change, null clears one). ' +
    'sessionRpe: how hard the whole session was on the CR-10 scale, 0 (rest) … 10 (maximal), Foster et al. 2001 session RPE, ideally ~30 min after; a different scale from per-set RPE. ' +
    'sleep: last night\'s sleep bad|ok|good. soreness: how the body felt going in, fresh|normal|beat (beat-up / sore). note: free text, stored as the session notes. ' +
    'Stamps ratedAt. Returns the saved answers.',
  input: z.object({ id: zId,
    sessionRpe: z.number().int().min(0).max(10).nullable().optional().describe('Session RPE, CR-10 0–10'),
    sleep: z.enum(['bad', 'ok', 'good']).nullable().optional(), soreness: z.enum(['fresh', 'normal', 'beat']).nullable().optional(),
    note: z.string().nullable().optional() }),
  // one-tap answers can fire back to back (tap, tap, blur): queue them so each read-modify-write sees the previous one
  run: (input) => { const p = rateQueue.catch(() => undefined).then(() => rateSession(input)); rateQueue = p; return p; },
});
let rateQueue: Promise<unknown> = Promise.resolve();
async function rateSession({ id, sessionRpe, sleep, soreness, note }: { id: string; sessionRpe?: number | null; sleep?: SurveySleep | null; soreness?: SurveyBody | null; note?: string | null }) {
  const s = await need(db.sessions.get(id), 'Session');
  const pick = <T,>(v: T | null | undefined, old: T | null | undefined) => (v === undefined ? old ?? null : v);
  const notes = note === undefined ? s.notes : note?.trim() ? note : undefined;
  const saved = await save('sessions', { ...s, sessionRpe: pick(sessionRpe, s.sessionRpe), sleep: pick(sleep, s.sleep), soreness: pick(soreness, s.soreness), notes, ratedAt: Date.now() } as Session);
  return { id, sessionRpe: saved.sessionRpe ?? null, sleep: saved.sleep ?? null, soreness: saved.soreness ?? null, note: saved.notes ?? null };
}

// ---------------- live workout: progression targets & live progress ----------------
/** Bodyweight fallback for sets without a snapshot (same rule as the summary): last weigh-in at/before ts, else the first after. */
async function bwFallback() {
  const bw = await db.bodyweight.orderBy('at').filter(alive).toArray();
  return (ts: number) => { let v: number | undefined; for (const b of bw) { if (b.at <= ts) v = b.kg; else return v ?? b.kg; } return v; };
}

/** The last finished session (started before `beforeSessionId`'s start, or before now) with done working sets of this exercise. */
async function previousWorking(exerciseId: string, beforeSessionId?: string) {
  const ref = beforeSessionId ? await db.sessions.get(beforeSessionId) : undefined;
  const before = ref?.startedAt ?? Date.now() + 1;
  const sets = await db.sets.where('exerciseId').equals(exerciseId)
    .filter((x) => alive(x) && !!x.doneAt && x.kind === 'working' && x.sessionId !== beforeSessionId).toArray();
  const sids = [...new Set(sets.map((x) => x.sessionId))];
  const sess = (await db.sessions.bulkGet(sids)).filter((x): x is Session => !!x && alive(x) && !!x.endedAt && x.startedAt < before)
    .sort((a, b) => b.startedAt - a.startedAt);
  const prev = sess[0];
  return prev ? { session: prev, sets: sets.filter((x) => x.sessionId === prev.id).sort(setOrder) } : null;
}

export async function nextTarget({ exerciseId, repsMin, repsMax, beforeSessionId }: { exerciseId: string; repsMin?: number | null; repsMax?: number | null; beforeSessionId?: string }) {
  const ex = await need(db.exercises.get(exerciseId), 'Exercise');
  const unit = (await getSettings()).unit;
  const stepKg = snappedStepKg(ex.stepKg ?? defaultStepKg(ex.equipment, unit), unit);
  const prev = await previousWorking(exerciseId, beforeSessionId);
  const last = (prev?.sets ?? []).filter((x) => x.reps != null && x.reps > 0)
    .map((x) => ({ setNo: x.setNo, side: x.side, loadKg: x.loadKg ?? 0, reps: x.reps!, rir: x.rir ?? null }));
  const t = progressionTarget(last, repsMin, repsMax, stepKg, ex.loadType);
  return {
    exerciseId, exercise: exerciseLabel(ex), loadType: ex.loadType, stepKg, targetRir: TARGET_RIR,
    basis: prev ? { sessionId: prev.session.id, date: dateKey(prev.session.startedAt) } : null,
    decision: t?.decision ?? null, loadDeltaKg: t?.loadDeltaKg ?? 0, repDelta: t?.repDelta ?? 0,
    reason: t?.reason ?? (prev ? 'No rep range on this exercise: repeat last time.' : 'No earlier session of this exercise.'),
    // with no rule (no rep range) the rows are last time's numbers, unchanged
    rows: t?.rows ?? last.map((r) => ({ ...r, lastLoadKg: r.loadKg, lastReps: r.reps })),
  };
}
export type NextTarget = Awaited<ReturnType<typeof nextTarget>>;

export const exercisesNextTarget = defineCommand({ name: 'exercises.nextTarget', kind: 'query',
  description: 'What to lift today for an exercise (progression target, "double progression": a coaching convention and rough guide, not a validated formula). ' +
    'Looks at the last finished session with this exercise (before beforeSessionId if given, e.g. the live session) and its done working sets, and the rep range repsMin–repsMax (from the session slot; only repsMin = fixed reps). ' +
    `Rule: every set at >= repsMax with RIR >= ${TARGET_RIR} (or no RIR logged) -> decision "increase": + one equipment weight step (stepKg; assisted = less assistance), reps = repsMin. ` +
    'More than half the sets below repsMin -> "reduce": one step lighter, reps = repsMin. Otherwise "reps": same weight, +1 rep per set up to repsMax (a set at RIR 0 repeats its reps), or "hold" if nothing would change. ' +
    'Bodyweight lifts with no added weight progress by +1 rep instead of weight. decision null = no rep range or no history (rows = last time unchanged). ' +
    'Returns decision, loadDeltaKg, reason (human-readable), rows[] per working set and side (loadKg = logged load: weight / added weight / assistance, reps, lastLoadKg, lastReps). Sets beyond last time\'s count: repeat the last row.',
  input: z.object({ exerciseId: zId, repsMin: z.number().int().min(1).nullable().optional(), repsMax: z.number().int().min(1).nullable().optional(),
    beforeSessionId: zId.optional().describe('Only compare with sessions that started before this one (pass the live session id)') }),
  run: nextTarget });

export type SetBadge = 'pr' | 'up' | null;
async function liveProgress(s: Session) {
  const bwAt = await bwFallback();
  const cur = (await db.sets.where('sessionId').equals(s.id).filter((x) => alive(x) && !!x.doneAt).toArray()).sort(setOrder);
  const curStat = cur.map((x) => ({ raw: x, st: toStatSet(x, bwAt(s.startedAt)) }));
  // every exercise in the session (not only the ones with ticked sets), so the set table can compare a set being filled in
  const exIds = [...new Set([...cur.map((x) => x.exerciseId), ...s.items.map((i) => i.exerciseId)])];
  // same "earlier" as the summary: finished sessions that started before this one
  const earlier = (await db.sessions.where('startedAt').below(s.startedAt).filter((x) => alive(x) && !!x.endedAt && x.id !== s.id).toArray())
    .sort((a, b) => b.startedAt - a.startedAt);
  const earlierById = new Map(earlier.map((x) => [x.id, x]));
  const priorRaw = exIds.length ? await db.sets.where('exerciseId').anyOf(exIds).filter((x) => alive(x) && !!x.doneAt && x.kind === 'working' && earlierById.has(x.sessionId)).toArray() : [];
  const prior = priorRaw.map((x) => ({ raw: x, st: toStatSet(x, bwAt(earlierById.get(x.sessionId)!.startedAt)) }));

  const sets = curStat.filter(({ raw }) => raw.kind === 'working' && (raw.reps ?? 0) > 0).map(({ raw, st }) => {
    const past = prior.filter((p) => p.raw.exerciseId === raw.exerciseId);
    let prs: ('e1rm' | 'weight' | 'reps')[] = [];
    let beatLastTime = false;
    if (past.length) { // never a PR on the first time an exercise is done
      // today's sets ticked before this one count as prior too, so only the set that raised the bar gets the badge
      const todayBefore = curStat.filter((c) => c.raw.exerciseId === raw.exerciseId && c.raw.kind === 'working' && c.raw.id !== raw.id && (c.raw.doneAt ?? 0) < (raw.doneAt ?? 0)).map((c) => c.st);
      const r = personalRecords([st], [...past.map((p) => p.st), ...todayBefore], st.loadType);
      prs = (['e1rm', 'weight', 'reps'] as const).filter((k) => r[k]);
      const prevSess = earlier.find((e) => past.some((p) => p.raw.sessionId === e.id));
      const same = past.filter((p) => p.raw.sessionId === prevSess?.id && p.raw.setNo === raw.setNo && p.raw.side === raw.side).map((p) => p.st);
      beatLastTime = same.length > 0 && compareToPrevious([st], same, st.loadType).trend === 'up';
    }
    const badge: SetBadge = prs.length ? 'pr' : beatLastTime ? 'up' : null;
    return { setId: raw.id, itemKey: raw.itemKey, exerciseId: raw.exerciseId, kind: raw.kind, setNo: raw.setNo, side: raw.side, badge, prs, beatLastTime };
  });
  // best reliable e1RM per exercise before this session (same rule as the e1RM PR, without today's sets) + the margin a
  // set must clear — the set table highlights a live score above it, so the highlight and the PR badge never disagree
  const priorBestE1rm: Record<string, { kg: number; marginKg: number } | null> = {};
  for (const id of exIds) {
    const est = prior.filter((p) => p.raw.exerciseId === id && p.st.reps > 0).map((p) => e1rm(p.st.totalKg, p.st.reps, p.st.rir)).filter((e) => e.reliable && e.kg > 0);
    const kg = est.length ? Math.max(...est.map((e) => e.kg)) : 0;
    const lt = prior.find((p) => p.raw.exerciseId === id)?.st.loadType ?? 'weighted';
    priorBestE1rm[id] = kg > 0 ? { kg: r1(kg), marginKg: r1(e1rmMargin(lt, kg)) } : null;
  }
  const replacedDone = s.items.filter((i) => i.replacedBy).reduce((a, i) => a + workingSetCount(cur.filter((x) => x.itemKey === i.key)), 0);
  return {
    sessionId: s.id,
    totals: {
      workingSetsDone: workingSetCount(cur),
      workingSetsPlanned: s.items.filter((i) => !i.replacedBy).reduce((a, i) => a + i.sets, 0) + replacedDone,
      volumeKg: r1(volumeKg(curStat.map((c) => c.st))),
    },
    sets,
    priorBestE1rm,
  };
}
export type LiveProgress = Awaited<ReturnType<typeof liveProgress>>;

export const sessionsLiveProgress = defineCommand({ name: 'sessions.liveProgress', kind: 'query',
  description: 'Live progress of a workout (meant for the one in progress, works on any): totals.workingSetsDone / workingSetsPlanned and totals.volumeKg (counted exactly like sessions.summary totals), ' +
    'and per done working set a badge: "pr" = an all-time record vs every earlier session (e1RM from <=' + RELIABLE_MAX_RTF + ' reps to failure, heaviest logged load, or most reps at >= that load; same rules as sessions.summary prs; ' +
    'today\'s sets ticked earlier count as prior, so only the set that raised the bar gets it; never on the first time an exercise is done), "up" = beat the same set (set number + side) of the previous session of that exercise ' +
    '(higher e1RM, or more reps at >= its weight; bodyweight lifts need a 1% e1RM change), null = neither. prs lists which records. priorBestE1rm[exerciseId] = best reliable e1RM (kg) of every earlier session and the marginKg a set must beat it by to count as a PR (null = none yet).',
  input: z.object({ id: zId }),
  run: async ({ id }) => liveProgress(await need(db.sessions.get(id), 'Session')) });
