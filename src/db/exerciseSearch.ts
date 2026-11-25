import { db } from './db';
import type { Exercise } from './types';
import { rank, tokenize } from '../lib/search';
import { equipmentLabel } from '../lib/equipment';
import { FAMILIES, groupOf, variantFromQuery, WORDS, type Variant } from '../lib/variants';

/** The standard version of each big lift (by id, so it survives renames), nudged above other variants until your own usage takes over. */
export const STAPLES = new Set([
  'Barbell_Bench_Press_-_Medium_Grip', 'Barbell_Squat', 'Barbell_Deadlift', 'Pullups', 'Chin-Up', 'Dips_-_Triceps_Version', 'Standing_Military_Press',
  'Bent_Over_Barbell_Row', 'Romanian_Deadlift', 'Barbell_Hip_Thrust', 'Leg_Press', 'Wide-Grip_Lat_Pulldown', 'Seated_Cable_Rows', 'Dumbbell_Bench_Press',
  'Incline_Dumbbell_Press', 'Dumbbell_Shoulder_Press', 'Side_Lateral_Raise', 'Barbell_Curl', 'Dumbbell_Bicep_Curl', 'Hammer_Curls', 'Triceps_Pushdown',
  'Leg_Extensions', 'Lying_Leg_Curls', 'Seated_Leg_Curl', 'Standing_Calf_Raises', 'Pushups', 'Barbell_Incline_Bench_Press_-_Medium_Grip',
  'Front_Barbell_Squat', 'Dumbbell_Lunges', 'Plank', 'Cable_Crossover', 'Sumo_Deadlift', 'Close-Grip_Barbell_Bench_Press', 'Machine_Bench_Press',
].map((id) => 'fedb:' + id));

/** Breaks ties between same-named variants (Bench Press barbell vs dumbbell vs smith …): free weights first. */
const EQUIPMENT_BIAS: Record<string, number> = { barbell: 0, dumbbell: 0.02, machine: 0.04, cable: 0.04, 'body only': 0.04, 'smith machine': 0.06 };

/** Other words people use for a movement, so either name finds every equipment variant ("ohp" → Shoulder Press · Dumbbell). */
/** Other names people search by, keyed by exact exercise name (all equipment variants share them):
 *  alternative English names, gym slang, and the Hebrew terms used in Israeli gyms. Matched like the name itself. */
const ALIASES: Record<string, string[]> = {
  'Bench Press': ['flat bench', 'chest press', 'לחיצת חזה', 'בנץ׳'],
  'Incline Bench Press': ['incline press', 'לחיצת חזה עליון', 'שיפוע חיובי'],
  'Decline Bench Press': ['decline press', 'שיפוע שלילי'],
  'Close-Grip Bench Press': ['cgbp', 'narrow bench', 'לחיצה צרה'],
  'Chest Press': ['machine press', 'לחיצת חזה'],
  'Chest Fly': ['flye', 'flies', 'flys', 'פרפר'],
  'Incline Chest Fly': ['incline flye', 'incline flys', 'פרפר עליון'],
  'Pec Deck': ['butterfly', 'butterfly flies', 'butterfly flys', 'flys', 'flies', 'fly machine', 'chest fly', 'machine fly', 'machine flys', 'פרפר', 'פרפר במכונה'],
  'Cable Crossover': ['cable fly', 'crossovers', 'קרוס אובר'],
  'Squat': ['back squat', 'סקוואט', 'כריעה'],
  'Front Squat': ['סקוואט קדמי'],
  'Goblet Squat': ['גובלט'],
  'Bulgarian Split Squat': ['split squat', 'בולגרי'],
  'Hack Squat': ['האק'],
  'Leg Press': ['לחיצת רגליים'],
  'Lunge': ['lunges', 'מכרע', 'לאנג׳'],
  'Walking Lunge': ['walking lunges', 'מכרע בהליכה'],
  'Deadlift': ['conventional deadlift', 'dl', 'דדליפט', 'מתה'],
  'Romanian Deadlift': ['stiff leg', 'rdl', 'דדליפט רומני'],
  'Sumo Deadlift': ['דדליפט סומו'],
  'Trap Bar Deadlift': ['hex bar', 'hex bar deadlift'],
  'Hip Thrust': ['glute bridge', 'היפ תראסט', 'גשר'],
  'Good Morning': ['גוד מורנינג'],
  'Pull-Up': ['pullups', 'pull up', 'מתח'],
  'Chin-Up': ['chinups', 'chin up', 'מתח אחיזה הפוכה'],
  'Neutral-Grip Pull-Up': ['hammer pull-up', 'מתח אחיזה ניטרלית'],
  'Assisted Pull-Up': ['assisted chin', 'מתח בעזרה'],
  'Lat Pulldown': ['pulldown', 'lat pull', 'פולי עליון', 'משיכה לחזה'],
  'Close-Grip Lat Pulldown': ['v-bar pulldown', 'פולי עליון צר'],
  'Straight-Arm Pulldown': ['straight arm pushdown', 'pullover cable'],
  'Bent-Over Row': ['barbell row', 'bb row', 'חתירה'],
  'One-Arm Row': ['single arm row', 'db row', 'חתירה ביד אחת'],
  'Seated Cable Row': ['cable row', 'low row', 'פולי תחתון', 'חתירה בישיבה'],
  'Seated Row': ['machine row', 'חתירה במכונה'],
  'T-Bar Row': ['t bar', 'landmine row', 'חתירת טי'],
  'Chest-Supported Row': ['incline row', 'seal row'],
  'Face Pull': ['face pulls', 'פייס פול'],
  'Overhead Press': ['ohp', 'military press', 'standing press', 'shoulder press', 'לחיצת כתפיים'],
  'Shoulder Press': ['overhead press', 'ohp', 'לחיצת כתפיים'],
  'Seated Overhead Press': ['seated shoulder press', 'לחיצת כתפיים בישיבה'],
  'Arnold Press': ['ארנולד'],
  'Lateral Raise': ['side raise', 'side lateral', 'laterals', 'הרחקה', 'הרחקת כתפיים'],
  'Front Raise': ['הרמה קדמית'],
  'Reverse Fly': ['rear delt fly', 'rear fly', 'פרפר הפוך'],
  'Upright Row': ['חתירה אנכית'],
  'Shrug': ['shrugs', 'traps', 'משיכת כתפיים'],
  'Bicep Curl': ['curl', 'כפיפת מרפקים', 'יד קדמית'],
  'Hammer Curl': ['hammer curls', 'כפיפת פטישים', 'פטישים'],
  'Preacher Curl': ['scott curl', 'כפיפה בכומר'],
  'Concentration Curl': ['כפיפת ריכוז'],
  'Triceps Pushdown': ['pushdown', 'rope pushdown', 'tricep pushdown', 'פשיטת מרפקים', 'יד אחורית'],
  'Skull Crusher': ['lying triceps extension', 'french press', 'skullcrusher', 'לחיצה צרפתית'],
  'Overhead Triceps Extension': ['overhead extension', 'french press', 'פשיטה מעל הראש'],
  'Triceps Kickback': ['kickback', 'בעיטה אחורית'],
  'Dip': ['dips', 'מקבילים'],
  'Chest Dip': ['dips', 'מקבילים לחזה'],
  'Bench Dip': ['bench dips', 'מקבילים על ספסל'],
  'Assisted Dip': ['מקבילים בעזרה'],
  'Push-Up': ['pushups', 'press up', 'שכיבות סמיכה'],
  'Leg Extension': ['quad extension', 'פשיטת ברכיים'],
  'Lying Leg Curl': ['hamstring curl', 'leg curl', 'כפיפת ברכיים'],
  'Seated Leg Curl': ['hamstring curl', 'leg curl', 'כפיפת ברכיים בישיבה'],
  'Standing Leg Curl': ['hamstring curl', 'כפיפת ברכיים בעמידה'],
  'Calf Raise': ['calves', 'standing calf raise', 'תאומים'],
  'Seated Calf Raise': ['calves', 'תאומים בישיבה'],
  'Hip Abduction': ['abductor', 'outer thigh', 'הרחקת ירכיים'],
  'Hip Adduction': ['adductor', 'inner thigh', 'קירוב ירכיים'],
  'Glute Kickback': ['donkey kick', 'בעיטת ישבן'],
  'Back Extension': ['hyperextension', 'hyper', 'פשיטת גב'],
  'Crunch': ['crunches', 'abs', 'בטן', 'כפיפות בטן'],
  'Hanging Leg Raise': ['leg raise', 'הרמת רגליים בתלייה'],
  'Plank': ['פלאנק'],
  'Ab Wheel Rollout': ['ab roller', 'ab wheel', 'גלגל בטן'],
  'Kettlebell Swing': ['kb swing', 'סווינג'],
  "Farmer's Walk": ['farmers carry', 'farmer carry', 'הליכת חקלאי'],
};

/** Aliases of the exercise's own name plus its family's base name, so "Lat Pulldown · Close Grip" keeps "pulldown", "פולי עליון", … */
const aliasesOf = (e: Exercise) => {
  const base = e.family ? FAMILIES[e.family]?.name : undefined;
  return [...(ALIASES[e.name] ?? []), ...(base && base !== e.name ? ALIASES[base] ?? [] : [])];
};
/** A variant's option words ("narrow", "v bar", "supinated"), placed right after the name so "close grip bench" ranks the
 *  close-grip variant first. Bases get none: a query naming a variant that doesn't exist yet ("wide pulldown") still finds
 *  the base through the ranker's one-missing-word allowance, and the picker then offers that variant. */
const variantWords = (e: Exercise) => (e.variant && groupOf(e) ? Object.values(e.variant).flatMap((v) => WORDS[v as string] ?? []) : []);
const cache = new WeakMap<Exercise, string[]>();
export const exerciseTokens = (e: Exercise) => {
  let t = cache.get(e);
  if (!t) { t = tokenize(`${e.name} ${variantWords(e).join(' ')} ${e.equipment} ${equipmentLabel(e.equipment)} ${e.muscles.join(' ')} ${aliasesOf(e).join(' ')}`); cache.set(e, t); }
  return t;
};

export type Usage = Map<string, { n: number; last: number }>;

/** Sessions each exercise was done in (completed sets) and when last — your staples float up. */
export async function exerciseUsage(): Promise<Usage> {
  const m = new Map<string, { n: number; last: number; sessions: Set<string> }>();
  await db.sets.each((s) => {
    if (!s.doneAt || s.deletedAt) return;
    const u = m.get(s.exerciseId) ?? { n: 0, last: 0, sessions: new Set<string>() };
    if (!u.sessions.has(s.sessionId)) { u.sessions.add(s.sessionId); u.n++; }
    u.last = Math.max(u.last, s.doneAt); m.set(s.exerciseId, u);
  });
  return m;
}

/** Shared ranking for the picker and the command API: match quality, then usage, staples, custom. */
export function searchExercises(pool: Exercise[], query: string, usage?: Usage, limit = 150) {
  // a search that IS one of an exercise's other names ranks it like a name match (aliases sit late in the token list)
  const q = tokenize(query).join(' ');
  const aliasBonus = (e: Exercise) => {
    let b = 0;
    for (const a of aliasesOf(e)) { const t = tokenize(a).join(' '); if (t === q) return -1.5; if (q.length >= 3 && t.startsWith(q) && t[q.length] !== ' ') b = -0.6; } // mid-word only: "press" ≠ "press up"
    return b;
  };
  // a variant whose grip / width / handle is exactly what the query names ("rope pushdown") beats its base
  const want = variantFromQuery(query);
  const wantKeys = Object.keys(want) as (keyof Variant)[];
  const variantBonus = (e: Exercise) => {
    const axes = e.variant ? groupOf(e)?.axes.filter((k) => wantKeys.includes(k)) ?? [] : [];
    return axes.length && axes.every((k) => e.variant![k] === want[k]) ? -1.5 : 0;
  };
  return rank(pool, query, {
    tokensOf: exerciseTokens, keyOf: (e) => e.id, nameLength: (e) => e.name.length, usage, limit,
    bias: (e) => (e.custom ? -0.5 : 0) + (STAPLES.has(e.id) ? -1.2 : 0) + (EQUIPMENT_BIAS[e.equipment] ?? 0.08) + aliasBonus(e) + variantBonus(e),
  });
}
