// Turns a proposed action into a readable, complete description for the request card: a one-line summary plus a
// tree of every field that will be applied, ids resolved to names (food, exercise, supplement, workout, plan, exercise
// slot…). Common commands get hand-written renderers; everything else falls back to a full key/value tree of the
// validated input — nothing that will be applied is left out. Read-only.
import { db } from '../../db/db';
import { getItem } from '../../db/food';
import type { Schedule, WorkoutItem } from '../../db/types';
import { scheduleText } from '../../db/supps';
import { exerciseLabel } from '../equipment';
import { keyToDate } from '../nutrition';
import { mapRefs, parseRef } from './refs';
import { findCommand } from './tools';
import type { RequestAction } from './types';

export type Field = { label: string; value?: string; children?: Field[] };
export type Described = { title: string; icon: string; summary?: string; fields: Field[] };

const TITLES: Record<string, string> = {
  'entries.log': 'Log food', 'entries.logMany': 'Log foods', 'entries.quickAdd': 'Quick add', 'entries.update': 'Edit food entry', 'entries.delete': 'Delete food entry',
  'entries.deleteMany': 'Delete food entries', 'entries.copy': 'Copy food entries', 'entries.move': 'Move food entries', 'foods.create': 'New food', 'foods.update': 'Edit food',
  'foods.delete': 'Delete food', 'recipes.save': 'Save recipe', 'goals.set': 'Set nutrition goals', 'days.setComplete': 'Mark day logged',
  'bodyweight.log': 'Log weight', 'bodyweight.update': 'Edit weigh-in', 'bodyweight.delete': 'Delete weigh-in',
  'supplements.save': 'Save supplement', 'supplements.log': 'Log supplement', 'supplements.unlog': 'Undo supplement log', 'supplements.changeDose': 'Change dose',
  'supplements.delete': 'Delete supplement', 'supplements.restock': 'Restock', 'stacks.save': 'Save stack', 'stacks.delete': 'Delete stack',
  'notes.add': 'Add note', 'notes.delete': 'Delete note', 'settings.update': 'Change settings',
  'plans.create': 'New plan', 'plans.rename': 'Rename plan', 'plans.update': 'Edit plan', 'plans.delete': 'Delete plan', 'plans.setActive': 'Set active plan',
  'plans.reorderWorkouts': 'Reorder workouts', 'workouts.create': 'New workout', 'workouts.rename': 'Rename workout', 'workouts.delete': 'Delete workout',
  'items.add': 'Add exercises', 'items.update': 'Edit exercise', 'items.remove': 'Remove exercise', 'items.replace': 'Replace exercise', 'items.reorder': 'Reorder exercises',
  'items.move': 'Move exercise', 'items.toggleSupersetWithNext': 'Superset', 'sessions.start': 'Start workout', 'sessions.finish': 'Finish workout',
  'sets.log': 'Log set', 'sets.update': 'Edit set', 'sets.delete': 'Delete set', 'exercises.create': 'New exercise', 'exercises.variant': 'Exercise variant', 'maintenance.apply': 'Apply maintenance',
  'journal.add': 'Add to journal', 'journal.update': 'Edit journal entry', 'journal.end': 'End journal entry', 'journal.delete': 'Delete journal entry',
  'memory.save': 'Save memory', 'memory.delete': 'Delete memory', 'memory.pin': 'Pin memory',
};
const ICONS: Record<string, string> = { entries: 'food', foods: 'food', recipes: 'food', goals: 'target', days: 'check', bodyweight: 'scale', supplements: 'pill', stacks: 'pill',
  notes: 'note', settings: 'settings', plans: 'dumbbell', workouts: 'dumbbell', items: 'dumbbell', sessions: 'dumbbell', sets: 'dumbbell', exercises: 'dumbbell', maintenance: 'fire',
  journal: 'note', memory: 'note' };

const LABELS: Record<string, string> = { p: 'Protein g', c: 'Carbs g', f: 'Fat g', kcal: 'kcal', kg: 'kg', loadKg: 'Load kg', foodKey: 'Food', foodId: 'Food', exerciseId: 'Exercise',
  exerciseIds: 'Exercises', supplementId: 'Supplement', supplementIds: 'Supplements', workoutId: 'Workout', workoutIds: 'Workouts', planId: 'Plan', sessionId: 'Workout',
  activePlanId: 'Active plan', id: 'Item', ids: 'Items', rir: 'RIR', rpe: 'RPE', itemKey: 'Exercise', itemKeys: 'Exercises', proteinG: 'Protein', carbsG: 'Carbs', fatG: 'Fat',
  heightCm: 'Height', rateKgPerWeek: 'Rate', maintenanceKcal: 'Maintenance', restCompoundSec: 'Rest · compound', restIsolationSec: 'Rest · isolation',
  weighInEveryDays: 'Weigh-in every', effortMode: 'Effort', repsMin: 'Reps min', repsMax: 'Reps max', warmups: 'Warm-ups', drops: 'Drop sets' };
const humanize = (k: string) => LABELS[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (x) => x.toUpperCase());
const fallbackTitle = (name: string) => { const [a, v = ''] = name.split('.'); return `${humanize(v)} · ${a}`; };

// ---------------- refs to earlier actions of the same request ("$0.id") ----------------
// Before rendering, every ref in the input is replaced by REF_MARK + a readable label ("the new workout ‘Chesty’");
// the name lookups below return that label for a marked value, so every renderer shows it without knowing about refs.
const REF_MARK = '\u2063';
const isMarked = (v: unknown): v is string => typeof v === 'string' && v.startsWith(REF_MARK);
const marked = (fn: (id: string) => Promise<string | undefined>) => async (id: string) => (isMarked(id) ? id.slice(1) : fn(id));
const NEW_NOUN: Record<string, string> = { 'workouts.create': 'workout', 'workouts.createFromSession': 'workout', 'plans.create': 'plan', 'exercises.create': 'exercise',
  'exercises.duplicate': 'exercise', 'exercises.variant': 'exercise variant', 'foods.create': 'food', 'supplements.save': 'supplement', 'stacks.save': 'stack', 'journal.add': 'journal entry', 'sessions.start': 'workout session' };
async function refLabel(ref: string, all: RequestAction[], depth = 0): Promise<string> {
  const r = parseRef(ref)!;
  const src = all[r.index];
  const step = `step ${r.index + 1}`;
  if (!src || depth > 3) return `result of ${step}`;
  const nm = typeof src.input.name === 'string' ? src.input.name : undefined;
  const last = r.path[r.path.length - 1];
  if (src.name === 'items.add' && r.path.length === 3 && r.path[0] === 'items' && last === 'key') {
    // a slot that items.add creates: count from the end ("-1") or from the workout's current length
    const added = Array.isArray(src.input.items) ? (src.input.items as { exerciseId?: unknown }[]).map((x) => x.exerciseId) : (src.input.exerciseIds as unknown[] | undefined) ?? [];
    const existing = parseRef(src.input.workoutId) || parseRef(src.input.sessionId) ? 0 : (await slotsOf(src.input)).length;
    const n = Number(r.path[1]); const k = n < 0 ? added.length + n : n - existing;
    const id = added[k];
    if (typeof id === 'string') return `${parseRef(id) ? await refLabel(id, all, depth + 1) : (await exName(id)) ?? 'Exercise'} (added in ${step})`;
  }
  if (NEW_NOUN[src.name] && r.path.length === 1 && last === 'id') return `the new ${NEW_NOUN[src.name]}${nm ? ` ‘${nm}’` : typeof src.input.title === 'string' ? ` ‘${src.input.title}’` : ''}`;
  return `${humanize(last)} from ${step} (${TITLES[src.name] ?? src.name})`;
}

// ---------------- name lookups ----------------
const safe = async <T,>(p: Promise<T>) => { try { return await p; } catch { return undefined; } };
const exName = marked(async (id) => { const e = await safe(db.exercises.get(id)); return e ? exerciseLabel(e) : undefined; });
const planName = marked(async (id) => (await safe(db.plans.get(id)))?.name);
const workoutName = marked(async (id) => (await safe(db.workouts.get(id)))?.name);
const sessionName = marked(async (id) => { const s = await safe(db.sessions.get(id)); return s && `${s.name}${s.endedAt ? ` · ${new Date(s.startedAt).toLocaleDateString()}` : ' · live'}`; });
const suppName = marked(async (id) => (await safe(db.supplements.get(id)))?.name);
const foodName = marked(async (k) => (await safe(getItem(k)))?.name);
const ID_RESOLVERS: Record<string, (id: string) => Promise<string | undefined>> = {
  foodKey: foodName, foodId: foodName,
  exerciseId: exName, supplementId: suppName, workoutId: workoutName, planId: planName, activePlanId: planName, sessionId: sessionName,
};
/** `id` means a different table per command area. */
const BY_AREA: Record<string, (id: string) => Promise<string | undefined>> = {
  foods: async (id) => (await safe(db.foods.get(id)))?.name, recipes: async (id) => (await safe(db.foods.get(id)))?.name, exercises: exName,
  supplements: suppName, workouts: workoutName, plans: planName, sessions: sessionName,
  entries: async (id) => { const e = await safe(db.entries.get(id)); return e && `${e.name} (${e.date})`; },
  bodyweight: async (id) => { const e = await safe(db.bodyweight.get(id)); return e && `${e.kg} kg · ${new Date(e.at).toLocaleDateString()}`; },
  stacks: async (id) => (await safe(db.stacks.get(id)))?.name, notes: async (id) => (await safe(db.notes.get(id)))?.text,
  sets: async (id) => { const s = await safe(db.sets.get(id)); return s && `${(await exName(s.exerciseId)) ?? 'Set'} · set ${s.setNo}`; },
  journal: async (id) => (await safe(db.journal.get(id)))?.title, memory: async (id) => (await safe(db.memories.get(id)))?.name,
};
/** Exercise slots of the workout or session an items.* action targets (item keys → exercise names). */
async function slotsOf(input: Record<string, unknown>): Promise<WorkoutItem[]> {
  if (typeof input.workoutId === 'string') return (await safe(db.workouts.get(input.workoutId)))?.items ?? [];
  if (typeof input.sessionId === 'string') return (await safe(db.sessions.get(input.sessionId)))?.items ?? [];
  return [];
}
const slotName = async (items: WorkoutItem[], key: unknown) => {
  if (isMarked(key)) return key.slice(1);
  const it = items.find((i) => i.key === key);
  return it ? (await exName(it.exerciseId)) ?? 'Exercise' : `Exercise ${String(key).slice(0, 6)}`;
};

// ---------------- formatting ----------------
const num = (v: number) => String(Math.round(v * 100) / 100);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const day = (v: string) => keyToDate(v).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: v.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' });
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
function repsText(min?: number | null, max?: number | null) {
  if (min == null && max == null) return undefined;
  if (min != null && max != null) return min === max ? `${min} reps` : `${min}–${max} reps`;
  return min != null ? `${min}+ reps` : `up to ${max} reps`;
}
const restText = (r: { mode: string; sec?: number }) => (r.mode === 'countup' ? 'Count up' : r.sec ? `${mmss(r.sec)} timer` : 'Timer · default length');
const f = (label: string, value?: string, children?: Field[]): Field => ({ label, ...(value !== undefined ? { value } : {}), ...(children?.length ? { children } : {}) });
const cleared = 'Clear';

/** Generic value → field (recursive). Strings are never cut: the card shows everything that will be applied. */
async function toField(key: string, v: unknown, area: string, label = humanize(key)): Promise<Field> {
  if (v === null) return f(label, cleared);
  if (typeof v === 'boolean') return f(label, v ? 'Yes' : 'No');
  if (typeof v === 'number') return f(label, num(v));
  if (typeof v === 'string') {
    if (isMarked(v)) return f(label, v.slice(1));
    const r = key === 'id' ? BY_AREA[area] : ID_RESOLVERS[key];
    const name = r ? await r(v) : undefined;
    return f(label, name ?? (isDate(v) ? day(v) : v));
  }
  if (Array.isArray(v)) {
    if (!v.length) return f(label, 'None');
    if (v.every((x) => typeof x !== 'object' || x === null)) {
      const single = key === 'ids' ? 'id' : key.replace(/s$/, '');
      const parts = await Promise.all(v.map(async (x) => (await toField(single, x, area, '')).value ?? ''));
      const joined = parts.join(', ');
      return joined.length <= 60 ? f(label, joined) : f(label, plural(v.length, 'item'), parts.map((p, i) => f(`${i + 1}`, p)));
    }
    return f(label, plural(v.length, 'item'), await Promise.all(v.map((x, i) => objField(x, area, `${i + 1}`))));
  }
  if (typeof v === 'object') return objField(v, area, label);
  return f(label, String(v));
}
/** An object as a field: its name-ish key (food, exercise…) becomes the label when there is one. */
async function objField(o: unknown, area: string, fallback: string): Promise<Field> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return toField('', o, area, fallback);
  const entries = Object.entries(o as Record<string, unknown>).filter(([, x]) => x !== undefined);
  const keyField = entries.find(([k, x]) => ID_RESOLVERS[k] && typeof x === 'string');
  const label = keyField ? (await ID_RESOLVERS[keyField[0]](keyField[1] as string)) ?? `${fallback} · ${String(keyField[1])}` : fallback;
  const rest = entries.filter(([k]) => k !== keyField?.[0]);
  const children = await Promise.all(rest.map(([k, x]) => toField(k, x, area)));
  // one short child: fold it into the line ("Bench Press · 3 sets")
  if (children.length === 1 && !children[0].children) return f(label, `${children[0].label} ${children[0].value ?? ''}`.trim());
  return f(label, undefined, children);
}
async function genericFields(data: Record<string, unknown>, area: string) {
  const slots = 'itemKey' in data || 'itemKeys' in data ? await slotsOf(data) : [];
  return Promise.all(Object.entries(data).filter(([, v]) => v !== undefined).map(async ([k, v]) => {
    // exercise slot keys → exercise names (from the workout / session the action targets)
    if (k === 'itemKey') return f('Exercise', await slotName(slots, v));
    if (k === 'itemKeys' && Array.isArray(v)) return f('Exercises', undefined, await Promise.all(v.map(async (x, i) => f(`${i + 1}`, await slotName(slots, x)))));
    return toField(k, v, area);
  }));
}

// ---------------- hand-written renderers ----------------
/** ctx: every action of the request and this one's index (so a renderer can see what later actions do with it). */
type Ctx = { all: RequestAction[]; index: number };
type R = (i: Record<string, unknown>, area: string, ctx: Ctx) => Promise<{ title?: string; summary?: string; fields: Field[] }>;
const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
const n = (v: unknown) => (typeof v === 'number' ? v : undefined);

async function target(i: Record<string, unknown>) {
  if (s(i.workoutId)) return f('Workout', (await workoutName(s(i.workoutId)!)) ?? 'Workout');
  return f('Workout', (await sessionName(s(i.sessionId) ?? '')) ?? 'This workout');
}
function patchFields(p: Record<string, unknown>): Field[] {
  const out: Field[] = [];
  if (p.sets !== undefined) out.push(f('Sets', String(p.sets)));
  if (p.repsMin !== undefined || p.repsMax !== undefined) {
    out.push(f('Reps', p.repsMin === null && p.repsMax === null ? cleared : repsText(n(p.repsMin), n(p.repsMax)) ?? cleared));
    if (p.repsMin === null && p.repsMax !== null) out.push(f('Reps min', cleared));
    if (p.repsMax === null && p.repsMin !== null) out.push(f('Reps max', cleared));
  }
  if (p.warmups !== undefined) out.push(f('Warm-ups', String(p.warmups)));
  if (p.drops !== undefined) out.push(f('Drop sets', String(p.drops)));
  if (p.rest && typeof p.rest === 'object') out.push(f('Rest', restText(p.rest as { mode: string; sec?: number })));
  if (p.notes !== undefined) out.push(f('Note', p.notes === null || p.notes === '' ? cleared : String(p.notes)));
  return out;
}
function patchSummary(p: Record<string, unknown>) {
  const bits: string[] = [];
  const reps = repsText(n(p.repsMin), n(p.repsMax));
  if (p.sets !== undefined && reps) bits.push(`${p.sets} × ${reps.replace(' reps', '')}`); else { if (p.sets !== undefined) bits.push(plural(Number(p.sets), 'set')); if (reps) bits.push(reps); }
  if (p.rest && typeof p.rest === 'object') { const r = p.rest as { mode: string; sec?: number }; bits.push(r.mode === 'countup' ? 'count-up rest' : r.sec ? `rest ${mmss(r.sec)}` : 'default rest'); }
  if (p.warmups) bits.push(plural(Number(p.warmups), 'warm-up'));
  if (p.drops) bits.push(plural(Number(p.drops), 'drop'));
  if (p.notes !== undefined) bits.push(p.notes ? 'note' : 'clear note');
  return bits.join(' · ');
}
/** A new exercise slot in one line: sets × reps, rest (default timer when not given), warm-ups, drop sets. */
function newItemSummary(p: Record<string, unknown>) {
  const sets = n(p.sets) ?? 3;
  const reps = repsText(n(p.repsMin), n(p.repsMax));
  const bits = [reps ? `${sets} × ${reps}` : plural(sets, 'set')];
  const r = p.rest as { mode: string; sec?: number } | undefined;
  bits.push(!r ? 'default rest' : r.mode === 'countup' ? 'count-up rest' : r.sec ? `rest ${mmss(r.sec)}` : 'default rest');
  if (n(p.warmups)) bits.push(plural(n(p.warmups)!, 'warm-up'));
  if (n(p.drops)) bits.push(plural(n(p.drops)!, 'drop set'));
  return bits.join(' · ');
}
const SCHED_KIND: Record<string, string> = { daily: 'Every day', weekdays: 'On weekdays', interval: 'Every N days', weekly: 'Weekly', asNeeded: 'As needed' };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function scheduleFields(sc: Record<string, unknown>): Field[] {
  const out: Field[] = [];
  if (sc.kind) out.push(f('Repeats', SCHED_KIND[String(sc.kind)] ?? String(sc.kind)));
  if (Array.isArray(sc.days)) out.push(f('Days', (sc.days as number[]).map((d) => WD[d]).join(' ')));
  if (sc.every !== undefined) out.push(f('Every', plural(Number(sc.every), 'day')));
  if (Array.isArray(sc.times)) out.push(f('Times', (sc.times as string[]).join(', ') || 'None'));
  if (isDate(sc.startDate)) out.push(f('Starts', day(sc.startDate)));
  if (sc.cycle === null) out.push(f('Cycle', cleared));
  else if (sc.cycle && typeof sc.cycle === 'object') { const c = sc.cycle as { onDays: number; offDays: number }; out.push(f('Cycle', `${c.onDays} on / ${c.offDays} off`)); }
  return out;
}
const lowStockText = (v: unknown) => (v === null ? 'Off' : v && typeof v === 'object' ? ((v as { kind: string; value: number }).kind === 'days' ? `${(v as { value: number }).value} days left` : `${(v as { value: number }).value} left`) : undefined);

const RENDER: Record<string, R> = {
  'plans.create': async (i) => ({ summary: s(i.name), fields: [f('Name', s(i.name))] }),
  'plans.rename': async (i) => ({ summary: `${(await planName(s(i.id)!)) ?? 'Plan'} → ${s(i.name)}`, fields: [f('Plan', await planName(s(i.id)!)), f('New name', s(i.name))] }),
  'plans.update': async (i) => {
    const fields = [f('Plan', (await planName(s(i.id)!)) ?? 'Plan')];
    if (i.name !== undefined) fields.push(f('New name', s(i.name)));
    if (i.startDate !== undefined) fields.push(f('Week 1 starts', i.startDate === null ? 'When the plan was created' : day(String(i.startDate))));
    return { fields };
  },
  'workouts.create': async (i, _a, { all, index }) => {
    const plan = (await planName(s(i.planId)!)) ?? 'Plan';
    const filled = all.some((x, k) => k > index && x.name === 'items.add' && parseRef(x.input.workoutId)?.index === index);
    return { summary: `${s(i.name)} · in ${plan}`, fields: [f('Name', s(i.name)), f('Plan', plan), f('Exercises', filled ? 'Added below' : 'None yet')] };
  },
  'workouts.rename': async (i) => ({ summary: `${(await workoutName(s(i.id)!)) ?? 'Workout'} → ${s(i.name)}`, fields: [f('Workout', await workoutName(s(i.id)!)), f('New name', s(i.name))] }),
  'items.add': async (i) => {
    // short form (exerciseIds + sets) or full (items with per-exercise targets): one line each, "4 × 6–8 reps · rest 3:00 · 2 warm-ups", note below
    const specs = Array.isArray(i.items) ? (i.items as Record<string, unknown>[]) : ((i.exerciseIds as string[]) ?? []).map((exerciseId): Record<string, unknown> => ({ exerciseId, sets: i.sets }));
    const t = await target(i);
    const rows = await Promise.all(specs.map(async (sp, k) => {
      const nm = (await exName(String(sp.exerciseId))) ?? 'Unknown exercise';
      const note = s(sp.notes)?.trim();
      return f(`${k + 1}. ${nm}`, newItemSummary(sp), note ? [f('Note', note)] : undefined);
    }));
    const fields = [t, f('Exercises', plural(specs.length, 'exercise'), rows)];
    if (i.makeCurrent) fields.push(f('Switch to it now', 'Yes'));
    return { summary: `${plural(specs.length, 'exercise')} → ${t.value}`, fields };
  },
  'items.update': async (i) => {
    const slots = await slotsOf(i);
    const name = await slotName(slots, i.itemKey);
    const p = (i.patch ?? {}) as Record<string, unknown>;
    return { title: name, summary: patchSummary(p) || 'Edit exercise', fields: [await target(i), f('Exercise', name), ...patchFields(p)] };
  },
  'items.remove': async (i) => { const name = await slotName(await slotsOf(i), i.itemKey); return { summary: name, fields: [await target(i), f('Exercise', name)] }; },
  'items.replace': async (i) => {
    const from = await slotName(await slotsOf(i), i.itemKey); const to = (await exName(s(i.exerciseId)!)) ?? 'Unknown exercise';
    return { summary: `${from} → ${to}`, fields: [await target(i), f('Replace', from), f('With', to)] };
  },
  'items.reorder': async (i) => {
    const slots = await slotsOf(i);
    const names = await Promise.all(((i.itemKeys as string[]) ?? []).map((k) => slotName(slots, k)));
    return { fields: [await target(i), f('New order', undefined, names.map((nm, k) => f(`${k + 1}`, nm)))] };
  },
  'items.move': async (i) => { const name = await slotName(await slotsOf(i), i.itemKey); return { summary: `${name} → position ${Number(i.toIndex) + 1}`, fields: [await target(i), f('Exercise', name), f('To position', String(Number(i.toIndex) + 1))] }; },
  'items.toggleSupersetWithNext': async (i) => {
    const slots = await slotsOf(i); const k = slots.findIndex((x) => x.key === i.itemKey);
    const a = await slotName(slots, i.itemKey); const b = k >= 0 && slots[k + 1] ? await slotName(slots, slots[k + 1].key) : 'the next exercise';
    const joined = k >= 0 && !!slots[k].supersetId && slots[k].supersetId === slots[k + 1]?.supersetId;
    return { summary: `${joined ? 'Split' : 'Join'} ${a} + ${b}`, fields: [await target(i), f(joined ? 'Split superset' : 'Join as superset', `${a} + ${b}`)] };
  },
  'supplements.save': async (i) => {
    const existing = s(i.id) ? await safe(db.supplements.get(s(i.id)!)) : undefined;
    const unit = s(i.unit) ?? existing?.unit ?? 'mg';
    const fields: Field[] = [];
    if (existing) fields.push(f('Supplement', existing.name));
    if (i.name !== undefined) fields.push(f(existing ? 'New name' : 'Name', s(i.name)));
    if (i.form !== undefined) fields.push(f('Form', humanize(String(i.form))));
    if (i.route !== undefined) fields.push(f('Route', String(i.route)));
    if (i.unit !== undefined) fields.push(f('Unit', unit));
    if (i.dose !== undefined) fields.push(f('Dose', `${num(Number(i.dose))} ${unit}`));
    if (Array.isArray(i.doses)) fields.push(f('Dose steps', 'Replaces the dose history', (i.doses as { from: string; amount: number }[]).map((d) => f(`From ${day(d.from)}`, `${num(d.amount)} ${unit}`))));
    if (i.schedule && typeof i.schedule === 'object') {
      const sc = i.schedule as Record<string, unknown>;
      const full = existing ? { ...existing.schedule, ...sc } : { kind: 'daily', times: ['08:00'], startDate: undefined, ...sc };
      const text = full.startDate || full.kind !== 'weekly' ? safeSched(full as Schedule) : undefined;
      fields.push(f('Schedule', text, scheduleFields(existing ? sc : full)));
    } else if (!existing) fields.push(f('Schedule', 'Daily · 08:00 (default)'));
    if (i.stock !== undefined) fields.push(f('Stock', i.stock === null ? cleared : `${num(Number(i.stock))} ${unit}`));
    if (i.lowStock !== undefined) fields.push(f('Low-stock alert', lowStockText(i.lowStock)));
    if (i.notes !== undefined) fields.push(f('Notes', s(i.notes) || cleared));
    if (i.archived !== undefined) fields.push(f('Status', i.archived ? 'Stop taking' : 'Taking again'));
    const name = s(i.name) ?? existing?.name ?? 'Supplement';
    return { summary: `${name}${i.dose !== undefined ? ` · ${num(Number(i.dose))} ${unit}` : ''}`, fields };
  },
  'supplements.changeDose': async (i) => {
    const sp = await safe(db.supplements.get(s(i.id)!)); const unit = sp?.unit ?? '';
    return { summary: `${sp?.name ?? 'Supplement'} → ${num(Number(i.amount))} ${unit}`, fields: [f('Supplement', sp?.name), f('New dose', `${num(Number(i.amount))} ${unit}`.trim()), f('From', isDate(i.from) ? day(i.from) : 'Today')] };
  },
  'supplements.restock': async (i) => { const sp = await safe(db.supplements.get(s(i.id)!)); return { summary: `${sp?.name ?? 'Supplement'} +${num(Number(i.amount))} ${sp?.unit ?? ''}`, fields: [f('Supplement', sp?.name), f('Add', `${num(Number(i.amount))} ${sp?.unit ?? ''}`.trim())] }; },
  'goals.set': async (i) => {
    const t = (v: unknown, unit: string) => (v === null ? 'Off' : `${num(Number(v))} ${unit}`);
    const fields: Field[] = [];
    if (i.kcal !== undefined) fields.push(f('Calories', t(i.kcal, 'kcal')));
    if (i.proteinG !== undefined) fields.push(f('Protein', t(i.proteinG, 'g')));
    if (i.carbsG !== undefined) fields.push(f('Carbs', t(i.carbsG, 'g')));
    if (i.fatG !== undefined) fields.push(f('Fat', t(i.fatG, 'g')));
    if (i.maintenanceKcal !== undefined) fields.push(f('Maintenance', i.maintenanceKcal === null ? 'Estimate from formula' : `${num(Number(i.maintenanceKcal))} kcal`));
    if (i.rateKgPerWeek !== undefined) fields.push(f('Rate', `${Number(i.rateKgPerWeek) > 0 ? '+' : ''}${num(Number(i.rateKgPerWeek))} kg / week`));
    if (i.activity !== undefined) fields.push(f('Activity', humanize(String(i.activity))));
    if (i.sex !== undefined) fields.push(f('Sex', humanize(String(i.sex))));
    if (i.birthYear !== undefined) fields.push(f('Born', String(i.birthYear)));
    if (i.heightCm !== undefined) fields.push(f('Height', `${num(Number(i.heightCm))} cm`));
    fields.push(f('From', 'Today on'));
    return { summary: fields.slice(0, 2).map((x) => `${x.label} ${x.value}`).join(' · '), fields };
  },
  'journal.add': async (i) => {
    const d = isDate(i.date) ? day(i.date) : 'Today';
    const when = isDate(i.endDate) ? `${d} → ${day(i.endDate)}` : i.ongoing ? `${d} → ongoing` : d;
    const fields = [f('Title', s(i.title)), f('When', when)];
    if (i.tag) fields.push(f('Tag', humanize(String(i.tag))));
    if (i.note) fields.push(f('Note', s(i.note)));
    return { summary: `${s(i.title)} · ${when}`, fields };
  },
  'memory.save': async (i) => {
    const old = s(i.id) ? (await safe(db.memories.get(s(i.id)!)))?.name : undefined;
    const fields = [...(old ? [f('Replaces', old)] : []), f('Name', s(i.name)), ...(s(i.description) ? [f('When useful', s(i.description))] : []), f('Content', s(i.content))];
    if (i.pinned !== undefined) fields.push(f('Pinned', i.pinned ? 'Yes' : 'No'));
    return { summary: s(i.name), fields };
  },
  'notes.add': async (i) => {
    const tags = await Promise.all(((i.tags as string[]) ?? []).map(async (t) => (await suppName(t)) ?? t));
    return { fields: [f('Text', s(i.text)), ...(tags.length ? [f('Tags', tags.join(', '))] : []), ...(s(i.at) ? [f('At', new Date(s(i.at)!).toLocaleString())] : [])] };
  },
  'settings.update': async (i) => {
    const fields: Field[] = [];
    for (const [k, v] of Object.entries(i)) {
      if (v === undefined) continue;
      if (k === 'features' && v && typeof v === 'object') {
        fields.push(f('Sections', undefined, Object.entries(v as Record<string, boolean>).filter(([, x]) => x !== undefined).map(([fk, x]) => f(humanize(fk), x ? 'On' : 'Off'))));
      } else if (k === 'restCompoundSec' || k === 'restIsolationSec') fields.push(f(humanize(k), mmss(Number(v))));
      else if (k === 'weighInEveryDays') fields.push(f('Weigh-in every', plural(Number(v), 'day')));
      else if (k === 'activePlanId') fields.push(f('Active plan', v === null ? 'None' : (await planName(String(v))) ?? String(v)));
      else fields.push(await toField(k, v, 'settings'));
    }
    return { fields };
  },
};
function safeSched(sc: Schedule) { try { return scheduleText({ ...sc, times: sc.times ?? [] }); } catch { return undefined; } }

/** all = every action of the request (for refs like "$0.id" to earlier ones); defaults to just this one. */
export async function describeAction(a: RequestAction, all: RequestAction[] = [a]): Promise<Described> {
  const c = findCommand(a.name);
  const index = Math.max(0, all.indexOf(a));
  const input = (await mapRefs(a.input, async (r) => REF_MARK + await refLabel(r, all))) as Record<string, unknown>;
  const parsed = c?.input.safeParse(input);
  const data = ((parsed?.success ? parsed.data : input) ?? {}) as Record<string, unknown>;
  const area = a.name.split('.')[0];
  const base = { title: TITLES[a.name] ?? fallbackTitle(a.name), icon: ICONS[area] ?? 'bolt' };
  const r = RENDER[a.name];
  if (r) { try { return { ...base, ...(await r(data, area, { all, index })) }; } catch { /* fall through to the generic tree */ } }
  const fields = await genericFields(data, area);
  // short flat actions ("Delete weigh-in · 81 kg") read best as one line
  const flat = fields.length <= 2 && fields.every((x) => !x.children);
  return { ...base, summary: flat ? fields.map((x) => x.value ?? x.label).join(' · ') : undefined, fields };
}

/** How many lines the full field tree takes (decides whether the card shows it at once or behind Details). */
export const fieldLines = (fields: Field[]): number => fields.reduce((t, x) => t + 1 + (x.children ? fieldLines(x.children) : 0), 0);
