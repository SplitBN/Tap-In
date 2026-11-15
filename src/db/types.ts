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
