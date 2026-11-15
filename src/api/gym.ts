import { z } from 'zod';
import { defineCommand, zDate, zId } from './registry';
import { alive, db, newRecord, remove, save } from '../db/db';
import { createPlan, createWorkout, finishSession, latestBodyweightKg, newItem, setOrder, startSession } from '../db/gym';
import { getSettings, updateSettings } from '../db/settings';
import type { Exercise, Session, SetLog, Workout, WorkoutItem } from '../db/types';
import { normalizeSupersets, toggleSupersetWithNext } from '../components/ItemSettings';
import { e1rm, rirToRpe, rpeToRir, totalLoadKg } from '../lib/science';
import { exerciseUsage, searchExercises } from '../db/exerciseSearch';
import { dateKey, keyToDate } from '../lib/nutrition';

const zLoadType = z.enum(['weighted', 'bodyweight', 'assisted']);
const zItemPatch = z.object({
  sets: z.number().int().min(1).max(20).optional(),
  repsMin: z.number().int().min(0).nullable().optional(), repsMax: z.number().int().min(0).nullable().optional(),
  warmups: z.number().int().min(0).max(6).optional(), drops: z.number().int().min(0).max(4).optional(),
  rest: z.object({ mode: z.enum(['timer', 'countup']), sec: z.number().int().min(15).max(600).optional() }).optional(),
  notes: z.string().nullable().optional(),
}).describe('Fields of an exercise slot to change');

const need = async <T>(p: Promise<T | undefined>, what: string) => { const v = await p; if (!v || (v as { deletedAt?: number | null }).deletedAt) throw new Error(`${what} not found`); return v; };
const exName = async (id: string) => (await db.exercises.get(id))?.name ?? id;
const applyPatch = (it: WorkoutItem, p: z.infer<typeof zItemPatch>): WorkoutItem => ({
  ...it, ...p, repsMin: p.repsMin === null ? undefined : p.repsMin ?? it.repsMin, repsMax: p.repsMax === null ? undefined : p.repsMax ?? it.repsMax,
  notes: p.notes === null ? undefined : p.notes ?? it.notes, rest: p.rest ?? it.rest,
});

// ---------------- exercises ----------------
export const exercisesSearch = defineCommand({
  name: 'exercises.search', kind: 'query',
  description: 'Find exercises by name (typo-tolerant, any word order, gym shorthand like "db", "rdl", "ohp"). Returns id, name, muscles, equipment, loadType, unilateral.',
  input: z.object({ query: z.string(), muscle: z.string().optional(), limit: z.number().int().max(100).default(20) }),
  run: async ({ query, muscle, limit }) => {
    const all = (await db.exercises.toArray()).filter((e) => alive(e) && (!muscle || e.muscles.includes(muscle)));
    return searchExercises(all, query, await exerciseUsage(), limit)
      .map((e) => ({ id: e.id, name: e.name, muscles: e.muscles, equipment: e.equipment, loadType: e.loadType, unilateral: e.unilateral, mechanic: e.mechanic, custom: !!e.custom }));
  },
});

export const exercisesCreate = defineCommand({
  name: 'exercises.create', kind: 'action',
  description: 'Create a custom exercise. loadType: weighted (log the weight), bodyweight (log added weight), assisted (log assistance). unilateral = log left/right separately.',
  input: z.object({ name: z.string().min(1), mechanic: z.enum(['compound', 'isolation']).default('compound'), equipment: z.string().default('other'),
    loadType: zLoadType.default('weighted'), unilateral: z.boolean().default(false), muscles: z.array(z.string()).default([]) }),
  run: async (i) => save('exercises', newRecord({ ...i, secondary: [], images: [], custom: true })),
});

export const exercisesUpdate = defineCommand({
  name: 'exercises.update', kind: 'action',
  description: 'Change an exercise (name, type, equipment, load type, one-side flag, main muscles).',
  input: z.object({ id: zId, name: z.string().optional(), mechanic: z.enum(['compound', 'isolation']).optional(), equipment: z.string().optional(),
    loadType: zLoadType.optional(), unilateral: z.boolean().optional(), muscles: z.array(z.string()).optional() }),
  run: async ({ id, ...p }) => { const e = await need(db.exercises.get(id), 'Exercise'); return save('exercises', { ...e, ...p } as Exercise); },
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

export const plansCreate = defineCommand({ name: 'plans.create', kind: 'action', description: 'Create a workout plan (becomes active if none is).',
  input: z.object({ name: z.string().min(1) }), run: async ({ name }) => createPlan(name) });
export const plansRename = defineCommand({ name: 'plans.rename', kind: 'action', description: 'Rename a plan.',
  input: z.object({ id: zId, name: z.string().min(1) }), run: async ({ id, name }) => save('plans', { ...(await need(db.plans.get(id), 'Plan')), name }) });
export const plansDelete = defineCommand({ name: 'plans.delete', kind: 'action', description: 'Delete a plan (past workouts stay in history).',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('plans', id); const s = await getSettings(); if (s.activePlanId === id) await updateSettings({ activePlanId: undefined }); return { ok: true }; } });
export const plansSetActive = defineCommand({ name: 'plans.setActive', kind: 'action', description: 'Make a plan the active one (Home suggests its next workout).',
  input: z.object({ id: zId }), run: async ({ id }) => { await need(db.plans.get(id), 'Plan'); await updateSettings({ activePlanId: id }); return { ok: true }; } });
export const plansReorder = defineCommand({ name: 'plans.reorderWorkouts', kind: 'action', description: 'Set the rotation order of a plan\'s workouts.',
  input: z.object({ id: zId, workoutIds: z.array(zId) }), run: async ({ id, workoutIds }) => save('plans', { ...(await need(db.plans.get(id), 'Plan')), workoutIds }) });

export const workoutsCreate = defineCommand({ name: 'workouts.create', kind: 'action', description: 'Add a workout (e.g. "Push A") to a plan.',
  input: z.object({ planId: zId, name: z.string().min(1) }), run: async ({ planId, name }) => createWorkout(await need(db.plans.get(planId), 'Plan'), name) });
export const workoutsRename = defineCommand({ name: 'workouts.rename', kind: 'action', description: 'Rename a workout.',
  input: z.object({ id: zId, name: z.string().min(1) }), run: async ({ id, name }) => save('workouts', { ...(await need(db.workouts.get(id), 'Workout')), name }) });
export const workoutsDelete = defineCommand({ name: 'workouts.delete', kind: 'action', description: 'Delete a workout from its plan.',
  input: z.object({ id: zId }), run: async ({ id }) => {
    const w = await need(db.workouts.get(id), 'Workout'); const p = await db.plans.get(w.planId);
    if (p) await save('plans', { ...p, workoutIds: p.workoutIds.filter((x) => x !== id) });
    await remove('workouts', id); return { ok: true };
  } });

/** Structure edits shared by plan workouts and live/finished sessions (same rules everywhere). */
async function editItems(target: { workoutId?: string; sessionId?: string }, fn: (items: WorkoutItem[]) => WorkoutItem[] | Promise<WorkoutItem[]>) {
  if (target.sessionId) {
    const s = await need(db.sessions.get(target.sessionId), 'Session');
    const items = normalizeSupersets(await fn(s.items));
    return save('sessions', { ...s, items, currentKey: items.some((i) => i.key === s.currentKey) ? s.currentKey : items[0]?.key } as Session);
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
  description: 'Add exercises to a plan workout or to a workout session (mid-workout too). Default 3 sets.',
  input: zTargetRefine(z.object({ ...zTarget, exerciseIds: z.array(zId).min(1), sets: z.number().int().min(1).max(20).optional() })),
  run: async ({ exerciseIds, sets, ...t }) => editItems(t, async (items) => {
    const found = await db.exercises.bulkGet(exerciseIds);
    const missing = exerciseIds.filter((_, i) => !found[i] || found[i]!.deletedAt);
    if (missing.length) throw new Error(`Exercise not found: ${missing.join(', ')} (use exercises.search to get ids)`);
    const exs = found as Exercise[];
    return [...items, ...exs.map((e) => ({ ...newItem(e), sets: sets ?? 3 }))];
  }) });
export const itemsUpdate = defineCommand({ name: 'items.update', kind: 'action',
  description: 'Change an exercise slot: sets, target reps, warm-ups, drop sets, rest, notes. Works on plan workouts and sessions.',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string(), patch: zItemPatch })),
  run: async ({ itemKey, patch, ...t }) => editItems(t, (items) => mustHave(items, itemKey).map((i) => (i.key === itemKey ? applyPatch(i, patch) : i))) });
export const itemsRemove = defineCommand({ name: 'items.remove', kind: 'action',
  description: 'Remove an exercise slot. In a session this also deletes that exercise\'s logged sets in the session.',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string() })),
  run: async ({ itemKey, ...t }) => {
    if (t.sessionId) for (const s of await db.sets.where('sessionId').equals(t.sessionId).filter((x) => x.itemKey === itemKey).toArray()) await remove('sets', s.id);
    return editItems(t, (items) => mustHave(items, itemKey).filter((i) => i.key !== itemKey));
  } });
export const itemsReplace = defineCommand({ name: 'items.replace', kind: 'action',
  description: 'Swap the exercise in a slot for another (keeps sets/reps; unfinished session sets are cleared).',
  input: zTargetRefine(z.object({ ...zTarget, itemKey: z.string(), exerciseId: zId })),
  run: async ({ itemKey, exerciseId, ...t }) => {
    if (t.sessionId) for (const s of await db.sets.where('sessionId').equals(t.sessionId).filter((x) => x.itemKey === itemKey && !x.doneAt).toArray()) await remove('sets', s.id);
    await need(db.exercises.get(exerciseId), 'Exercise');
    return editItems(t, (items) => mustHave(items, itemKey).map((i) => (i.key === itemKey ? { ...i, exerciseId, rest: { mode: i.rest.mode } } : i)));
  } });
export const itemsMove = defineCommand({ name: 'items.move', kind: 'action', description: 'Move an exercise slot to a new position (0-based).',
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
  return {
    id: s.id, name: s.name, startedAt: new Date(s.startedAt).toISOString(), endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    live: !s.endedAt, currentItemKey: s.currentKey, notes: s.notes, workoutId: s.workoutId,
    items: await Promise.all(s.items.map(async (i) => ({
      key: i.key, exerciseId: i.exerciseId, exercise: await exName(i.exerciseId), plannedSets: i.sets, repsMin: i.repsMin, repsMax: i.repsMax,
      warmups: i.warmups, drops: i.drops, supersetId: i.supersetId, notes: i.notes,
      sets: sets.filter((x) => x.itemKey === i.key).map((x) => ({ id: x.id, kind: x.kind, setNo: x.setNo, dropNo: x.dropNo, side: x.side, loadKg: x.loadKg, loadType: x.loadType, bodyweightKg: x.bodyweightKg, reps: x.reps, rir: x.rir, rpe: x.rpe, done: !!x.doneAt })),
    }))),
  };
}

export const sessionsActive = defineCommand({ name: 'sessions.active', kind: 'query', description: 'The workout in progress (with exercises and logged sets), or null.',
  input: z.object({}), run: async () => { const s = await db.sessions.filter((x) => alive(x) && !x.endedAt).first(); return s ? sessionView(s) : null; } });
export const sessionsGet = defineCommand({ name: 'sessions.get', kind: 'query', description: 'One workout session with every exercise and set.',
  input: z.object({ id: zId }), run: async ({ id }) => sessionView(await need(db.sessions.get(id), 'Session')) });
export const sessionsList = defineCommand({ name: 'sessions.list', kind: 'query',
  description: 'Finished workout sessions between two dates (inclusive), newest first: id, name, date, duration, sets done.',
  input: z.object({ from: zDate.optional(), to: zDate.optional(), limit: z.number().int().max(500).default(50) }),
  run: async ({ from, to, limit }) => {
    const lo = from ? keyToDate(from).getTime() : 0; const hi = to ? keyToDate(to).getTime() + 86400000 : Date.now() + 86400000;
    const list = await db.sessions.where('startedAt').between(lo, hi).filter((s) => alive(s) && !!s.endedAt).reverse().limit(limit).toArray();
    return Promise.all(list.map(async (s) => ({ id: s.id, name: s.name, date: dateKey(s.startedAt), minutes: Math.round(((s.endedAt ?? s.startedAt) - s.startedAt) / 60000),
      setsDone: await db.sets.where('sessionId').equals(s.id).filter((x) => alive(x) && !!x.doneAt && x.kind !== 'warmup').count() })));
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
  description: 'Finish a workout. Unchecked sets are dropped. updatePlan=true writes structural changes (exercises, order, sets, rest) back to the plan workout.',
  input: z.object({ id: zId, updatePlan: z.boolean().default(false) }),
  run: async ({ id, updatePlan }) => { await finishSession(await need(db.sessions.get(id), 'Session'), updatePlan); return { ok: true }; } });
export const sessionsUpdate = defineCommand({ name: 'sessions.update', kind: 'action',
  description: 'Edit a session\'s name, notes, start time, duration (finished only), current exercise, or resume a finished one.',
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
export const setsLog = defineCommand({ name: 'sets.log', kind: 'action',
  description: 'Record or correct a set in a session (creates it or updates the matching one). itemKey is the exercise slot key from sessions.active / sessions.get (items[].key). setNo is 1-based within its kind; drop steps use kind "drop" with dropNo; one-side exercises use side left/right. loadKg means: the weight (weighted), added weight (bodyweight) or assistance (assisted). Give rir or rpe (RPE = 10 − RIR). done=false leaves it unchecked.',
  input: z.object({ sessionId: zId, itemKey: z.string(), setNo: z.number().int().min(1), kind: z.enum(['warmup', 'working', 'drop']).default('working'),
    dropNo: z.number().int().min(1).optional(), side: z.enum(['both', 'left', 'right']).default('both'),
    loadKg: z.number().min(0).nullable().optional(), reps: z.number().int().min(0).nullable().optional(),
    rir: z.number().min(0).max(10).nullable().optional(), rpe: z.number().min(1).max(10).nullable().optional(), done: z.boolean().default(true) }),
  run: async (i) => {
    const sess = await need(db.sessions.get(i.sessionId), 'Session');
    const item = sess.items.find((x) => x.key === i.itemKey); if (!item) throw new Error('Exercise slot not found in session');
    const ex = await need(db.exercises.get(item.exerciseId), 'Exercise');
    const existing = await db.sets.where('sessionId').equals(i.sessionId)
      .filter((x) => alive(x) && x.itemKey === i.itemKey && x.kind === i.kind && x.setNo === i.setNo && (x.dropNo ?? 0) === (i.dropNo ?? 0) && x.side === i.side).first();
    const s = await getSettings();
    const bw = ex.loadType === 'weighted' ? null : (await latestBodyweightKg()) ?? null;
    const effort = i.rir != null ? { rir: i.rir, rpe: rirToRpe(i.rir), effortInput: 'rir' as const } : i.rpe != null ? { rpe: i.rpe, rir: rpeToRir(i.rpe), effortInput: 'rpe' as const } : {};
    const base = existing ?? newRecord({ sessionId: i.sessionId, itemKey: i.itemKey, exerciseId: ex.id, setNo: i.setNo, kind: i.kind, dropNo: i.dropNo, side: i.side,
      loadType: ex.loadType, inputUnit: s.unit, loadKg: null, reps: null, doneAt: null } as Omit<SetLog, 'id' | 'createdAt' | 'updatedAt'>);
    return save('sets', { ...base, loadKg: i.loadKg !== undefined ? i.loadKg : base.loadKg, reps: i.reps !== undefined ? i.reps : base.reps, ...effort,
      bodyweightKg: bw ?? base.bodyweightKg ?? null, doneAt: i.done ? base.doneAt ?? Date.now() : null } as SetLog);
  } });
export const setsUpdate = defineCommand({ name: 'sets.update', kind: 'action', description: 'Correct a logged set by id (weight, reps, effort, done).',
  input: z.object({ id: zId, loadKg: z.number().min(0).nullable().optional(), reps: z.number().int().min(0).nullable().optional(),
    rir: z.number().min(0).max(10).nullable().optional(), rpe: z.number().min(1).max(10).nullable().optional(), done: z.boolean().optional() }),
  run: async ({ id, rir, rpe, done, ...p }) => {
    const x = await need(db.sets.get(id), 'Set');
    const effort = rir != null ? { rir, rpe: rirToRpe(rir) } : rpe != null ? { rpe, rir: rpeToRir(rpe) } : rir === null || rpe === null ? { rir: null, rpe: null } : {};
    return save('sets', { ...x, ...p, ...effort, doneAt: done === undefined ? x.doneAt : done ? x.doneAt ?? Date.now() : null });
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
