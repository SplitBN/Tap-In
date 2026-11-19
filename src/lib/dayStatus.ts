// Inferred "was this day fully logged?" — replaces the manual switch nobody remembers to flip. Pure (unit-testable).
//   open      today, and yesterday until dayCloseHour (04:00) unless the next day already has an entry
//   you       an override (days record: the user said complete true/false) wins → complete / partial
//   empty     no entries
//   auto      baseline B = median kcal of the last 28 closed days that are complete (override true, or ≥2 meal slots
//             and ≥3 entries), needing ≥7 of them; else the calorie target; else formula maintenance.
//             complete: kcal ≥ 0.7·B and ≥2 meal slots · partial: kcal < 0.5·B or only 1 meal slot · else unsure.
import { dateKey, shiftDate } from './nutrition';

export type DayStatusKind = 'open' | 'empty' | 'complete' | 'partial' | 'unsure';
export interface InferredDay { date: string; status: DayStatusKind; source: 'auto' | 'you'; kcal: number; baseline: number | null; reason: string }

export interface InferInput {
  dates: string[];
  kcalByDay: Map<string, number>;
  mealsByDay: Map<string, Set<string> | string[]>; // distinct meal slots
  entriesByDay: Map<string, number>; // entry count
  overrides: Map<string, boolean>;
  now: Date;
  /** calorie target in force (goals), else formula maintenance; null = none */
  targetKcal: number | null;
  fallbackKcal?: number | null;
  dayCloseHour?: number;
}

const MEAL_WORD: Record<string, string> = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snacks: 'snacks' };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const size = (m: Set<string> | string[] | undefined) => (m ? (Array.isArray(m) ? new Set(m).size : m.size) : 0);
const first = (m: Set<string> | string[] | undefined) => (m ? [...m][0] : undefined);

/** Is `date` still open (the day can still get food)? */
export function isOpenDay(date: string, now: Date, hasEntry: (d: string) => boolean, closeHour = 4) {
  const today = dateKey(now.getTime());
  if (date >= today) return true;
  if (date === shiftDate(today, -1)) return now.getHours() < closeHour && !hasEntry(today);
  return false;
}

/** Auto-complete without the baseline rule (used to build the baseline itself). */
const looksComplete = (meals: number, entries: number) => meals >= 2 && entries >= 3;

export function inferDayStatuses(p: InferInput): InferredDay[] {
  const close = p.dayCloseHour ?? 4;
  const has = (d: string) => (p.entriesByDay.get(d) ?? 0) > 0;
  const today = dateKey(p.now.getTime());
  // the baseline per date: median of the 28 closed days before it that are complete
  const allDays = [...new Set([...p.kcalByDay.keys(), ...p.overrides.keys()])].sort();
  const baselineFor = (date: string): number | null => {
    const lo = shiftDate(date, -28);
    const pool: number[] = [];
    for (const d of allDays) {
      if (d >= date || d < lo || isOpenDay(d, p.now, has, close)) continue;
      const kcal = p.kcalByDay.get(d) ?? 0;
      if (kcal <= 0) continue;
      const o = p.overrides.get(d);
      if (o === true || (o === undefined && looksComplete(size(p.mealsByDay.get(d)), p.entriesByDay.get(d) ?? 0))) pool.push(kcal);
    }
    if (pool.length >= 7) return Math.round(median(pool));
    return p.targetKcal ?? p.fallbackKcal ?? null;
  };
  return p.dates.map((date) => {
    const kcal = Math.round(p.kcalByDay.get(date) ?? 0);
    const meals = size(p.mealsByDay.get(date));
    const entries = p.entriesByDay.get(date) ?? 0;
    const o = p.overrides.get(date);
    if (o !== undefined) return { date, status: o ? 'complete' : 'partial', source: 'you', kcal, baseline: null, reason: o ? 'You confirmed it' : 'You said some is missing' };
    if (date > today || isOpenDay(date, p.now, has, close)) return { date, status: entries ? 'open' : date > today ? 'empty' : 'open', source: 'auto', kcal, baseline: null, reason: date === today ? 'Today' : 'Still open' };
    if (!entries) return { date, status: 'empty', source: 'auto', kcal: 0, baseline: null, reason: 'Nothing logged' };
    const B = baselineFor(date);
    if (meals <= 1) {
      const m = first(p.mealsByDay.get(date));
      return { date, status: 'partial', source: 'auto', kcal, baseline: B, reason: m ? `Only ${MEAL_WORD[m] ?? m} logged` : 'Only one meal logged' };
    }
    if (B == null) return { date, status: entries >= 3 ? 'complete' : 'unsure', source: 'auto', kcal, baseline: null, reason: entries >= 3 ? 'Several meals logged' : 'Few entries' };
    if (kcal < 0.5 * B) return { date, status: 'partial', source: 'auto', kcal, baseline: B, reason: 'Much less than usual' };
    if (kcal >= 0.7 * B) return { date, status: 'complete', source: 'auto', kcal, baseline: B, reason: 'Looks like a full day' };
    return { date, status: 'unsure', source: 'auto', kcal, baseline: B, reason: 'Less than usual' };
  });
}
