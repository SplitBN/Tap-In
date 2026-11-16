// "Week N" of a plan: Week 1 is the Monday-start week that holds the plan's start date
// (plan.startDate, else the day it was created). Calendar dates, not ms / 7 days, so DST never shifts it.
import type { Plan } from '../db/types';
import { dateKey, keyToDate } from './nutrition';

const monday = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

/** YYYY-MM-DD the plan's weeks count from. */
export const planStart = (p: Pick<Plan, 'createdAt' | 'startDate'>) => p.startDate ?? dateKey(p.createdAt);

/** 1-based week number today (a start date in the future still reads Week 1). */
export function planWeek(p: Pick<Plan, 'createdAt' | 'startDate'>, now: Date | number = new Date()) {
  const days = Math.round((monday(new Date(now)).getTime() - monday(keyToDate(planStart(p))).getTime()) / 86400000);
  return Math.max(1, Math.round(days / 7) + 1);
}
