// Turns a proposed action into readable rows for the request card, from the validated input, with ids resolved
// to names where it is cheap (food, exercise, supplement, workout, plan, session…). Read-only.
import { db } from '../../db/db';
import { getItem } from '../../db/food';
import { findCommand } from './tools';
import type { RequestAction } from './types';

export type Row = { label: string; value: string };
export type Described = { title: string; icon: string; rows: Row[] };

const TITLES: Record<string, string> = {
  'entries.log': 'Log food', 'entries.logMany': 'Log foods', 'entries.quickAdd': 'Quick add', 'entries.update': 'Edit food entry', 'entries.delete': 'Delete food entry',
  'entries.deleteMany': 'Delete food entries', 'entries.copy': 'Copy food entries', 'entries.move': 'Move food entries', 'foods.create': 'New food', 'foods.update': 'Edit food',
  'foods.delete': 'Delete food', 'recipes.save': 'Save recipe', 'goals.set': 'Set nutrition goals', 'days.setComplete': 'Mark day logged',
  'bodyweight.log': 'Log weight', 'bodyweight.update': 'Edit weigh-in', 'bodyweight.delete': 'Delete weigh-in',
  'supplements.save': 'Save supplement', 'supplements.log': 'Log supplement', 'supplements.unlog': 'Undo supplement log', 'supplements.changeDose': 'Change dose',
  'supplements.delete': 'Delete supplement', 'supplements.restock': 'Restock', 'stacks.save': 'Save stack', 'stacks.delete': 'Delete stack',
  'notes.add': 'Add note', 'notes.delete': 'Delete note', 'settings.update': 'Change settings',
  'plans.create': 'New plan', 'plans.rename': 'Rename plan', 'plans.update': 'Edit plan', 'plans.delete': 'Delete plan', 'plans.setActive': 'Set active plan',
  'workouts.create': 'New workout', 'workouts.rename': 'Rename workout', 'workouts.delete': 'Delete workout', 'items.add': 'Add exercise', 'items.update': 'Edit exercise',
  'items.remove': 'Remove exercise', 'items.replace': 'Replace exercise', 'sessions.start': 'Start workout', 'sessions.finish': 'Finish workout',
  'sets.log': 'Log set', 'sets.update': 'Edit set', 'sets.delete': 'Delete set', 'exercises.create': 'New exercise', 'maintenance.apply': 'Apply maintenance',
};
const ICONS: Record<string, string> = { entries: 'food', foods: 'food', recipes: 'food', goals: 'target', days: 'check', bodyweight: 'scale', supplements: 'pill', stacks: 'pill',
  notes: 'note', settings: 'settings', plans: 'dumbbell', workouts: 'dumbbell', items: 'dumbbell', sessions: 'dumbbell', sets: 'dumbbell', exercises: 'dumbbell', maintenance: 'fire' };

const LABELS: Record<string, string> = { p: 'Protein g', c: 'Carbs g', f: 'Fat g', kcal: 'kcal', kg: 'kg', loadKg: 'Load kg', foodKey: 'Food', foodId: 'Food', exerciseId: 'Exercise',
  supplementId: 'Supplement', supplementIds: 'Supplements', workoutId: 'Workout', planId: 'Plan', sessionId: 'Workout', activePlanId: 'Active plan', id: 'Item', ids: 'Items', rir: 'RIR', rpe: 'RPE' };
const humanize = (k: string) => LABELS[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (x) => x.toUpperCase());
const fallbackTitle = (name: string) => { const [a, v = ''] = name.split('.'); return `${humanize(v)} · ${a}`; };

const exName = async (id: string) => (await db.exercises.get(id))?.name;
const ID_RESOLVERS: Record<string, (id: string) => Promise<string | undefined>> = {
  foodKey: async (k) => (await getItem(k))?.name, foodId: async (k) => (await getItem(k))?.name,
  exerciseId: exName, supplementId: async (id) => (await db.supplements.get(id))?.name, workoutId: async (id) => (await db.workouts.get(id))?.name,
  planId: async (id) => (await db.plans.get(id))?.name, activePlanId: async (id) => (await db.plans.get(id))?.name, sessionId: async (id) => (await db.sessions.get(id))?.name,
};
/** `id` means a different table per command area. */
const BY_AREA: Record<string, (id: string) => Promise<string | undefined>> = {
  foods: async (id) => (await db.foods.get(id))?.name, recipes: async (id) => (await db.foods.get(id))?.name, exercises: exName,
  supplements: ID_RESOLVERS.supplementId, workouts: ID_RESOLVERS.workoutId, plans: ID_RESOLVERS.planId, sessions: ID_RESOLVERS.sessionId,
  entries: async (id) => { const e = await db.entries.get(id); return e && `${e.name} (${e.date})`; },
  bodyweight: async (id) => { const e = await db.bodyweight.get(id); return e && `${e.kg} kg · ${new Date(e.at).toLocaleDateString()}`; },
  stacks: async (id) => (await db.stacks.get(id))?.name, notes: async (id) => (await db.notes.get(id))?.text.slice(0, 40),
  sets: async (id) => { const s = await db.sets.get(id); return s && `${(await exName(s.exerciseId)) ?? 'Set'} · set ${s.setNo}`; },
};

async function fmt(key: string, v: unknown, area: string): Promise<string> {
  if (v === null) return 'none';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  if (typeof v === 'string') {
    const r = key === 'id' ? BY_AREA[area] : ID_RESOLVERS[key];
    const name = r ? await r(v).catch(() => undefined) : undefined;
    return name ?? (v.length > 80 ? v.slice(0, 79) + '…' : v);
  }
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string')) {
      const single = key.replace(/s$/, '');
      return (await Promise.all(v.map((x) => fmt(key === 'ids' ? 'id' : single, x, area)))).join(', ');
    }
    return `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  if (typeof v === 'object') {
    const parts = await Promise.all(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(async ([k, x]) => `${humanize(k)} ${await fmt(k, x, area)}`));
    return parts.join(' · ');
  }
  return String(v);
}

export async function describeAction(a: RequestAction): Promise<Described> {
  const c = findCommand(a.name);
  const parsed = c?.input.safeParse(a.input);
  const data = (parsed?.success ? parsed.data : a.input) as Record<string, unknown>;
  const area = a.name.split('.')[0];
  const rows: Row[] = [];
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined) continue;
    // lists of objects (entries.logMany items, recipe ingredients): one row each
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) {
      for (const [i, item] of v.entries()) {
        const o = item as Record<string, unknown>;
        const keyField = Object.keys(o).find((x) => ID_RESOLVERS[x]);
        const label = keyField ? await fmt(keyField, o[keyField], area) : `${humanize(k)} ${i + 1}`;
        const rest = Object.fromEntries(Object.entries(o).filter(([x, y]) => x !== keyField && y !== undefined));
        rows.push({ label, value: Object.keys(rest).length ? await fmt('', rest, area) : '' });
      }
      continue;
    }
    rows.push({ label: humanize(k), value: await fmt(k, v, area) });
  }
  return { title: TITLES[a.name] ?? fallbackTitle(a.name), icon: ICONS[area] ?? 'bolt', rows };
}
