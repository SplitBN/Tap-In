import { alive, db, newRecord, save } from './db';
import type { Food, FoodEntry, Macros, Meal, NutritionGoal, Portion } from './types';
import { scale } from '../lib/nutrition';
import { rank, tokenize } from '../lib/search';

/** Unified view of anything you can log: bundled databases and your own/scanned foods. */
export interface FoodItem {
  key: string; // 'usda:<fdcId>', 'moh:<code>', 'il:<barcode>' or a Food id
  source: 'usda' | 'moh' | 'off' | 'custom' | 'recipe';
  unitBase?: 'g' | 'ml';
  name: string;
  alt?: string; // second-language name (English for Hebrew items), searchable
  brand?: string;
  barcode?: string;
  category?: string;
  israeli?: boolean;
  per100: Macros;
  portions: Portion[];
}

interface Bundled { items: FoodItem[]; byKey: Map<string, FoodItem>; byBarcode: Map<string, FoodItem>; names: Map<string, [string, string]> }
let bundled: Bundled | null = null;
let loading: Promise<Bundled> | null = null;

type UsdaRow = [number, string, number, number, number, number, number, number, [string, number][]];
type MohRow = [number, string, string, number, number, number, number, number, [string, number][]];
type IlRow = [string, string, string, string, number, number, number, number, number, number];

/** Lazily loads the bundled food databases (cached by the service worker, so search works offline):
 *  Israeli MoH Tzameret + Israeli Open Food Facts products (il.json) and USDA SR Legacy (foods.json). */
export function loadFoods(): Promise<Bundled> {
  if (bundled) return Promise.resolve(bundled);
  loading ??= Promise.all([import('../data/il.json'), import('../data/foods.json')]).then(([{ default: il }, { default: us }]) => {
    const items: FoodItem[] = [];
    for (const [code, he, en, kcal, p, c, f, fiber, portions] of il.moh as unknown as MohRow[]) {
      items.push({ key: `moh:${code}`, source: 'moh', israeli: true, name: he, alt: en || undefined, category: 'Tzameret',
        per100: { kcal, p, c, f, fiber }, portions: portions.map(([label, g]) => ({ label, g })) });
    }
    for (const [code, name, alt, brand, kcal, p, c, f, fiber, servingG] of il.off as unknown as IlRow[]) {
      items.push({ key: `il:${code}`, source: 'off', israeli: true, name, alt: alt || undefined, brand: brand || undefined, barcode: code,
        per100: { kcal, p, c, f, fiber }, portions: servingG ? [{ label: '1 serving', g: servingG }] : [] });
    }
    const cats = us.categories as string[];
    for (const [id, name, cat, kcal, p, c, f, fiber, portions] of us.rows as unknown as UsdaRow[]) {
      items.push({ key: `usda:${id}`, source: 'usda', name, category: cats[cat],
        per100: { kcal, p, c, f, fiber }, portions: portions.map(([label, g]) => ({ label, g })) });
    }
    const built: Bundled = {
      items, byKey: new Map(items.map((i) => [i.key, i])),
      byBarcode: new Map(items.filter((i) => i.barcode).map((i) => [i.barcode!, i])),
      // Israeli products known by name only (no nutrition on Open Food Facts) — used to prefill the editor
      names: new Map(((il as unknown as { names?: [string, string, string][] }).names ?? []).map(([code, n, br]) => [code, [n, br]] as [string, [string, string]])),
    };
    bundled = built;
    return built;
  });
  return loading;
}

export const foodToItem = (f: Food): FoodItem => ({ key: f.id, source: f.source, name: f.name, brand: f.brand, barcode: f.barcode, per100: f.per100, portions: f.portions, unitBase: f.unitBase });

export async function getItem(key: string): Promise<FoodItem | undefined> {
  if (/^(usda|moh|il):/.test(key)) return (await loadFoods()).byKey.get(key);
  const f = await db.foods.get(key);
  return f && alive(f) ? foodToItem(f) : undefined;
}

const PROCESSED = /Sausages and Luncheon|Fast Foods|Restaurant Foods|Baby Foods|Meals, Entrees|Snacks|American Indian/;
const HEBREW = /\p{Script=Hebrew}/u;
/** Each language's name is its own field (brand appended to both), so word positions aren't skewed
 *  by the other language: "banana" matches "Banana, raw" at position 0, not after five Hebrew words. */
const tokenCache = new WeakMap<FoodItem, string[][]>();
const tokensOf = (it: FoodItem) => {
  let t = tokenCache.get(it);
  if (!t) {
    const brand = it.brand ? tokenize(it.brand) : [];
    t = [[...tokenize(it.name), ...brand]];
    if (it.alt) t.push([...tokenize(it.alt), ...brand]);
    tokenCache.set(it, t);
  }
  return t;
};

/** How often/recently each food was logged (last year) — feeds the ranking. */
export async function foodUsage() {
  const since = Date.now() - 365 * 86400000;
  const m = new Map<string, { n: number; last: number }>();
  await db.entries.where('at').above(since).each((e) => {
    if (!e.foodId || e.deletedAt) return;
    const u = m.get(e.foodId) ?? { n: 0, last: 0 };
    u.n++; u.last = Math.max(u.last, e.at); m.set(e.foodId, u);
  });
  return m;
}

/** Forgiving search (typos, partial words, any order, Hebrew/English) ranked by match quality,
 *  then by how often you log it. Tiers nudge: your foods > Israeli (MoH + local products) > USDA. */
export async function searchFoods(q: string, limit = 60): Promise<FoodItem[]> {
  const mine = (await db.foods.filter(alive).toArray()).map(foodToItem);
  const [{ items }, usage] = await Promise.all([loadFoods(), foodUsage()]);
  const hebrewQuery = HEBREW.test(q);
  const pool = hebrewQuery ? [...mine, ...items.filter((i) => i.source !== 'usda')] : [...mine, ...items];
  return rank(pool, q, {
    tokensOf, keyOf: (it) => it.key, nameLength: (it) => it.name.length, usage, limit,
    bias: (it) => (it.source === 'usda' ? 1.5 + (it.category && PROCESSED.test(it.category) ? 1.5 : 0) + (/\braw\b/i.test(it.name) ? -0.5 : 0)
      : it.israeli ? 0.4 : -1),
  });
}

/** Most recently logged distinct foods. */
export async function recentItems(limit = 25): Promise<FoodItem[]> {
  const entries = await db.entries.orderBy('at').reverse().filter((e) => alive(e) && !!e.foodId).limit(300).toArray();
  const seen = new Set<string>(); const keys: string[] = [];
  for (const e of entries) if (!seen.has(e.foodId!)) { seen.add(e.foodId!); keys.push(e.foodId!); if (keys.length >= limit) break; }
  return (await Promise.all(keys.map(getItem))).filter(Boolean) as FoodItem[];
}

/** Goal in force on a date: the latest one effective on or before it (or the earliest, as fallback). */
export async function goalFor(date: string): Promise<NutritionGoal | undefined> {
  const all = (await db.goals.orderBy('effectiveFrom').filter(alive).toArray());
  return [...all].reverse().find((g) => g.effectiveFrom <= date) ?? all[0];
}

export async function logEntry(item: FoodItem, grams: number, qty: number, unit: string, meal: Meal, date: string, existing?: FoodEntry) {
  const n = scale(item.per100, grams);
  const base = existing ?? newRecord({ date, at: Date.now(), meal, source: item.source, name: item.name, n } as Omit<FoodEntry, 'id' | 'createdAt' | 'updatedAt'>);
  return save('entries', { ...base, date, meal, source: item.source, foodId: item.key, name: item.name, brand: item.brand, grams, qty, unit, n });
}

export async function quickAdd(n: Macros, name: string, meal: Meal, date: string, existing?: FoodEntry) {
  const base = existing ?? newRecord({ date, at: Date.now(), meal, source: 'quick', name, n } as Omit<FoodEntry, 'id' | 'createdAt' | 'updatedAt'>);
  return save('entries', { ...base, date, meal, name: name || 'Quick add', n, grams: null });
}

// ---------- barcodes: Open Food Facts (open data, ODbL) ----------
const r1 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : typeof v === 'string' && v !== '' && Number.isFinite(+v) ? Math.round(+v * 10) / 10 : null);

function knownName(code: string): Partial<Food> | undefined {
  const n = bundled?.names.get(code);
  return n ? { barcode: code, name: n[0], brand: n[1] || undefined } : undefined;
}

/** Local first (scanned or fixed before), then Open Food Facts. Only the barcode is sent. */
export async function lookupBarcode(code: string): Promise<{ food?: Food; status: 'local' | 'found' | 'incomplete' | 'missing' | 'offline'; draft?: Partial<Food> }> {
  const local = await db.foods.where('barcode').equals(code).filter(alive).first();
  if (local) return { food: local, status: 'local' };
  const il = (await loadFoods()).byBarcode.get(code); // bundled Israeli products: instant and offline
  if (il) {
    const food = await save('foods', newRecord({ source: 'off' as const, name: il.name, brand: il.brand, barcode: code, per100: il.per100, portions: il.portions }));
    return { food, status: 'found' };
  }
  let json: { status?: number; product?: Record<string, unknown> };
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,nutriments,serving_size,serving_quantity`);
    json = await res.json();
  } catch { return { status: 'offline', draft: knownName(code) }; }
  const p = json.product;
  if (json.status !== 1 || !p) return { status: 'missing', draft: knownName(code) ?? { barcode: code } };
  const nm = (p.nutriments ?? {}) as Record<string, unknown>;
  const kj = r1(nm['energy_100g']);
  const per100 = {
    kcal: r1(nm['energy-kcal_100g']) ?? (kj != null ? Math.round(kj / 4.184) : null),
    p: r1(nm['proteins_100g']), c: r1(nm['carbohydrates_100g']), f: r1(nm['fat_100g']), fiber: r1(nm['fiber_100g']) ?? 0,
  };
  const name = String(p.product_name || '').trim();
  const brand = String(p.brands || '').split(',')[0].trim() || undefined;
  const servingG = r1(p.serving_quantity);
  const portions: Portion[] = servingG ? [{ label: `1 serving${p.serving_size ? ` (${p.serving_size})` : ''}`.slice(0, 48), g: servingG }] : [];
  const draft: Partial<Food> = { barcode: code, name, brand, portions, per100: per100 as Macros };
  if (!name || per100.kcal == null || per100.p == null || per100.c == null || per100.f == null) return { status: 'incomplete', draft };
  const food = await save('foods', newRecord({ source: 'off' as const, name, brand, barcode: code, per100: per100 as Macros, portions }));
  return { food, status: 'found' };
}

/** Foods you log most at this meal, with the amount you used last time (for one-tap / multi-select logging). */
export async function frequentFor(meal: Meal, limit = 20): Promise<{ item: FoodItem; qty: number; unit: string; grams: number; n: number }[]> {
  const since = Date.now() - 180 * 86400000;
  const agg = new Map<string, { n: number; last: FoodEntry }>();
  await db.entries.where('at').above(since).each((e) => {
    if (!e.foodId || e.deletedAt || e.source === 'quick') return;
    const a = agg.get(e.foodId) ?? { n: 0, last: e };
    a.n += e.meal === meal ? 2 : 1; // this meal counts double, so "breakfast foods" lead at breakfast
    if (e.at >= a.last.at) a.last = e;
    agg.set(e.foodId, a);
  });
  const top = [...agg.entries()].sort((x, y) => y[1].n - x[1].n || y[1].last.at - x[1].last.at).slice(0, limit);
  const out = [];
  for (const [key, a] of top) {
    const item = await getItem(key);
    if (item) out.push({ item, qty: a.last.qty ?? a.last.grams ?? 100, unit: a.last.unit ?? 'g', grams: a.last.grams ?? 100, n: a.n });
  }
  return out;
}

/** Recipe totals → per-100 g nutrition and a per-serving portion. */
export function recipeNutrition(ingredients: { grams: number; per100: Macros }[], servings: number, cookedG?: number | null) {
  const total = ingredients.reduce((a, i) => {
    const m = scale(i.per100, i.grams);
    return { kcal: a.kcal + m.kcal, p: a.p + m.p, c: a.c + m.c, f: a.f + m.f, fiber: (a.fiber ?? 0) + (m.fiber ?? 0) };
  }, { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 } as Macros);
  const rawG = ingredients.reduce((a, i) => a + i.grams, 0);
  const weight = cookedG && cookedG > 0 ? cookedG : rawG;
  const per100 = weight > 0 ? scale(total, 10000 / weight) : { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 };
  // scale() multiplies by g/100, so passing 10000/weight gives total × 100/weight = per 100 g
  return { total, weight, per100, servingG: servings > 0 ? weight / servings : weight };
}
