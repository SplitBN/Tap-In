import { alive, db, newRecord, save } from './db';
import type { LowStock, Schedule, Stack, SuppLog, Supplement } from './types';
import { keyToDate } from '../lib/nutrition';

export const FORMS = [
  { value: 'capsule', label: 'Capsule' }, { value: 'tablet', label: 'Tablet' }, { value: 'powder', label: 'Powder' },
  { value: 'liquid', label: 'Liquid' }, { value: 'injection', label: 'Injection' }, { value: 'other', label: 'Other' },
] as const;
export const UNITS = ['mg', 'mcg', 'g', 'IU', 'ml', 'units', 'caps', 'tabs', 'drops', 'scoops'];
export const SITES = ['Abdomen L', 'Abdomen R', 'Thigh L', 'Thigh R', 'Arm L', 'Arm R', 'Glute L', 'Glute R'];
export const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const daysBetween = (a: string, b: string) => Math.round((keyToDate(b).getTime() - keyToDate(a).getTime()) / 86400000);

/** Is this scheduled on `date`? (as-needed items never are) */
export function isDue(s: Schedule, date: string): boolean {
  if (s.kind === 'asNeeded' || date < s.startDate) return false;
  const diff = daysBetween(s.startDate, date);
  if (s.cycle && s.cycle.onDays > 0) {
    const len = s.cycle.onDays + s.cycle.offDays;
    if (len > 0 && diff % len >= s.cycle.onDays) return false; // off phase of the cycle
  }
  switch (s.kind) {
    case 'daily': return true;
    case 'weekdays': return (s.days ?? []).includes(keyToDate(date).getDay());
    case 'interval': return diff % Math.max(1, s.every ?? 1) === 0;
    case 'weekly': return diff % 7 === 0;
  }
  return false;
}

/** The dose in force on a date: latest step that started on or before it. */
export function doseOn(sup: Supplement, date: string) {
  const steps = [...sup.doses].sort((a, b) => a.from.localeCompare(b.from));
  return [...steps].reverse().find((d) => d.from <= date)?.amount ?? steps[0]?.amount ?? 0;
}

export function scheduleText(s: Schedule) {
  const t = s.times.length ? ` · ${s.times.join(', ')}` : '';
  const c = s.cycle ? ` · ${s.cycle.onDays} on / ${s.cycle.offDays} off` : '';
  switch (s.kind) {
    case 'daily': return `Daily${t}${c}`;
    case 'weekdays': return `${(s.days ?? []).sort().map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(' ')}${t}${c}`;
    case 'interval': return `Every ${s.every ?? 2} days${t}${c}`;
    case 'weekly': return `Weekly on ${keyToDate(s.startDate).toLocaleDateString(undefined, { weekday: 'long' })}${t}`;
    case 'asNeeded': return 'As needed';
  }
}

// ---- stock forecast — mirrored in server/src/reminders.ts (stockForecast): keep in sync ----
// Stock is in dose units (logTake subtracts the amount taken). Walk forward from today, consuming
// doseOn × number of daily times on each due day; today's slots that already have a log are not
// counted again (their take already left the stock). daysLeft = days from today until the first
// due day the stock can't cover (0 = today); null for as-needed (no schedule to project).
export const DEFAULT_LOW_STOCK: LowStock = { kind: 'days', value: 7 };
export const STOCK_HORIZON = 400;
const addDays = (key: string, n: number) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export function stockForecast(s: Supplement, today: string, logs: { supplementId: string; date: string; slot: string | null; deletedAt?: number | null }[]) {
  if (s.stock == null || s.archived || s.deletedAt) return null;
  const threshold = s.lowStock === undefined ? DEFAULT_LOW_STOCK : s.lowStock; // null = alerts off
  let daysLeft: number | null = null;
  let runsOutOn: string | null = null;
  if (s.schedule.kind !== 'asNeeded') {
    const mine = logs.filter((l) => !l.deletedAt && l.supplementId === s.id && l.date === today);
    const times = s.schedule.times;
    const slots = Math.max(1, times.length);
    const logged = times.length ? times.filter((t) => mine.some((l) => l.slot === t)).length : Math.min(1, mine.filter((l) => l.slot == null).length);
    let left = s.stock;
    daysLeft = STOCK_HORIZON;
    for (let i = 0; i < STOCK_HORIZON; i++) {
      const d = addDays(today, i);
      if (!isDue(s.schedule, d)) continue;
      const need = (i === 0 ? slots - logged : slots) * doseOn(s, d);
      if (need > left + 1e-9) { daysLeft = i; runsOutOn = d; break; }
      left -= need;
    }
  }
  const low = !threshold ? false : threshold.kind === 'amount' ? s.stock <= threshold.value : daysLeft != null && daysLeft <= threshold.value;
  return { stock: s.stock, daysLeft, runsOutOn, threshold, low };
}
export type StockForecast = NonNullable<ReturnType<typeof stockForecast>>;

/** "~5 days left", "Runs out today", "Out of stock", or the amount (amount alerts, or no schedule to project).
 *  Same wording as stockText in server/src/reminders.ts — keep in sync. */
export function stockText(f: StockForecast, unit: string) {
  if (f.stock <= 0) return 'Out of stock';
  if (f.threshold?.kind === 'amount' || f.daysLeft == null || f.daysLeft >= STOCK_HORIZON) return `${+f.stock.toFixed(2)} ${unit} left`; // amount alert: say the amount
  if (f.daysLeft === 0) return 'Runs out today';
  return `~${f.daysLeft} ${f.daysLeft === 1 ? 'day' : 'days'} left`;
}

export interface DueItem { sup: Supplement; slot: string; amount: number; log?: SuppLog }
export interface SlotGroup { slot: string; stacks: { stack: Stack | null; items: DueItem[] }[] }

/** Today's checklist: due items grouped by time, and within a time by stack (unstacked items alone). */
export function buildDay(date: string, sups: Supplement[], stacks: Stack[], logs: SuppLog[]): SlotGroup[] {
  const due: DueItem[] = [];
  for (const sup of sups) {
    if (sup.archived || !isDue(sup.schedule, date)) continue;
    for (const slot of sup.schedule.times.length ? sup.schedule.times : ['--:--']) {
      due.push({ sup, slot, amount: doseOn(sup, date), log: logs.find((l) => l.supplementId === sup.id && (l.slot ?? '--:--') === slot) }); // untimed doses are logged with slot null
    }
  }
  const slots = [...new Set(due.map((d) => d.slot))].sort();
  return slots.map((slot) => {
    const here = due.filter((d) => d.slot === slot);
    const groups: SlotGroup['stacks'] = [];
    const used = new Set<string>();
    for (const st of stacks) {
      const items = here.filter((d) => st.supplementIds.includes(d.sup.id) && !used.has(d.sup.id));
      if (items.length >= 2) { items.forEach((i) => used.add(i.sup.id)); groups.push({ stack: st, items }); }
    }
    for (const d of here) if (!used.has(d.sup.id)) groups.push({ stack: null, items: [d] });
    return { slot, stacks: groups };
  });
}

export async function logTake(sup: Supplement, date: string, slot: string | null, amount: number, opts: { site?: string | null; takenAt?: number; status?: 'taken' | 'skipped'; existing?: SuppLog } = {}) {
  const status = opts.status ?? 'taken';
  const base = opts.existing ?? newRecord({ supplementId: sup.id, date, slot, takenAt: null, status, amount, unit: sup.unit } as Omit<SuppLog, 'id' | 'createdAt' | 'updatedAt'>);
  const rec = await save('supplogs', {
    ...base, status, amount, unit: sup.unit, site: opts.site ?? base.site ?? null,
    takenAt: status === 'taken' ? opts.takenAt ?? base.takenAt ?? Date.now() : null,
  });
  // stock goes down when taken (and back up if a take is undone elsewhere)
  if (status === 'taken' && !opts.existing && sup.stock != null) await save('supplements', { ...sup, stock: Math.max(0, sup.stock - amount) });
  return rec;
}

export async function undoTake(log: SuppLog, sup?: Supplement) {
  await save('supplogs', { ...log, deletedAt: Date.now() });
  if (log.status === 'taken' && sup?.stock != null) await save('supplements', { ...sup, stock: sup.stock + log.amount });
}

/** Suggest the next injection site: the one used least recently (rotation lowers lipohypertrophy risk). */
export async function nextSite(supplementId: string) {
  const logs = await db.supplogs.where('supplementId').equals(supplementId).filter((l) => alive(l) && !!l.site).toArray();
  const last = new Map<string, number>();
  for (const l of logs) last.set(l.site!, Math.max(last.get(l.site!) ?? 0, l.takenAt ?? 0));
  return [...SITES].sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0))[0];
}
