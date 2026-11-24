// Food requests (entries.log / entries.logMany) as an editable card: every item gets explicit grams + qty/unit when the
// request is built, the card swaps foods / changes amounts / unchecks items by editing the stored request itself, and
// Apply runs exactly what the card shows.
import { defaultAmount, findPortion, isBaseUnit, resolveAmount } from '../../api/food';
import { getItem, type FoodItem } from '../../db/food';
import { isRef } from './refs';
import type { RequestAction } from './types';

export const isFoodAction = (name: string) => name === 'entries.log' || name === 'entries.logMany';

type Item = { foodKey: string; grams?: number; qty?: number; unit?: string; name?: string; alternatives?: unknown };

/** Pull `alternatives` out of the model's input (they are not command input), fill in explicit amounts, drop unknown
 *  alternative keys. Throws with a model-readable message when a food is unknown. */
export async function normalizeFoodAction(name: string, input: Record<string, unknown>): Promise<RequestAction> {
  const fix = async (it: Item) => {
    if (isRef(it.foodKey)) { // a food created earlier in the same request ("$0.id"): nothing to look up yet
      if (it.grams == null) throw new Error(`Give grams for "${it.foodKey}" (a food created in this request)`);
      const { alternatives: _a, ...rest } = it;
      return { item: rest as Item & { grams: number; qty: number; unit: string }, alts: [] as string[] };
    }
    const food = await getItem(it.foodKey);
    if (!food) throw new Error(`Unknown food key "${it.foodKey}" (use a key from foods.search)`);
    const { alternatives, ...rest } = it;
    let amt: { g: number; q: number; u: string };
    if (rest.grams == null && rest.qty == null) amt = await defaultAmount(food);
    else amt = resolveAmount(food, rest);
    const alts: string[] = [];
    for (const k of Array.isArray(alternatives) ? alternatives.slice(0, 6) : []) {
      if (typeof k === 'string' && k !== it.foodKey && !alts.includes(k) && (await getItem(k))) alts.push(k);
    }
    return { item: { ...rest, grams: round1(amt.g), qty: round2(amt.q), unit: amt.u }, alts };
  };
  if (name === 'entries.log') {
    const { item, alts } = await fix(input as Item);
    const { alternatives: _a, ...meta } = input;
    return { name, input: { ...meta, ...item }, alternatives: alts };
  }
  const items = Array.isArray(input.items) ? (input.items as Item[]) : [];
  const fixed = await Promise.all(items.map(fix));
  return { name, input: { ...input, items: fixed.map((f) => f.item) }, alternatives: fixed.map((f) => f.alts) };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

export type FoodLine = { item: Item & { grams: number; qty: number; unit: string }; alts: string[]; off: boolean };

/** The card's rows for one food action. */
export function foodLines(a: RequestAction): FoodLine[] {
  const off = a.off ?? [];
  if (a.name === 'entries.log') return [{ item: a.input as FoodLine['item'], alts: (a.alternatives as string[] | undefined) ?? [], off: !!off[0] }];
  const items = (a.input.items as FoodLine['item'][]) ?? [];
  const alts = (a.alternatives as string[][] | undefined) ?? [];
  return items.map((item, i) => ({ item, alts: alts[i] ?? [], off: !!off[i] }));
}

function withItem(a: RequestAction, i: number, next: FoodLine['item'], alts?: string[]): RequestAction {
  if (a.name === 'entries.log') return { ...a, input: { ...a.input, ...next, ...(next.name ? {} : { name: undefined }) }, ...(alts ? { alternatives: alts } : {}) };
  const items = [...(a.input.items as FoodLine['item'][])]; items[i] = next;
  const all = [...((a.alternatives as string[][] | undefined) ?? items.map(() => []))]; if (alts) all[i] = alts;
  return { ...a, input: { ...a.input, items }, alternatives: all };
}

/** Swap item i to another food, keeping the grams; the old food becomes an alternative (swap back). */
export async function swapFood(a: RequestAction, i: number, key: string): Promise<RequestAction> {
  const line = foodLines(a)[i];
  const food = await getItem(key);
  if (!food) return a;
  const base = food.unitBase ?? 'g';
  const g = line.item.grams;
  const p = food.portions[0];
  const next = p ? { foodKey: key, grams: g, qty: round2(g / p.g), unit: p.label } : { foodKey: key, grams: g, qty: g, unit: base };
  const alts = [line.item.foodKey, ...line.alts.filter((k) => k !== key)];
  return withItem(a, i, next, alts);
}

/** New amount in the item's own unit. */
export function setAmount(a: RequestAction, i: number, food: FoodItem, qty: number): RequestAction {
  const it = foodLines(a)[i].item;
  const base = food.unitBase ?? 'g';
  if (isBaseUnit(it.unit, base)) return withItem(a, i, { ...it, grams: round1(qty), qty: round2(qty), unit: base });
  const p = findPortion(food, it.unit);
  const per = p?.g ?? (it.qty ? it.grams / it.qty : 100);
  return withItem(a, i, { ...it, qty: round2(qty), grams: round1(per * qty) });
}

export function toggleLine(a: RequestAction, i: number): RequestAction {
  const n = a.name === 'entries.log' ? 1 : ((a.input.items as unknown[]) ?? []).length;
  const off = Array.from({ length: n }, (_, k) => !!a.off?.[k]);
  off[i] = !off[i];
  return { ...a, off };
}

/** What Apply runs: unchecked items removed; null = nothing left in this action. */
export function appliedAction(a: RequestAction): RequestAction | null {
  if (!a.off?.some(Boolean)) return a;
  if (a.name === 'entries.log') return a.off[0] ? null : a;
  if (a.name === 'entries.logMany') {
    const items = (a.input.items as unknown[]).filter((_, i) => !a.off![i]);
    return items.length ? { ...a, input: { ...a.input, items } } : null;
  }
  return a;
}

const EMOJI: [RegExp, string][] = [
  [/egg|ביצ/i, '🥚'], [/rice|אורז/i, '🍚'], [/chicken|עוף|drumstick|שוק/i, '🍗'], [/beef|steak|בקר|סטייק/i, '🥩'], [/fish|salmon|tuna|דג|סלמון|טונה/i, '🐟'],
  [/bread|toast|pita|לחם|פיתה|טוסט/i, '🍞'], [/pasta|spaghetti|פסטה/i, '🍝'], [/pizza|פיצה/i, '🍕'], [/burger|המבורגר/i, '🍔'], [/salad|סלט/i, '🥗'],
  [/banana|בננה/i, '🍌'], [/potato|fries|תפוחי? אדמה|צ'יפס/i, '🥔'], [/apple|תפוח(?!י? אדמה)/i, '🍎'], [/milk|חלב/i, '🥛'], [/cheese|גבינ/i, '🧀'],
  [/yogurt|יוגורט/i, '🥣'], [/oat|שיבולת/i, '🥣'], [/coffee|קפה/i, '☕'], [/tomato|עגבני/i, '🍅'], [/cucumber|מלפפון/i, '🥒'], [/avocado|אבוקדו/i, '🥑'],
  [/hummus|חומוס/i, '🫘'], [/bean|lentil|שעועית|עדשים/i, '🫘'], [/nut|almond|peanut|bamba|אגוז|שקד|בוטן|במבה/i, '🥜'], [/chocolate|שוקולד/i, '🍫'], [/cake|cookie|עוגה|עוגי/i, '🍪'],
  [/protein|whey|חלבון/i, '🥤'], [/juice|מיץ/i, '🧃'], [/soup|מרק/i, '🍲'], [/orange|תפוז/i, '🍊'], [/berr|תות/i, '🍓'], [/corn|תירס/i, '🌽'],
];
export const foodEmoji = (name: string) => EMOJI.find(([re]) => re.test(name))?.[1] ?? '🍽️';
