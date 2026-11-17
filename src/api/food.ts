import { z } from 'zod';
import { defineCommand, zDate, zId, zMeal } from './registry';
import { alive, db, newRecord, remove, save } from '../db/db';
import { foodToItem, getItem, goalFor, logEntry, lookupBarcode, quickAdd, recipeNutrition, searchFoods, type FoodItem } from '../db/food';
import type { DayStatus, Food, FoodEntry, Ingredient, Macros, NutritionGoal } from '../db/types';
import { dateKey, estimateMaintenance, scale, sum, targetKcal } from '../lib/nutrition';

const zMacros = z.object({ kcal: z.number().min(0), p: z.number().min(0), c: z.number().min(0), f: z.number().min(0), fiber: z.number().min(0).optional() });
const zPortion = z.object({ label: z.string().describe('e.g. "1 bar", "1 scoop"'), g: z.number().positive().describe('grams (or ml) per unit') });
const r1 = (v: number) => Math.round(v * 10) / 10;
const round100 = (m: z.output<typeof zMacros>, fiber = 0): Macros => ({ kcal: r1(m.kcal), p: r1(m.p), c: r1(m.c), f: r1(m.f), fiber: r1(m.fiber ?? fiber) });
const item = (it: Awaited<ReturnType<typeof getItem>>) => it && ({ key: it.key, source: it.source, name: it.name, alt: it.alt, brand: it.brand, per100: it.per100, unitBase: it.unitBase ?? 'g', portions: it.portions });

export const foodsSearch = defineCommand({ name: 'foods.search', kind: 'query',
  description: 'Search foods (Hebrew or English, typo-tolerant): your own foods and recipes, Israeli MoH and Israeli products, then USDA. Ranked by match then by how often you log it. Nutrition is per 100 g (or 100 ml). key is what you pass to entries.log / recipes.',
  input: z.object({ query: z.string(), limit: z.number().int().min(1).max(60).default(15) }),
  run: async ({ query, limit }) => (await searchFoods(query, limit)).map(item) });
export const foodsGet = defineCommand({ name: 'foods.get', kind: 'query', description: 'One food by key (with portions/units and per-100 g nutrition).',
  input: z.object({ key: z.string() }), run: async ({ key }) => item(await getItem(key)) ?? null });
export const foodsBarcode = defineCommand({ name: 'foods.lookupBarcode', kind: 'action',
  description: 'Look up a product barcode: saved foods, bundled Israeli products, then Open Food Facts (only the barcode is sent). A found product is saved to your foods.',
  input: z.object({ barcode: z.string().regex(/^\d{8,14}$/) }), run: async ({ barcode }) => { const r = await lookupBarcode(barcode); return { status: r.status, food: r.food ? item(foodToItem(r.food)) : null, draft: r.draft ?? null }; } });

export const foodsCreate = defineCommand({ name: 'foods.create', kind: 'action',
  description: 'Create your own food. per100 is nutrition per 100 g (or per 100 ml when unitBase is "ml"); values are rounded to 0.1. Add units/servings as portions like {label:"1 bar", g:45} (g = grams or ml per unit). barcode links it to a scanned product so the next scan finds it. Convert label values per serving to per 100 first. Returns the saved food record (its id is the food key).',
  input: z.object({ name: z.string().trim().min(1), brand: z.string().optional(), barcode: z.string().optional(), unitBase: z.enum(['g', 'ml']).default('g'), per100: zMacros, portions: z.array(zPortion).default([]) }),
  run: async (i) => save('foods', newRecord({ source: 'custom' as const, ...i, per100: round100(i.per100) }) as Food) });
export const foodsUpdate = defineCommand({ name: 'foods.update', kind: 'action',
  description: 'Edit one of your foods or scanned products (not bundled database foods; recipes use recipes.save). Only the fields you pass change; pass null for brand or barcode to remove it. portions replaces the whole unit list. per100 is rounded to 0.1 and keeps the stored fiber if you omit fiber. Past log entries keep their numbers. Returns the saved food record.',
  input: z.object({ id: zId, name: z.string().trim().min(1).optional(), brand: z.string().nullable().optional(), barcode: z.string().nullable().optional(), unitBase: z.enum(['g', 'ml']).optional(),
    per100: zMacros.optional(), portions: z.array(zPortion).optional() }),
  run: async ({ id, name, brand, barcode, unitBase, per100, portions }) => {
    const f = await db.foods.get(id); if (!f || !alive(f)) throw new Error('Food not found (only your own foods can be edited)');
    const next: Food = { ...f };
    if (name !== undefined) next.name = name;
    if (brand !== undefined) next.brand = brand || undefined;
    if (barcode !== undefined) next.barcode = barcode || undefined;
    if (unitBase !== undefined) next.unitBase = unitBase;
    if (per100 !== undefined) next.per100 = round100(per100, f.per100.fiber ?? 0);
    if (portions !== undefined) next.portions = portions;
    return save('foods', next);
  } });
export const foodsDelete = defineCommand({ name: 'foods.delete', kind: 'action', description: 'Delete one of your foods or recipes (soft delete, syncs). Past log entries keep their numbers.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('foods', id); return { ok: true }; } });

export const recipesSave = defineCommand({ name: 'recipes.save', kind: 'action',
  description: 'Create (no id) or update (id) a recipe from foods (ingredient keys from foods.search) with grams each. servings = how many portions the batch makes; cookedG = weight after cooking if known (water loss/gain), null/omitted = raw total. Per-100 g nutrition is computed from the ingredients and rounded to 0.1; the recipe becomes a loggable food with a "1 serving" unit. When updating, ingredients already in the recipe keep their stored nutrition snapshot (even if that food was since deleted); new ones are looked up. Returns { recipe (food view, key = id), food (the saved record), perServing, servingG }.',
  input: z.object({ id: zId.optional(), name: z.string().trim().min(1), servings: z.number().int().min(1).default(1), cookedG: z.number().positive().nullable().optional(),
    ingredients: z.array(z.object({ foodKey: z.string(), grams: z.number().min(0), name: z.string().optional().describe('display name to store (default: the food name)') })).min(1) }),
  run: async ({ id, name, servings, cookedG, ingredients }) => {
    const existing = id ? await db.foods.get(id) : undefined;
    if (id && (!existing || !alive(existing) || existing.source !== 'recipe')) throw new Error('Recipe not found');
    const known = new Map((existing?.ingredients ?? []).map((x) => [x.foodKey, x]));
    const ings: Ingredient[] = [];
    for (const i of ingredients) {
      const snap = known.get(i.foodKey);
      if (snap) { ings.push({ ...snap, name: i.name ?? snap.name, grams: i.grams }); continue; }
      const it = await getItem(i.foodKey); if (!it) throw new Error(`Unknown food ${i.foodKey}`);
      ings.push({ foodKey: it.key, name: i.name ?? it.name, grams: i.grams, per100: it.per100 });
    }
    const r = recipeNutrition(ings, servings, cookedG);
    const fields = { source: 'recipe' as const, name, unitBase: 'g' as const, ingredients: ings, servings, cookedG: cookedG ?? null,
      per100: round100(r.per100), portions: [{ label: '1 serving', g: r1(r.servingG) }] };
    const saved = await save('foods', existing ? { ...existing, ...fields } as Food : newRecord(fields) as Food);
    const ps = scale(saved.per100, r.servingG); // from the stored (rounded) per-100 g values, so it matches what logging gives
    return { recipe: item(foodToItem(saved)), food: saved, perServing: { kcal: Math.round(ps.kcal), p: r1(ps.p), c: r1(ps.c), f: r1(ps.f) }, servingG: r1(r.servingG) };
  } });

// ---------------- log ----------------
const entryView = (e: FoodEntry) => ({ id: e.id, date: e.date, meal: e.meal, name: e.name, brand: e.brand, source: e.source, foodKey: e.foodId, grams: e.grams, qty: e.qty, unit: e.unit,
  kcal: Math.round(e.n.kcal), p: r1(e.n.p), c: r1(e.n.c), f: r1(e.n.f) });

export const entriesList = defineCommand({ name: 'entries.list', kind: 'query', description: 'Food log entries for a date or date range, with per-entry and per-day totals.',
  input: z.object({ from: zDate, to: zDate.optional() }),
  run: async ({ from, to }) => {
    const list = await db.entries.where('date').between(from, to ?? from, true, true).filter(alive).sortBy('at');
    const days = new Map<string, FoodEntry[]>(); list.forEach((e) => days.set(e.date, [...(days.get(e.date) ?? []), e]));
    return [...days].map(([date, es]) => { const t = sum(es.map((e) => e.n)); return { date, totals: { kcal: Math.round(t.kcal), p: r1(t.p), c: r1(t.c), f: r1(t.f) }, entries: es.map(entryView) }; });
  } });
export const isBaseUnit = (u: string | undefined, base: string) => u === base || u === 'g' || u === 'ml';
export const findPortion = (it: FoodItem, label: string) => it.portions.find((x) => x.label === label || x.label === `1 ${label}`);
/** Amount -> grams for nutrition + the qty/unit label stored on the entry. grams (if given) always drives nutrition. */
export function resolveAmount(it: FoodItem, a: { grams?: number; qty?: number; unit?: string }) {
  const base = it.unitBase ?? 'g';
  if (a.qty != null && a.unit) {
    if (isBaseUnit(a.unit, base)) return { g: a.grams ?? a.qty, q: a.qty, u: base };
    const p = findPortion(it, a.unit);
    if (p) return { g: a.grams ?? p.g * a.qty, q: a.qty, u: p.label };
    if (a.grams != null) return { g: a.grams, q: a.qty, u: a.unit }; // unit no longer on the food: keep the label, grams decide
    throw new Error(`Unit "${a.unit}" not found. Available: ${it.portions.map((x) => x.label).join(', ') || 'grams only'}`);
  }
  if (a.grams == null) throw new Error('Give grams, or qty with unit');
  return { g: a.grams, q: a.grams, u: base };
}

export const entriesLog = defineCommand({ name: 'entries.log', kind: 'action',
  description: 'Log a food. Give grams, or qty + unit where unit is "g"/"ml" or one of the food\'s portion labels exactly as listed in foods.search / foods.get portions[].label (e.g. qty 2, unit "1 slice"; labels may be Hebrew). If you give grams and qty + unit, grams drive the nutrition and qty + unit are kept as the portion label shown in the log. name overrides the stored entry name (e.g. the English name of a Hebrew food). date defaults to today, meal to the time of day. Stores a nutrition snapshot; returns the entry.',
  input: z.object({ foodKey: z.string(), date: zDate.optional(), meal: zMeal.optional(), grams: z.number().positive().optional(), qty: z.number().positive().optional(), unit: z.string().optional(),
    name: z.string().trim().min(1).optional() })
    .refine((v) => v.grams != null || (v.qty != null && !!v.unit), 'Give grams, or qty with unit'),
  run: async ({ foodKey, date, meal, grams, qty, unit, name }) => {
    const it = await getItem(foodKey); if (!it) throw new Error(`Unknown food ${foodKey}`);
    const { g, q, u } = resolveAmount(it, { grams, qty, unit });
    const { mealNow } = await import('../lib/meals');
    return entryView(await logEntry(name ? { ...it, name } : it, g, q, u, meal ?? mealNow(), date ?? dateKey()));
  } });
export const entriesQuick = defineCommand({ name: 'entries.quickAdd', kind: 'action',
  description: 'Log an estimate by macros only (restaurant meal, guess). kcal defaults to 4·protein + 4·carbs + 9·fat. An empty name becomes "Quick add". date defaults to today, meal to the time of day. Returns the entry.',
  input: z.object({ name: z.string().default('Quick add'), date: zDate.optional(), meal: zMeal.optional(), kcal: z.number().min(0).optional(), p: z.number().min(0).default(0), c: z.number().min(0).default(0), f: z.number().min(0).default(0) }),
  run: async ({ name, date, meal, kcal, p, c, f }) => {
    const { mealNow } = await import('../lib/meals');
    return entryView(await quickAdd({ kcal: kcal ?? Math.round(p * 4 + c * 4 + f * 9), p, c, f, fiber: 0 }, name.trim(), meal ?? mealNow(), date ?? dateKey()));
  } });
export const entriesUpdate = defineCommand({ name: 'entries.update', kind: 'action',
  description: 'Fix a logged entry. Food entries: amount as grams, or qty + unit ("g"/"ml" or a portion label); with both, grams drive nutrition and qty + unit stay as the label. Nutrition is recomputed from the food (or from the entry\'s own snapshot if that food was deleted); the entry keeps its name. Quick-add entries: name, kcal, p, c, f (kcal recalculates from macros as 4/4/9 when only macros change). Any entry: meal or date. Returns the entry.',
  input: z.object({ id: zId, grams: z.number().positive().optional(), qty: z.number().positive().optional(), unit: z.string().optional(), meal: zMeal.optional(), date: zDate.optional(),
    name: z.string().optional().describe('quick-add entries only'), kcal: z.number().min(0).optional().describe('quick-add entries only'),
    p: z.number().min(0).optional().describe('quick-add entries only'), c: z.number().min(0).optional().describe('quick-add entries only'), f: z.number().min(0).optional().describe('quick-add entries only') }),
  run: async ({ id, grams, qty, unit, meal, date, name, kcal, p, c, f }) => {
    const e = await db.entries.get(id); if (!e || !alive(e)) throw new Error('Entry not found');
    const m = meal ?? e.meal, d = date ?? e.date;
    if (e.source === 'quick' || !e.foodId) {
      const macros = p != null || c != null || f != null;
      if (name == null && kcal == null && !macros) return entryView(await save('entries', { ...e, meal: m, date: d }));
      const np = p ?? e.n.p, nc = c ?? e.n.c, nf = f ?? e.n.f;
      const nk = kcal ?? (macros ? Math.round(np * 4 + nc * 4 + nf * 9) : e.n.kcal);
      return entryView(await quickAdd({ kcal: nk, p: np, c: nc, f: nf, fiber: 0 }, (name ?? e.name).trim(), m, d, e));
    }
    const found = await getItem(e.foodId);
    const it: FoodItem | undefined = found ? { ...found, name: e.name }
      : e.grams ? { key: e.foodId, source: e.source as FoodItem['source'], name: e.name, brand: e.brand, portions: [], per100: scale(e.n, 10000 / e.grams) } : undefined;
    if (!it) throw new Error('The food behind this entry no longer exists');
    let g = e.grams ?? 0, q = e.qty ?? g, u = e.unit ?? (it.unitBase ?? 'g');
    if (qty != null || grams != null) ({ g, q, u } = resolveAmount(it, { grams, qty, unit: qty != null ? unit ?? e.unit : undefined }));
    return entryView(await logEntry(it, g, q, u, m, d, e));
  } });
export const entriesDelete = defineCommand({ name: 'entries.delete', kind: 'action', description: 'Delete a food log entry (soft delete, syncs).',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('entries', id); return { ok: true }; } });

// ---------------- bulk: copy · move · delete · log many ----------------
const zIds = z.array(zId).min(1).max(200).describe('Entry ids (from entries.list)');
async function liveEntries(ids0: string[]) {
  const ids = [...new Set(ids0)];
  const got = await db.entries.bulkGet(ids);
  const missing = ids.filter((_, i) => !alive(got[i]));
  if (missing.length) throw new Error(`Entry not found: ${missing.join(', ')}`);
  return (got as FoodEntry[]).sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at);
}
/** A timestamp on `date` at the current time of day (+i ms keeps the copied order). */
const atOn = (date: string, i: number) => {
  const now = new Date(); const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()).getTime() + i;
};

export const entriesCopy = defineCommand({ name: 'entries.copy', kind: 'action',
  description: 'Copy logged entries (any dates/meals) to a date, e.g. "same breakfast as yesterday". Each copy is a new entry with a new id, the same food, amount and nutrition snapshot (not recomputed), timestamped on the target date at the current time of day, in the original order. meal moves all copies into that meal; omit it to keep each entry\'s own meal. Returns the new entries.',
  input: z.object({ ids: zIds, date: zDate, meal: zMeal.optional().describe('target meal; omit = same meal as each original') }),
  run: async ({ ids, date, meal }) => {
    const src = await liveEntries(ids);
    const out: FoodEntry[] = [];
    for (const [i, e] of src.entries()) {
      const { id: _id, createdAt: _c, updatedAt: _u, deletedAt: _d, ...rest } = e;
      out.push(await save('entries', newRecord({ ...rest, date, meal: meal ?? e.meal, at: atOn(date, i) }) as FoodEntry));
    }
    return out.map(entryView);
  } });
export const entriesMove = defineCommand({ name: 'entries.move', kind: 'action',
  description: 'Move logged entries to another date and/or meal (e.g. "that snack was lunch", "I logged it on the wrong day"). Only date and meal change; id, food, amount, nutrition and timestamp stay as they are. meal omitted = each entry keeps its meal. Returns the updated entries.',
  input: z.object({ ids: zIds, date: zDate, meal: zMeal.optional().describe('target meal; omit = keep each entry\'s meal') }),
  run: async ({ ids, date, meal }) => {
    const out: FoodEntry[] = [];
    for (const e of await liveEntries(ids)) out.push(await save('entries', { ...e, date, meal: meal ?? e.meal }));
    return out.map(entryView);
  } });
export const entriesDeleteMany = defineCommand({ name: 'entries.deleteMany', kind: 'action', description: 'Delete several food log entries at once (soft delete, syncs; records.restore brings one back).',
  input: z.object({ ids: zIds }), run: async ({ ids }) => { for (const id of ids) await remove('entries', id); return { ok: true, deleted: ids.length }; } });

/** Amount for a food with none given: the amount you used last time, else its first unit × 1, else 100 g/ml. */
export async function defaultAmount(it: FoodItem) {
  const last = await db.entries.orderBy('at').reverse().filter((e) => alive(e) && e.foodId === it.key && !!e.grams).first();
  if (last?.grams) {
    const b = it.unitBase ?? 'g';
    // keep the last unit only if the food still has it, so the amount means the same thing
    if (last.unit && !isBaseUnit(last.unit, b) && !findPortion(it, last.unit)) return { g: last.grams, q: last.grams, u: b };
    return { g: last.grams, q: last.qty ?? last.grams, u: last.unit && !isBaseUnit(last.unit, b) ? last.unit : b };
  }
  const p = it.portions[0];
  return p ? { g: p.g, q: 1, u: p.label } : { g: 100, q: 100, u: it.unitBase ?? 'g' };
}
export const entriesLogMany = defineCommand({ name: 'entries.logMany', kind: 'action',
  description: 'Log several foods at once to one meal (e.g. "add eggs, toast and coffee to breakfast"). Each item: foodKey (from foods.search), and optionally grams, or qty + unit like entries.log, and name (override, like entries.log). With no amount, the food is logged with the amount you used last time, else 1 of its first unit, else 100 g/ml. date defaults to today, meal to the time of day. All foods are checked before anything is logged. Returns the new entries in order.',
  input: z.object({
    items: z.array(z.object({ foodKey: z.string(), grams: z.number().positive().optional(), qty: z.number().positive().optional(), unit: z.string().optional(),
      name: z.string().trim().min(1).optional().describe('stored entry name override, as in entries.log') })
      .refine((v) => (v.qty == null) === (v.unit == null), 'Give qty and unit together')).min(1).max(60),
    meal: zMeal.optional(), date: zDate.optional() }),
  run: async ({ items, meal, date }) => {
    const { mealNow } = await import('../lib/meals');
    const m = meal ?? mealNow(), d = date ?? dateKey();
    const plan = [];
    for (const i of items) {
      const it = await getItem(i.foodKey); if (!it) throw new Error(`Unknown food ${i.foodKey}`);
      plan.push({ it: i.name ? { ...it, name: i.name } : it, a: i.grams != null || i.qty != null ? resolveAmount(it, i) : await defaultAmount(it) });
    }
    const out = [];
    for (const { it, a } of plan) out.push(entryView(await logEntry(it, a.g, a.q, a.u, m, d)));
    return out;
  } });

export const daysComplete = defineCommand({ name: 'days.setComplete', kind: 'action', description: 'Mark a day as fully logged or not (only complete days are used to estimate maintenance). Returns the day status.',
  input: z.object({ date: zDate, complete: z.boolean() }),
  run: async ({ date, complete }) => { const d = await db.days.get(date); return save('days', d ? { ...d, complete } : { ...newRecord({ complete }), id: date } as DayStatus); } });

// ---------------- goals ----------------
export const goalsGet = defineCommand({ name: 'goals.get', kind: 'query', description: 'Nutrition goals in force on a date (profile, maintenance, calorie/protein/carb/fat targets — any may be null).',
  input: z.object({ date: zDate.optional() }), run: async ({ date }) => (await goalFor(date ?? dateKey())) ?? null });
export const goalsSet = defineCommand({ name: 'goals.set', kind: 'action',
  description: 'Set nutrition goals from today on (older days keep their targets; a goal already set today is updated in place). Omitted fields keep current values. maintenanceKcal = a manual maintenance override; null (or omitted with no override in force) = the Mifflin-St Jeor × activity estimate from the latest weigh-in. kcal defaults from maintenance and weekly rate, protein to 1.6 g/kg. Pass null to turn a kcal/protein/carb/fat target off. Returns the saved goal.',
  input: z.object({ sex: z.enum(['male', 'female']).optional(), birthYear: z.number().int().min(1900).max(2020).optional(), heightCm: z.number().optional(), activity: z.enum(['sedentary', 'light', 'active', 'very']).optional(),
    rateKgPerWeek: z.number().min(-1.5).max(1.5).optional(), maintenanceKcal: z.number().positive().nullable().optional(),
    kcal: z.number().positive().nullable().optional(), proteinG: z.number().positive().nullable().optional(), carbsG: z.number().min(0).nullable().optional(), fatG: z.number().min(0).nullable().optional() }),
  run: async (i) => {
    const today = dateKey();
    const cur = await goalFor(today);
    const kg = (await db.bodyweight.orderBy('at').reverse().filter(alive).first())?.kg ?? 80;
    const sex = i.sex ?? cur?.sex ?? 'male', birthYear = i.birthYear ?? cur?.birthYear ?? 1995, heightCm = i.heightCm ?? cur?.heightCm ?? 175, activity = i.activity ?? cur?.activity ?? 'light';
    const rate = i.rateKgPerWeek ?? cur?.rateKgPerWeek ?? 0;
    // omitted maintenanceKcal keeps a manual override or an accepted log-based (adaptive) value as-is, with its label
    const keepManual = i.maintenanceKcal === undefined && cur?.maintenanceSource === 'manual';
    const keepAdaptive = i.maintenanceKcal === undefined && cur?.maintenanceSource === 'adaptive' && cur.maintenanceKcal != null;
    const maint = i.maintenanceKcal ?? (keepManual || keepAdaptive ? cur!.maintenanceKcal : estimateMaintenance(sex, kg, heightCm, new Date().getFullYear() - birthYear, activity));
    const fields = { effectiveFrom: today, sex, birthYear, heightCm, activity, rateKgPerWeek: rate, maintenanceKcal: maint,
      maintenanceSource: (i.maintenanceKcal != null || keepManual ? 'manual' : i.maintenanceKcal === null ? 'formula' : cur?.maintenanceSource ?? 'formula') as NutritionGoal['maintenanceSource'],
      kcal: i.kcal === undefined ? cur?.kcal ?? targetKcal(maint, rate) : i.kcal, proteinG: i.proteinG === undefined ? cur?.proteinG ?? Math.round(kg * 1.6) : i.proteinG,
      carbsG: i.carbsG === undefined ? cur?.carbsG ?? null : i.carbsG, fatG: i.fatG === undefined ? cur?.fatG ?? null : i.fatG };
    const same = await db.goals.where('effectiveFrom').equals(today).filter(alive).first();
    return save('goals', same ? { ...same, ...fields } : newRecord(fields) as NutritionGoal);
  } });
