import type { Meal } from '../db/types';

export const MEALS: { id: Meal; label: string; icon: string }[] = [
  { id: 'breakfast', label: 'Breakfast', icon: 'sun' },
  { id: 'lunch', label: 'Lunch', icon: 'food' },
  { id: 'dinner', label: 'Dinner', icon: 'moon' },
  { id: 'snacks', label: 'Snacks', icon: 'cookie' },
];
/** Default meal by time of day, so "+" usually lands in the right place. */
export const mealNow = (): Meal => { const h = new Date().getHours(); return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snacks'; };
/** Whole number with thousands separators. */
export const k = (v: number) => Math.round(v).toLocaleString();
