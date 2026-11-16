/** Tzameret household measures are Hebrew; when the food is shown in English, translate the common words. */
const HE_UNITS: Record<string, string> = {
  'יחידה': 'unit', 'יחידות': 'units', 'כוס': 'cup', 'כף': 'tbsp', 'כפית': 'tsp', 'פרוסה': 'slice', 'מנה': 'serving', 'קערה': 'bowl',
  'חופן': 'handful', 'קופסה': 'can', 'בקבוק': 'bottle', 'שקית': 'bag', 'חבילה': 'pack', 'גביע': 'tub', 'משולש': 'wedge', 'כדור': 'ball',
  'מגש': 'tray', 'צלחת': 'plate', 'חצי': 'half', 'רבע': 'quarter', 'מעוך': 'mashed', 'חתוך': 'chopped', 'מגורר': 'grated',
};
const HE_SIZES: Record<string, string> = { 'קטנה': 'small', 'קטן': 'small', 'בינונית': 'medium', 'בינוני': 'medium', 'גדולה': 'large', 'גדול': 'large', 'מאד': 'very', 'דקה': 'thin', 'עבה': 'thick' };

export const hasHebrew = (s: string | undefined) => !!s && /\p{Script=Hebrew}/u.test(s);

export function unitLabel(label: string, english: boolean) {
  if (!english || !hasHebrew(label)) return label;
  const words = label.replace(/^1 /, '').split(/\s+/);
  const sizes = words.filter((w) => HE_SIZES[w]).map((w) => HE_SIZES[w]);
  const rest = words.filter((w) => !HE_SIZES[w]).map((w) => HE_UNITS[w] ?? w);
  const out = [...sizes, ...rest].join(' ');
  return hasHebrew(out) ? label.replace(/^1 /, '') : out; // unknown words: keep the original
}
