// Food search ranking, kept free of Dexie / browser imports so scripts/check-food-search.mjs can run it in Node
// against the bundled databases (regression checks before every build). db/food.ts wires it to the user's foods.
import type { FoodItem } from '../db/food';
import { normalize, rankScored, tokenize } from './search.ts';

export type Usage = Map<string, { n: number; last: number }>;

type UsdaRow = [number, string, number, number, number, number, number, number, [string, number][]];
type MohRow = [number, string, string, number, number, number, number, number, [string, number][]];
type IlRow = [string, string, string, string, number, number, number, number, number, number];

/** Rows of il.json (Israeli MoH Tzameret + Israeli Open Food Facts products) and foods.json (USDA SR Legacy) → items. */
export function bundledItems(il: unknown, us: unknown): FoodItem[] {
  const items: FoodItem[] = [];
  const I = il as { moh: MohRow[]; off: IlRow[] }, U = us as { categories: string[]; rows: UsdaRow[] };
  for (const [code, he, en, kcal, p, c, f, fiber, portions] of I.moh) {
    items.push({ key: `moh:${code}`, source: 'moh', israeli: true, name: he, alt: en || undefined, category: 'Tzameret',
      per100: { kcal, p, c, f, fiber }, portions: portions.map(([label, g]) => ({ label, g })) });
  }
  for (const [code, name, alt, brand, kcal, p, c, f, fiber, servingG] of I.off) {
    items.push({ key: `il:${code}`, source: 'off', israeli: true, name, alt: alt || undefined, brand: brand || undefined, barcode: code,
      per100: { kcal, p, c, f, fiber }, portions: servingG ? [{ label: '1 serving', g: servingG }] : [] });
  }
  for (const [id, name, cat, kcal, p, c, f, fiber, portions] of U.rows) {
    items.push({ key: `usda:${id}`, source: 'usda', name, category: U.categories[cat],
      per100: { kcal, p, c, f, fiber }, portions: portions.map(([label, g]) => ({ label, g })) });
  }
  return items;
}

const PROCESSED = /Sausages and Luncheon|Fast Foods|Restaurant Foods|Baby Foods|Meals, Entrees|Snacks|American Indian/;
/** Unusual variants that should not win a plain query ("milk" ≠ human milk). */
const ODD = /\b(human|infant|baby|toddler|formula|camel|goat|sheep)\b|חלב אם|תינוק|פורמולה/i;
const HEBREW = /\p{Script=Hebrew}/u;
const PREPARED = /\b(fried|chips|mix|popped|porridge|nuggets|patties|roll|salad|dried|powder|cake|pudding|coated|flavou?red|canned|sweetened|breaded|instant)\b|McDonald|מטוגן|אבקה|מיובש|תערובת/i;
const PLAIN = /\b(cooked|boiled|steamed|raw|plain|fresh|whole)\b|מבושל|טרי/i;
/** A food named in both languages and matched by both halves of a mixed query is almost certainly the one meant. */
const BOTH_SCRIPTS_BONUS = 1.5;

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

/** One single-script (or whole) query, scored. */
function scoredFoods(q: string, mine: FoodItem[], items: FoodItem[], usage: Usage | undefined, limit: number): [number, FoodItem][] {
  const pool = HEBREW.test(q) ? [...mine, ...items.filter((i) => i.source !== 'usda')] : [...mine, ...items];
  // Food tables name the base food first, then qualifiers after commas ("Rice, white, cooked"; "אורז, לבן").
  // Query = that head noun → it's the food itself; query followed by another word ("Rice flour") → a derived product.
  const qn = normalize(q).trim();
  const head = (text: string | undefined) => {
    const n = normalize(text ?? '').trim();
    if (!qn || !n.startsWith(qn)) return 0;
    const rest = (text ?? '').trim().slice(q.trim().length).trimStart();
    return n === qn || rest.startsWith(',') || rest === '' ? -1.5 : 0.5;
  };
  const headBias = (it: FoodItem) => {
    const h = Math.min(head(it.name), head(it.alt));
    if (h >= 0) return h;
    const all = `${it.name} ${it.alt ?? ''}`;
    // among foods that ARE the query: plain cooked/raw forms before prepared products
    return h + (/uncooked|לא מבושל/i.test(all) ? 0.4 : 0) + (PREPARED.test(all) ? 0.8 : PLAIN.test(all) ? -0.4 : 0);
  };
  return rankScored(pool, q, {
    tokensOf, keyOf: (it) => it.key, nameLength: (it) => it.name.length, usage, limit,
    bias: (it) => (it.source === 'usda' ? 1.5 + (it.category && PROCESSED.test(it.category) ? 1.5 : 0) + (/\braw\b/i.test(it.name) ? -0.5 : 0)
      : it.israeli ? 0.4 : -1) + (ODD.test(`${it.name} ${it.alt ?? ''}`) ? 3 : 0) + headBias(it),
  });
}

/** A query mixing Hebrew and Latin-letter words → [Hebrew words, other words]; null when it is one script. Words
 *  without letters ("3%", "500") are not a script: they go into both halves ("חלב 3%" stays a single-script query). */
export function scriptParts(q: string): [string, string] | null {
  const words = q.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const lettered = (w: string) => /\p{L}/u.test(w);
  const he = words.filter((w) => HEBREW.test(w)), other = words.filter((w) => lettered(w) && !HEBREW.test(w));
  if (!he.length || !other.length) return null;
  const plain = words.filter((w) => !lettered(w));
  return [[...he, ...plain].join(' '), [...other, ...plain].join(' ')];
}

/** Forgiving search (typos, partial words, any order, Hebrew/English) ranked by match quality, then by how often
 *  you log it. Tiers nudge: your foods > Israeli (MoH + local products) > USDA. Every item name is single-language,
 *  so a mixed query ("cooked white rice אורז לבן מבושל") is searched per script and whole, merged by best score. */
export function rankFoods(q: string, mine: FoodItem[], items: FoodItem[], usage?: Usage, limit = 60): FoodItem[] {
  const parts = scriptParts(q);
  if (!parts) return scoredFoods(q, mine, items, usage, limit).map((x) => x[1]);
  // whole-query score, and each half's score. An item matched by both halves scores its better half, plus half of how
  // much worse the other half fits (capped at 2, so Hebrew spelling variants can't sink it), minus a bonus: it must fit
  // both languages ("Rice, white, cooked" beats "Rice, white, uncooked" for "cooked white rice אורז לבן מבושל").
  const best = new Map<string, { it: FoodItem; whole?: number; parts: number[] }>();
  const get = (it: FoodItem) => { let b = best.get(it.key); if (!b) best.set(it.key, b = { it, parts: [] }); return b; };
  for (const [s, it] of scoredFoods(q, mine, items, usage, limit)) get(it).whole = s;
  for (const part of parts) for (const [s, it] of scoredFoods(part, mine, items, usage, 400)) get(it).parts.push(s); // wide, so "matched both" is seen
  return [...best.values()].map((b) => {
    const [lo, hi] = [...b.parts].sort((x, y) => x - y);
    const both = b.parts.length >= 2 ? lo + Math.min(hi - lo, 2) / 2 - BOTH_SCRIPTS_BONUS : Infinity;
    return [Math.min(both, b.whole ?? Infinity, b.parts.length === 1 ? b.parts[0] : Infinity), b.it] as const;
  })
    .sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}
