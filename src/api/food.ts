import { z } from 'zod';
import { defineCommand, zDate, zId, zMeal } from './registry';
import { alive, db, newRecord, remove, save } from '../db/db';
import { foodToItem, getItem, goalFor, logEntry, lookupBarcode, quickAdd, recipeNutrition, searchFoods } from '../db/food';
import type { DayStatus, Food, FoodEntry, NutritionGoal } from '../db/types';
import { dateKey, estimateMaintenance, scale, sum, targetKcal } from '../lib/nutrition';

const zMacros = z.object({ kcal: z.number().min(0), p: z.number().min(0), c: z.number().min(0), f: z.number().min(0), fiber: z.number().min(0).optional() });
const zPortion = z.object({ label: z.string().describe('e.g. "1 bar", "1 scoop"'), g: z.number().positive().describe('grams (or ml) per unit') });
const r1 = (v: number) => Math.round(v * 10) / 10;
const item = (it: Awaited<ReturnType<typeof getItem>>) => it && ({ key: it.key, source: it.source, name: it.name, alt: it.alt, brand: it.brand, per100: it.per100, unitBase: it.unitBase ?? 'g', portions: it.portions });

export const foodsSearch = defineCommand({ name: 'foods.search', kind: 'query',
  description: 'Search foods (Hebrew or English, typo-tolerant): your own foods and recipes, Israeli MoH and Israeli products, then USDA. Ranked by match then by how often you log it. Nutrition is per 100 g (or 100 ml). key is what you pass to entries.log / recipes.',
  input: z.object({ query: z.string(), limit: z.number().int().max(60).default(15) }),
  run: async ({ query, limit }) => (await searchFoods(query, limit)).map(item) });
export const foodsGet = defineCommand({ name: 'foods.get', kind: 'query', description: 'One food by key (with portions/units and per-100 g nutrition).',
  input: z.object({ key: z.string() }), run: async ({ key }) => item(await getItem(key)) ?? null });
export const foodsBarcode = defineCommand({ name: 'foods.lookupBarcode', kind: 'action',
  description: 'Look up a product barcode: saved foods, bundled Israeli products, then Open Food Facts (only the barcode is sent). A found product is saved to your foods.',
  input: z.object({ barcode: z.string().regex(/^\d{8,14}$/) }), run: async ({ barcode }) => { const r = await lookupBarcode(barcode); return { status: r.status, food: r.food ? item(foodToItem(r.food)) : null, draft: r.draft ?? null }; } });

export const foodsCreate = defineCommand({ name: 'foods.create', kind: 'action',
  description: 'Create your own food. per100 is nutrition per 100 g (or per 100 ml when unitBase is "ml"); add portions like {label:"1 bar", g:45}. Convert label values per serving to per 100 first.',
  input: z.object({ name: z.string().min(1), brand: z.string().optional(), barcode: z.string().optional(), unitBase: z.enum(['g', 'ml']).default('g'), per100: zMacros, portions: z.array(zPortion).default([]) }),
  run: async (i) => save('foods', newRecord({ source: 'custom' as const, ...i, per100: { ...i.per100, fiber: i.per100.fiber ?? 0 } }) as Food) });
export const foodsUpdate = defineCommand({ name: 'foods.update', kind: 'action', description: 'Edit one of your foods (not bundled database foods). Past log entries keep their numbers.',
  input: z.object({ id: zId, name: z.string().optional(), brand: z.string().optional(), unitBase: z.enum(['g', 'ml']).optional(), per100: zMacros.optional(), portions: z.array(zPortion).optional() }),
  run: async ({ id, ...p }) => { const f = await db.foods.get(id); if (!f || !alive(f)) throw new Error('Food not found (only your own foods can be edited)'); return save('foods', { ...f, ...p } as Food); } });
export const foodsDelete = defineCommand({ name: 'foods.delete', kind: 'action', description: 'Delete one of your foods or recipes.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('foods', id); return { ok: true }; } });

export const recipesSave = defineCommand({ name: 'recipes.save', kind: 'action',
  description: 'Create or update a recipe from foods (ingredient keys from foods.search) with grams each. servings = how many portions the batch makes; cookedG = weight after cooking if known (water loss/gain). The recipe becomes a loggable food with a "1 serving" unit.',
  input: z.object({ id: zId.optional(), name: z.string().min(1), servings: z.number().int().min(1).default(1), cookedG: z.number().positive().nullable().optional(),
    ingredients: z.array(z.object({ foodKey: z.string(), grams: z.number().positive() })).min(1) }),
  run: async ({ id, name, servings, cookedG, ingredients }) => {
    const ings = [];
    for (const i of ingredients) { const it = await getItem(i.foodKey); if (!it) throw new Error(`Unknown food ${i.foodKey}`); ings.push({ foodKey: it.key, name: it.name, grams: i.grams, per100: it.per100 }); }
    const r = recipeNutrition(ings, servings, cookedG);
    const fields = { source: 'recipe' as const, name, unitBase: 'g' as const, ingredients: ings, servings, cookedG: cookedG ?? null,
      per100: { kcal: r1(r.per100.kcal), p: r1(r.per100.p), c: r1(r.per100.c), f: r1(r.per100.f), fiber: r1(r.per100.fiber ?? 0) },
      portions: [{ label: '1 serving', g: r1(r.servingG) }] };
    const existing = id ? await db.foods.get(id) : undefined;
    const saved = await save('foods', existing ? { ...existing, ...fields } as Food : newRecord(fields) as Food);
    const ps = scale(saved.per100, r.servingG); // from the stored (rounded) per-100 g values, so it matches what logging gives
    return { recipe: item(foodToItem(saved)), perServing: { kcal: Math.round(ps.kcal), p: r1(ps.p), c: r1(ps.c), f: r1(ps.f) }, servingG: r1(r.servingG) };
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
export const entriesLog = defineCommand({ name: 'entries.log', kind: 'action',
  description: 'Log a food. Give grams, or qty + unit where unit is one of the food\'s portion labels exactly as listed in foods.search / foods.get portions[].label (e.g. qty 2, unit "1 slice"; labels may be Hebrew). date defaults to today, meal to the time of day.',
  input: z.object({ foodKey: z.string(), date: zDate.optional(), meal: zMeal.optional(), grams: z.number().positive().optional(), qty: z.number().positive().optional(), unit: z.string().optional() })
    .refine((v) => v.grams != null || (v.qty != null && !!v.unit), 'Give grams, or qty with unit'),
  run: async ({ foodKey, date, meal, grams, qty, unit }) => {
    const it = await getItem(foodKey); if (!it) throw new Error(`Unknown food ${foodKey}`);
    let g = grams ?? 0; let u: string = it.unitBase ?? 'g'; let q = grams ?? 0;
    if (grams == null) {
      const p = it.portions.find((x) => x.label === unit || x.label === `1 ${unit}`);
      if (!p) throw new Error(`Unit "${unit}" not found. Available: ${it.portions.map((x) => x.label).join(', ') || 'grams only'}`);
      g = p.g * qty!; u = p.label; q = qty!;
    }
    const { mealNow } = await import('../lib/meals');
    return entryView(await logEntry(it, g, q, u, meal ?? mealNow(), date ?? dateKey()));
  } });
export const entriesQuick = defineCommand({ name: 'entries.quickAdd', kind: 'action',
  description: 'Log an estimate by macros only (restaurant meal, guess). kcal defaults to 4·protein + 4·carbs + 9·fat.',
  input: z.object({ name: z.string().default('Quick add'), date: zDate.optional(), meal: zMeal.optional(), kcal: z.number().min(0).optional(), p: z.number().min(0).default(0), c: z.number().min(0).default(0), f: z.number().min(0).default(0) }),
  run: async ({ name, date, meal, kcal, p, c, f }) => {
    const { mealNow } = await import('../lib/meals');
    return entryView(await quickAdd({ kcal: kcal ?? Math.round(p * 4 + c * 4 + f * 9), p, c, f, fiber: 0 }, name, meal ?? mealNow(), date ?? dateKey()));
  } });
export const entriesUpdate = defineCommand({ name: 'entries.update', kind: 'action', description: 'Fix a logged food: amount (grams or qty+unit), meal or date.',
  input: z.object({ id: zId, grams: z.number().positive().optional(), qty: z.number().positive().optional(), unit: z.string().optional(), meal: zMeal.optional(), date: zDate.optional() }),
  run: async ({ id, grams, qty, unit, meal, date }) => {
    const e = await db.entries.get(id); if (!e || !alive(e)) throw new Error('Entry not found');
    if (e.source === 'quick' || !e.foodId) return entryView(await save('entries', { ...e, meal: meal ?? e.meal, date: date ?? e.date }));
    const it = await getItem(e.foodId); if (!it) throw new Error('The food behind this entry no longer exists');
    let g = e.grams ?? 0; let u = e.unit ?? 'g'; let q = e.qty ?? g;
    if (grams != null) { g = grams; u = it.unitBase ?? 'g'; q = grams; }
    else if (qty != null) { const p = it.portions.find((x) => x.label === (unit ?? e.unit) || x.label === `1 ${unit}`); g = p ? p.g * qty : qty; u = p?.label ?? u; q = qty; }
    return entryView(await logEntry(it, g, q, u, meal ?? e.meal, date ?? e.date, e));
  } });
export const entriesDelete = defineCommand({ name: 'entries.delete', kind: 'action', description: 'Delete a food log entry.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('entries', id); return { ok: true }; } });
export const daysComplete = defineCommand({ name: 'days.setComplete', kind: 'action', description: 'Mark a day as fully logged (only complete days are used to estimate maintenance).',
  input: z.object({ date: zDate, complete: z.boolean() }),
  run: async ({ date, complete }) => { const d = await db.days.get(date); return save('days', d ? { ...d, complete } : { ...newRecord({ complete }), id: date } as DayStatus); } });

// ---------------- goals ----------------
export const goalsGet = defineCommand({ name: 'goals.get', kind: 'query', description: 'Nutrition goals in force on a date (profile, maintenance, calorie/protein/carb/fat targets — any may be null).',
  input: z.object({ date: zDate.optional() }), run: async ({ date }) => (await goalFor(date ?? dateKey())) ?? null });
export const goalsSet = defineCommand({ name: 'goals.set', kind: 'action',
  description: 'Set nutrition goals from today on (older days keep their targets). Omitted fields keep current values; maintenance defaults to the Mifflin-St Jeor × activity estimate; kcal defaults from maintenance and weekly rate. Pass null to turn a target off.',
  input: z.object({ sex: z.enum(['male', 'female']).optional(), birthYear: z.number().int().optional(), heightCm: z.number().optional(), activity: z.enum(['sedentary', 'light', 'active', 'very']).optional(),
    rateKgPerWeek: z.number().min(-1.5).max(1.5).optional(), maintenanceKcal: z.number().positive().optional(),
    kcal: z.number().positive().nullable().optional(), proteinG: z.number().positive().nullable().optional(), carbsG: z.number().min(0).nullable().optional(), fatG: z.number().min(0).nullable().optional() }),
  run: async (i) => {
    const today = dateKey();
    const cur = await goalFor(today);
    const kg = (await db.bodyweight.orderBy('at').reverse().filter(alive).first())?.kg ?? 80;
    const sex = i.sex ?? cur?.sex ?? 'male', birthYear = i.birthYear ?? cur?.birthYear ?? 1995, heightCm = i.heightCm ?? cur?.heightCm ?? 175, activity = i.activity ?? cur?.activity ?? 'light';
    const rate = i.rateKgPerWeek ?? cur?.rateKgPerWeek ?? 0;
    const maint = i.maintenanceKcal ?? (cur?.maintenanceSource === 'manual' ? cur.maintenanceKcal : estimateMaintenance(sex, kg, heightCm, new Date().getFullYear() - birthYear, activity));
    const fields = { effectiveFrom: today, sex, birthYear, heightCm, activity, rateKgPerWeek: rate, maintenanceKcal: maint,
      maintenanceSource: (i.maintenanceKcal ? 'manual' : cur?.maintenanceSource ?? 'formula') as NutritionGoal['maintenanceSource'],
      kcal: i.kcal === undefined ? cur?.kcal ?? targetKcal(maint, rate) : i.kcal, proteinG: i.proteinG === undefined ? cur?.proteinG ?? Math.round(kg * 1.6) : i.proteinG,
      carbsG: i.carbsG === undefined ? cur?.carbsG ?? null : i.carbsG, fatG: i.fatG === undefined ? cur?.fatG ?? null : i.fatG };
    const same = await db.goals.where('effectiveFrom').equals(today).filter(alive).first();
    return save('goals', same ? { ...same, ...fields } : newRecord(fields) as NutritionGoal);
  } });
