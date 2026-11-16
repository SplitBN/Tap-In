// Calendar: what happened on each day (workouts, food, weigh-ins, supplements) as markers + a short summary.
// Used by the Home week strip and the /calendar month page; the agent gets the same data via calendar.month.
import { z } from 'zod';
import { defineCommand, zDate } from './registry';
import { alive, db } from '../db/db';
import { buildDay } from '../db/supps';
import { dateKey, goalHit, keyToDate, shiftDate, sum } from '../lib/nutrition';
import type { Macros } from '../db/types';

export interface CalendarDay {
  date: string;
  markers: { workout: boolean; foodGoalHit: boolean; foodComplete: boolean; weighIn: boolean; suppsAllTaken: boolean };
  workouts: { id: string; name: string; minutes: number }[];
  food: { kcal: number; p: number; c: number; f: number; entries: number; goalKcal: number | null; goalProteinG: number | null; complete: boolean } | null;
  weighIns: { id: string; kg: number; at: string }[];
  supps: { due: number; taken: number } | null;
}

/** Per-day markers and summary for every date from..to (inclusive). */
export async function calendarRange(from: string, to: string): Promise<CalendarDay[]> {
  const lo = keyToDate(from).getTime(), hi = keyToDate(shiftDate(to, 1)).getTime();
  const today = dateKey();
  const [sessions, weights, entries, goals, days, sups, stacks, logs] = await Promise.all([
    db.sessions.where('startedAt').between(lo, hi).filter((s) => alive(s) && !!s.endedAt).toArray(),
    db.bodyweight.where('at').between(lo, hi).filter(alive).toArray(),
    db.entries.where('date').between(from, to, true, true).filter(alive).toArray(),
    db.goals.orderBy('effectiveFrom').filter(alive).toArray(),
    db.days.where('id').between(from, to, true, true).filter(alive).toArray(),
    db.supplements.filter(alive).toArray(),
    db.stacks.filter(alive).toArray(),
    db.supplogs.where('date').between(from, to, true, true).filter(alive).toArray(),
  ]);
  const out: CalendarDay[] = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) {
    const daySessions = sessions.filter((s) => dateKey(s.startedAt) === d).sort((a, b) => a.startedAt - b.startedAt);
    const dayWeights = weights.filter((w) => dateKey(w.at) === d).sort((a, b) => a.at - b.at);
    const dayEntries = entries.filter((e) => e.date === d);
    // goal in force that day (goals are versioned by effectiveFrom); hit = kcal within ±10% and protein met (lib/nutrition goalHit)
    const g = [...goals].reverse().find((x) => x.effectiveFrom <= d) ?? goals[0];
    const total: Macros = sum(dayEntries.map((e) => e.n));
    const complete = !!days.find((x) => x.id === d)?.complete;
    const hit = !!g && dayEntries.length > 0 && goalHit(total, g.kcal, g.proteinG);
    // supplements: judged against the CURRENT schedule (archived ones are left out); never on future days
    const items = d <= today ? buildDay(d, sups, stacks, logs.filter((l) => l.date === d)).flatMap((x) => x.stacks.flatMap((s) => s.items)) : [];
    const taken = items.filter((i) => i.log?.status === 'taken').length;
    out.push({
      date: d,
      markers: { workout: daySessions.length > 0, foodGoalHit: hit, foodComplete: complete, weighIn: dayWeights.length > 0, suppsAllTaken: items.length > 0 && taken === items.length },
      workouts: daySessions.map((s) => ({ id: s.id, name: s.name, minutes: Math.round(((s.endedAt ?? s.startedAt) - s.startedAt) / 60000) })),
      food: dayEntries.length || complete ? { kcal: Math.round(total.kcal), p: Math.round(total.p), c: Math.round(total.c), f: Math.round(total.f), entries: dayEntries.length,
        goalKcal: g?.kcal ?? null, goalProteinG: g?.proteinG ?? null, complete } : null,
      weighIns: dayWeights.map((w) => ({ id: w.id, kg: w.kg, at: new Date(w.at).toISOString() })),
      supps: items.length ? { due: items.length, taken } : null,
    });
  }
  return out;
}

const DESC_DAY = 'Each day: markers { workout (a finished workout started that day), foodGoalHit (calories within ±10% of the goal in force that day and protein ≥ 95%, only for targets that are set), ' +
  'foodComplete (day marked fully logged), weighIn, suppsAllTaken (every scheduled supplement dose that day was taken; judged against the current schedule, archived supplements left out, never true for future days) }, ' +
  'workouts [{ id (open with sessions.get / sessions.summary), name, minutes }], food (totals kcal/p/c/f, entries, goalKcal, goalProteinG, complete; null when nothing logged), weighIns [{ id, kg, at }], supps { due, taken } (null when nothing was due).';

export const calendarMonth = defineCommand({ name: 'calendar.month', kind: 'query',
  description: `Calendar for one month: one entry per day (1st to last) of what happened. ${DESC_DAY} Use for "which days did I train / hit my goals in March" questions.`,
  input: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).describe('Month YYYY-MM') }),
  run: async ({ month }) => {
    const [y, m] = month.split('-').map(Number);
    const first = `${month}-01`;
    const last = dateKey(new Date(y, m, 0));
    return { month, days: await calendarRange(first, last) };
  } });

export const calendarRangeCmd = defineCommand({ name: 'calendar.range', kind: 'query',
  description: `Same as calendar.month for any span of up to 62 days (from..to inclusive), e.g. one week. ${DESC_DAY}`,
  input: z.object({ from: zDate, to: zDate }),
  run: async ({ from, to }) => {
    if (to < from) throw new Error('to must be on or after from');
    if (shiftDate(from, 62) <= to) throw new Error('At most 62 days; use calendar.month for longer views month by month');
    return { from, to, days: await calendarRange(from, to) };
  } });
