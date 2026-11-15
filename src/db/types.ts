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
  notes?: string;
}

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
    checkins: boolean;
    progressPhotos: boolean;
    restTimer: boolean;
    effort: boolean;
    warmups: boolean;
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
export type FoodSource = 'usda' | 'off' | 'custom' | 'quick';
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

/** A food the user created or scanned (USDA foods live in the bundled JSON, not here). */
export interface Food extends Base {
  source: Exclude<FoodSource, 'usda' | 'quick'>;
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
  kcal: number;
  proteinG: number;
  carbsG?: number | null;
  fatG?: number | null;
}
