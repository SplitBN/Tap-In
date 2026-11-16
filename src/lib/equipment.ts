import type { Exercise } from '../db/types';

/** Equipment values used by the exercise library (keep in sync with scripts/exercise-curation.mjs). */
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'smith machine', 'cable', 'body only', 'kettlebells', 'e-z curl bar', 'bands', 'exercise ball', 'medicine ball', 'other'] as const;

const LABELS: Record<string, string> = {
  barbell: 'Barbell', dumbbell: 'Dumbbell', machine: 'Machine', 'smith machine': 'Smith', cable: 'Cable', 'body only': 'Bodyweight',
  kettlebells: 'Kettlebell', 'e-z curl bar': 'EZ Bar', bands: 'Band', 'exercise ball': 'Ball', 'medicine ball': 'Med Ball', other: 'Other',
};

/** Short display name for an equipment value ("smith machine" → "Smith"). */
export const equipmentLabel = (eq: string) => LABELS[eq] ?? eq.replace(/\b\w/g, (c) => c.toUpperCase());

/** The equipment tag shown next to an exercise name in lists, or '' when it adds nothing
 *  ("other", or the name already says it, e.g. "Kettlebell Swing", "Seated Cable Row"). */
export function equipmentTag(e: Pick<Exercise, 'name' | 'equipment'> | undefined) {
  if (!e || !e.equipment || e.equipment === 'other') return '';
  const label = equipmentLabel(e.equipment);
  return e.name.toLowerCase().includes(label.toLowerCase()) ? '' : label;
}

/** Name plus equipment as one string — for places that only take text (sheet titles, confirms, the agent API). */
export function exerciseLabel(e: Pick<Exercise, 'name' | 'equipment'> | undefined, fallback = 'Exercise') {
  if (!e) return fallback;
  const tag = equipmentTag(e);
  return tag ? `${e.name} · ${tag}` : e.name;
}
