import { z } from 'zod';
import { defineCommand, zDate, zId } from './registry';
import { alive, db, newRecord, remove, save, uuid } from '../db/db';
import { createPlan, createWorkout, finishSession, latestBodyweightKg, newItem, setOrder, startSession } from '../db/gym';
import { getSettings, updateSettings } from '../db/settings';
import type { Exercise, Session, SetLog, SurveyBody, SurveySleep, Workout, WorkoutItem } from '../db/types';
import { normalizeSupersets, toggleSupersetWithNext } from '../components/ItemSettings';
import { e1rm, rirToRpe, rpeToRir, totalLoadKg } from '../lib/science';
import { exerciseUsage, searchExercises } from '../db/exerciseSearch';
import { dateKey, keyToDate } from '../lib/nutrition';
import { exerciseLabel } from '../lib/equipment';
import { bestSet, compareToPrevious, personalRecords, setsByMuscle, toStatSet, volumeKg, weekStartMs, workingSetCount, type BestSet } from '../lib/workoutStats';

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
  description: 'All workout plans with their workouts (in rotation order), each workout\'s exercises, and which plan is active.',
  input: z.object({}),
  run: async () => {
    const s = await getSettings();
    const plans = await db.plans.filter(alive).toArray();
    return Promise.all(plans.map(async (p) => ({
      id: p.id, name: p.name, active: s.activePlanId === p.id,
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
export const plansDelete = defineCommand({ name: 'plans.delete', kind: 'action', description: 'Delete a plan and its workouts (past workout sessions stay in history). If it was the active plan, no plan is active afterwards.',
  input: z.object({ id: zId }), run: async ({ id }) => {
    const plan = await need(db.plans.get(id), 'Plan');
    for (const w of await db.workouts.bulkGet(plan.workoutIds)) if (w && !w.deletedAt) await remove('workouts', w.id);
    await remove('plans', id); const s = await getSettings(); if (s.activePlanId === id) await updateSettings({ activePlanId: undefined }); return { ok: true }; } });
export const plansSetActive = defineCommand({ name: 'plans.setActive', kind: 'action', description: 'Make a plan the active one (Home suggests its next workout).',
  input: z.object({ id: zId }), run: async ({ id }) => { await need(db.plans.get(id), 'Plan'); await updateSettings({ activePlanId: id }); return { ok: true }; } });
export const plansReorder = defineCommand({ name: 'plans.reorderWorkouts', kind: 'action', description: 'Set the rotation order of a plan\'s workouts: pass the full list of workout ids in the new order. Returns the plan record.',
  input: z.object({ id: zId, workoutIds: z.array(zId) }), run: async ({ id, workoutIds }) => save('plans', { ...(await need(db.plans.get(id), 'Plan')), workoutIds }) });

export const workoutsCreate = defineCommand({ name: 'workouts.create', kind: 'action', description: 'Add an empty workout (e.g. "Push A") to the end of a plan\'s rotation. Returns the workout record (use its id with items.add).',
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

export const itemsAdd = defineCommand({ name: 'items.add', kind: 'action',
  description: 'Add exercises to the end of a plan workout or a workout session (mid-workout too). Default 3 sets each. In a session, makeCurrent=true also switches the current exercise to the first one added. Returns the updated workout/session record (new slots are at the end of items).',
  input: zTargetRefine(z.object({ ...zTarget, exerciseIds: z.array(zId).min(1), sets: z.number().int().min(1).max(20).optional(),
    makeCurrent: z.boolean().optional().describe('Session only: make the first added exercise the current one') })),
  run: async ({ exerciseIds, sets, makeCurrent, ...t }) => editItems(t, async (items) => {
    const found = await db.exercises.bulkGet(exerciseIds);
    const missing = exerciseIds.filter((_, i) => !found[i] || found[i]!.deletedAt);
    if (missing.length) throw new Error(`Exercise not found: ${missing.join(', ')} (use exercises.search to get ids)`);
    const exs = found as Exercise[];
    return [...items, ...exs.map((e) => ({ ...newItem(e), sets: sets ?? 3 }))];
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
  description: 'Remove an exercise slot. In a session this also deletes all of that slot\'s sets (done or not) in the session. Returns the updated workout/session record.',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string() })),
  run: async ({ itemKey, ...t }) => {
    if (t.sessionId) for (const s of await db.sets.where('sessionId').equals(t.sessionId).filter((x) => x.itemKey === itemKey).toArray()) await remove('sets', s.id);
    return editItems(t, (items) => mustHave(items, itemKey).filter((i) => i.key !== itemKey));
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
  const setOut = (x: SetLog) => ({ id: x.id, kind: x.kind, setNo: x.setNo, dropNo: x.dropNo, side: x.side, loadKg: x.loadKg, loadType: x.loadType, bodyweightKg: x.bodyweightKg, reps: x.reps, rir: x.rir, rpe: x.rpe, done: !!x.doneAt });
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
export const sessionsGet = defineCommand({ name: 'sessions.get', kind: 'query', description: 'One workout session with every exercise and set.',
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
export const sessionsDelete = defineCommand({ name: 'sessions.delete', kind: 'action', description: 'Discard a live workout or delete a finished one, with all its sets.',
  input: z.object({ id: zId }), run: async ({ id }) => {
    for (const s of await db.sets.where('sessionId').equals(id).toArray()) await remove('sets', s.id);
    await remove('sessions', id); return { ok: true };
  } });

// ---------------- sets ----------------
/** Effort fields from rir/rpe input: one given -> both derived; null -> both cleared; undefined -> unchanged. */
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
  description: 'Record or correct a set in a session (creates it or updates the matching one). itemKey is the exercise slot key from sessions.active / sessions.get (items[].key). setNo is 1-based within its kind; drop steps use kind "drop" with dropNo; one-side exercises use side left/right. loadKg means: the weight (weighted), added weight (bodyweight) or assistance (assisted). Give rir or rpe (RPE = 10 − RIR); null clears effort. Omitted fields keep their value. done: true checks it off, false unchecks; omitted keeps an existing set\'s state and marks a new set done. When the set is created it snapshots the exercise load type and (for bodyweight/assisted) the latest bodyweight so e1RM stays right (if no bodyweight was stored, it is filled when the set is checked off); later corrections, un-ticking and re-ticking keep that snapshot unless bodyweightKg is given. Returns the set record.',
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
  description: 'Every session an exercise was done in (optionally within dates): date, sets, and the best estimated 1RM per session (Epley with reps+RIR; "reliable" false when >10 reps to failure). Use for progress questions.',
  input: z.object({ exerciseId: zId, from: zDate.optional(), to: zDate.optional() }),
  run: async ({ exerciseId, from, to }) => {
    const sets = await db.sets.where('exerciseId').equals(exerciseId).filter((x) => alive(x) && !!x.doneAt).toArray();
    const bySession = new Map<string, SetLog[]>(); sets.forEach((s) => bySession.set(s.sessionId, [...(bySession.get(s.sessionId) ?? []), s]));
    const out = [];
    for (const [sid, list] of bySession) {
      const sess = await db.sessions.get(sid); if (!sess || !alive(sess)) continue;
      const date = dateKey(sess.startedAt); if ((from && date < from) || (to && date > to)) continue;
      let best: { kg: number; reliable: boolean } | null = null;
      for (const l of list) {
        if (l.kind === 'warmup' || !l.reps) continue;
        const est = e1rm(totalLoadKg(l.loadType, l.loadKg, l.bodyweightKg), l.reps, l.rir ?? 0);
        if (!best || est.kg > best.kg) best = est;
      }
      out.push({ sessionId: sid, date, e1rmKg: best ? Math.round(best.kg * 10) / 10 : null, reliable: best?.reliable ?? null,
        sets: list.sort(setOrder).map((l) => ({ kind: l.kind, setNo: l.setNo, side: l.side, loadKg: l.loadKg, totalKg: totalLoadKg(l.loadType, l.loadKg, l.bodyweightKg), reps: l.reps, rir: l.rir })) });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  } });

// ---------------- workout summary & post-workout survey ----------------
const r1 = (v: number) => Math.round(v * 10) / 10;
const bestOut = (b: BestSet | null) => b && ({ loadKg: r1(b.loadKg), totalKg: r1(b.totalKg), reps: b.reps, rir: b.rir, e1rmKg: b.e1rmKg > 0 ? r1(b.e1rmKg) : null, e1rmReliable: b.reliable });

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
    vsLastWorkout, highlights, exercises, muscles,
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
    'exercises[]: sets, volumeKg, bestSet (highest Epley e1RM on reps + RIR, working sets only), previous (the last earlier session with that exercise), ' +
    'trend up|same|down|new vs previous (up = beat last time: higher e1RM, or more reps at ≥ last time\'s top weight; bodyweight/assisted e1RM needs a 1% change so bodyweight drift alone doesn\'t count), ' +
    'prs vs every earlier session (e1rm: reliable estimates ≤10 reps to failure only; weight: heaviest logged load, i.e. added weight / least assistance for bodyweight lifts; reps: most reps ever at ≥ that load); firstTime = no earlier history (no PRs then); ' +
    'bodyweight logged|estimated|missing tells whether bodyweight lifts had a bodyweight snapshot. highlights[] lists PRs first, then beat-last-time. ' +
    'muscles[]: working sets per muscle this session: direct (primary muscles, 1 per set), indirect (secondary muscles), fractional = direct + 0.5 × indirect (0.5 is a convention), and week = the same counts for Monday → this session. ' +
    'vsLastWorkout compares with the previous session of the same plan workout (null if none). survey = post-workout answers; sessionLoadAU = session RPE × minutes (Foster et al. 2001). ' +
    'Only sessions that started before this one are used for comparisons, so a past summary is stable.',
  input: z.object({ id: zId }),
  run: async ({ id }) => buildSummary(await need(db.sessions.get(id), 'Session')) });

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
