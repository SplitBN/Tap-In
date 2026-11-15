import { alive, db, newRecord, save } from './db';
import type { Food, FoodEntry, Macros, Meal, NutritionGoal, Portion } from './types';
import { scale } from '../lib/nutrition';

/** Unified view of anything you can log: bundled USDA foods and your own/scanned foods. */
export interface FoodItem {
  key: string; // 'usda:<fdcId>' or a Food id
  source: 'usda' | 'off' | 'custom';
  name: string;
  brand?: string;
  category?: string;
  per100: Macros;
  portions: Portion[];
}

type UsdaRow = [number, string, number, number, number, number, number, number, [string, number][]];
interface UsdaDb { items: FoodItem[]; byKey: Map<string, FoodItem> }
let usda: UsdaDb | null = null;
let loading: Promise<UsdaDb> | null = null;

/** Lazily loads the bundled USDA SR Legacy database (~1 MB, cached by the service worker). */
export function loadUsda(): Promise<UsdaDb> {
  if (usda) return Promise.resolve(usda);
  loading ??= import('../data/foods.json').then(({ default: d }) => {
    const cats = d.categories as string[];
    const items = (d.rows as unknown as UsdaRow[]).map(([id, name, cat, kcal, p, c, f, fiber, portions]) => ({
      key: `usda:${id}`, source: 'usda' as const, name, category: cats[cat],
      per100: { kcal, p, c, f, fiber }, portions: portions.map(([label, g]) => ({ label, g })),
    }));
    const built: UsdaDb = { items, byKey: new Map(items.map((i) => [i.key, i])) };
    usda = built;
    return built;
  });
  return loading;
}

export const foodToItem = (f: Food): FoodItem => ({ key: f.id, source: f.source, name: f.name, brand: f.brand, per100: f.per100, portions: f.portions });

export async function getItem(key: string): Promise<FoodItem | undefined> {
  if (key.startsWith('usda:')) return (await loadUsda()).byKey.get(key);
  const f = await db.foods.get(key);
  return f && alive(f) ? foodToItem(f) : undefined;
}

const PROCESSED = /Sausages and Luncheon|Fast Foods|Restaurant Foods|Baby Foods|Meals, Entrees|Snacks|American Indian/;
const squash = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ');

/** Word-prefix search; your own foods first, then shorter / earlier matches (USDA names are long). */
export async function searchFoods(q: string, limit = 60): Promise<FoodItem[]> {
  const words = squash(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const mine = (await db.foods.filter(alive).toArray()).map(foodToItem);
  const { items } = await loadUsda();
  const scored: [number, FoodItem][] = [];
  for (const it of [...mine, ...items]) {
    const hay = squash(`${it.name} ${it.brand ?? ''}`);
    const tokens = hay.split(/\s+/);
    if (!words.every((w) => tokens.some((t) => t.startsWith(w)))) continue;
    let score = it.source === 'usda' ? 100 : 0;
    score += hay.indexOf(words[0]) + it.name.length / 8;
    if (/\braw\b/.test(hay)) score -= 3; // plain whole foods are what people usually mean
    if (it.category && PROCESSED.test(it.category)) score += 8; // deli/fast-food/baby versions rank below the plain food
    scored.push([score, it]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((s) => s[1]);
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

/** Local first (scanned or fixed before), then Open Food Facts. Only the barcode is sent. */
export async function lookupBarcode(code: string): Promise<{ food?: Food; status: 'local' | 'found' | 'incomplete' | 'missing' | 'offline'; draft?: Partial<Food> }> {
  const local = await db.foods.where('barcode').equals(code).filter(alive).first();
  if (local) return { food: local, status: 'local' };
  let json: { status?: number; product?: Record<string, unknown> };
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,nutriments,serving_size,serving_quantity`);
    json = await res.json();
  } catch { return { status: 'offline' }; }
  const p = json.product;
  if (json.status !== 1 || !p) return { status: 'missing', draft: { barcode: code } };
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
