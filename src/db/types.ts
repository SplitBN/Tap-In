// Domain types. Every synced record extends Base (client UUID, timestamps, soft delete).
// Weights are always stored in kg; `inputUnit` remembers what the user typed.

export interface Base {
  id: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export type Unit = 'kg' | 'lb';
export type Mechanic = 'compound' | 'isolation';
/** weighted: load is the external weight.
 *  bodyweight: load is ADDED weight on top of bodyweight (0 = bodyweight only).
 *  assisted: load is assistance subtracted from bodyweight. */
export type LoadType = 'weighted' | 'bodyweight' | 'assisted';
export type EffortMode = 'rir' | 'rpe';

export interface Exercise extends Base {
  name: string;
  mechanic: Mechanic;
  equipment: string;
  muscles: string[];
  secondary: string[];
  loadType: LoadType;
  unilateral: boolean;
  images: string[];
  instructions?: string[];
  custom?: boolean;
  /** Preferred step on the weight wheel, kg. */
  stepKg?: number;
}

export interface RestSetting {
  mode: 'timer' | 'countup';
  sec?: number; // undefined = default from mechanic
}

/** One exercise slot in a workout (plan) or session (live copy). */
export interface WorkoutItem {
  key: string;
  exerciseId: string;
  sets: number;
  repsMin?: number;
  repsMax?: number;
  rest: RestSetting;
  supersetId?: string;
  drops?: number; // drop steps after each working set
  warmups?: number;
  notes?: string;
  /** Session only: this exercise was replaced mid-workout by the slot with this key. The slot stays to hold its done
   *  sets (history keeps them as this exercise) but is never copied back to the plan. */
  replacedBy?: string;
}

export interface Plan extends Base {
  name: string;
  workoutIds: string[]; // ordered rotation, not tied to weekdays
}

export interface Workout extends Base {
  planId: string;
  name: string;
  items: WorkoutItem[];
}

export interface Session extends Base {
  workoutId?: string;
  planId?: string;
  name: string;
  startedAt: number;
  endedAt?: number | null;
  items: WorkoutItem[]; // editable copy of the workout structure
  currentKey?: string;
  notes?: string; // free text; the post-workout survey's note writes here too
  // Post-workout survey (all optional, raw answers; see sessions.rate)
  sessionRpe?: number | null; // session RPE, CR-10 0–10 (Foster et al. 2001) — not the per-set RIR-based RPE
  sleep?: SurveySleep | null; // last night's sleep
  soreness?: SurveyBody | null; // how the body felt going in
  ratedAt?: number | null; // when the survey was last answered (sRPE is meant to be given ~30 min after)
}
export type SurveySleep = 'bad' | 'ok' | 'good';
export type SurveyBody = 'fresh' | 'normal' | 'beat';

export type SetKind = 'warmup' | 'working' | 'drop';
export type Side = 'both' | 'left' | 'right';

export interface SetLog extends Base {
  sessionId: string;
  itemKey: string;
  exerciseId: string;
  setNo: number; // 1-based within kind (warm-ups numbered separately)
  kind: SetKind;
  dropNo?: number; // 1.. for drop steps
  side: Side;
  loadKg?: number | null; // meaning depends on loadType (see LoadType)
  loadType: LoadType;
  bodyweightKg?: number | null; // snapshot at log time
  inputUnit: Unit;
  reps?: number | null;
  rir?: number | null;
  rpe?: number | null;
  effortInput?: EffortMode;
  doneAt?: number | null;
}

export interface BodyweightEntry extends Base {
  at: number;
  kg: number;
  note?: string;
}

export interface Settings {
  id: 'settings';
  unit: Unit;
  effortMode: EffortMode;
  activePlanId?: string;
  restCompoundSec: number;
  restIsolationSec: number;
  weighInEveryDays: number;
  features: {
    gym: boolean;
    food: boolean;
    supplements: boolean;
    survey: boolean; // post-workout survey on the summary screen
    restTimer: boolean;
    effort: boolean;
    warmups: boolean;
    progression?: boolean; // progression targets (greyed "today" numbers) instead of last time's; undefined = on
  };
}

export interface OutboxEntry {
  seq?: number;
  table: string;
  recordId: string;
  at: number;
}

// ---------------- Food ----------------
/** Nutrition per 100 g (foods) or per entry (snapshots). kcal + grams of macros. */
export interface Macros { kcal: number; p: number; c: number; f: number; fiber?: number }
export interface Portion { label: string; g: number }
export type FoodSource = 'usda' | 'moh' | 'off' | 'custom' | 'recipe' | 'quick';
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

export interface Ingredient { foodKey: string; name: string; grams: number; per100: Macros }

/** A food the user created, scanned, or a recipe (bundled databases live in JSON, not here). */
export interface Food extends Base {
  source: Exclude<FoodSource, 'usda' | 'moh' | 'quick'>;
  /** per100 is per 100 g, or per 100 ml for liquids */
  unitBase?: 'g' | 'ml';
  /** recipes: the ingredients and how many servings the whole batch makes (per100 is derived) */
  ingredients?: Ingredient[];
  servings?: number;
  cookedG?: number | null; // weight after cooking, if weighed (water loss/gain)
  name: string;
  brand?: string;
  barcode?: string;
  per100: Macros;
  portions: Portion[];
}

/** One logged item. Stores a nutrition snapshot so later food edits never rewrite history. */
export interface FoodEntry extends Base {
  date: string; // local YYYY-MM-DD
  at: number;
  meal: Meal;
  source: FoodSource;
  foodId?: string; // 'usda:<fdcId>' or a Food id; absent for quick add
  name: string;
  brand?: string;
  grams?: number | null; // absent for quick add
  qty?: number; // amount in the chosen unit
  unit?: string; // 'g' or a portion label
  n: Macros; // totals for this entry
}

/** Marks a day as fully logged — only complete days feed adaptive maintenance. */
export interface DayStatus extends Base { complete: boolean } // id = YYYY-MM-DD

export type Sex = 'male' | 'female';
export type Activity = 'sedentary' | 'light' | 'active' | 'very';

/** Nutrition targets, versioned by date so history keeps the goal that applied then. */
export interface NutritionGoal extends Base {
  effectiveFrom: string; // YYYY-MM-DD
  sex: Sex;
  birthYear: number;
  heightCm: number;
  activity: Activity;
  rateKgPerWeek: number; // negative = lose
  maintenanceKcal: number; // estimate or user override
  maintenanceSource: 'formula' | 'manual' | 'adaptive';
  kcal: number | null; // optional: track without a calorie target
  proteinG: number | null; // optional
  carbsG?: number | null;
  fatG?: number | null;
}

// ---------------- Supplements & medications ----------------
export type SuppForm = 'capsule' | 'tablet' | 'powder' | 'liquid' | 'injection' | 'other';
export type SuppRoute = 'oral' | 'subq' | 'im' | 'other';
export type SchedKind = 'daily' | 'weekdays' | 'interval' | 'weekly' | 'asNeeded';

/** How often something is taken. Times are local "HH:MM". */
export interface Schedule {
  kind: SchedKind;
  days?: number[]; // weekdays 0=Sun..6=Sat (kind 'weekdays')
  every?: number; // every N days (kind 'interval')
  times: string[]; // empty for asNeeded
  startDate: string; // YYYY-MM-DD; 'weekly' repeats on this weekday, 'interval' counts from it
  cycle?: { onDays: number; offDays: number } | null; // e.g. 5 on / 2 off, counted from startDate
}

/** A dose that applies from a date on — kept as history so titration (2 mg → 4 mg …) is never overwritten. */
export interface DoseStep { from: string; amount: number }

export interface Supplement extends Base {
  name: string;
  form: SuppForm;
  route: SuppRoute;
  unit: string; // mg, mcg, g, IU, ml, units, caps, …
  doses: DoseStep[];
  schedule: Schedule;
  stock?: number | null; // remaining amount in `unit` or count, optional
  notes?: string;
  archived?: boolean;
}

/** Items taken together (e.g. "Morning stack"): due members at the same time are checked off in one tap. */
export interface Stack extends Base {
  name: string;
  supplementIds: string[];
}

export interface SuppLog extends Base {
  supplementId: string;
  date: string; // the day it was scheduled for (or taken, for as-needed)
  slot: string | null; // scheduled "HH:MM", null for as-needed
  takenAt: number | null;
  status: 'taken' | 'skipped';
  amount: number;
  unit: string;
  site?: string | null; // injection site
}

/** Timestamped journal entry: side effects, how you feel, anything worth correlating later. */
export interface Note extends Base {
  at: number;
  text: string;
  tags: string[]; // e.g. supplement ids, 'side-effect'
}
