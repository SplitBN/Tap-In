// Exercise variants (grip / width / attachment), modelled like Alpha Progression: "Lat Pulldown · Close Grip" is its own
// Exercise (own history, e1RM, PRs, notes) that belongs to a family. A family is a base movement ("lat-pulldown"); a
// variant group is family + equipment (the cable and the machine pulldown are separate groups). The plain base exercise
// of a group has no `variant`; others are created on demand by the exercises.variant command (only a few are seeded).
//
// Pure module (no db / React; erasable TS only): imported by scripts/build-exercises.mjs, scripts/check-variants.mjs,
// the commands in src/api and the UI.

export type Width = 'close' | 'medium' | 'wide';
export type Grip = 'overhand' | 'underhand' | 'neutral' | 'mixed';
export type Attachment = 'straight-bar' | 'ez-bar' | 'bar' | 'rope' | 'v-handle' | 'single-handle';
export interface Variant { width?: Width; grip?: Grip; attachment?: Attachment }
export type Axis = keyof Variant;
export const AXES: Axis[] = ['width', 'grip', 'attachment'];

export const OPTIONS: { width: Width[]; grip: Grip[]; attachment: Attachment[] } = {
  width: ['close', 'medium', 'wide'],
  grip: ['overhand', 'underhand', 'neutral', 'mixed'],
  attachment: ['bar', 'straight-bar', 'ez-bar', 'rope', 'v-handle', 'single-handle'],
};
export const AXIS_LABEL: Record<Axis, string> = { width: 'Width', grip: 'Grip', attachment: 'Handle' };
/** Words used in composed names ("Lat Pulldown · Close Neutral"). */
export const LABEL: Record<string, string> = {
  close: 'Close', medium: 'Medium', wide: 'Wide', overhand: 'Overhand', underhand: 'Underhand', neutral: 'Neutral', mixed: 'Mixed',
  bar: 'Bar', 'straight-bar': 'Straight Bar', 'ez-bar': 'EZ Bar', rope: 'Rope', 'v-handle': 'V-Handle', 'single-handle': 'Single Handle',
};
/** Short chip labels. */
export const CHIP: Record<string, string> = { ...LABEL, 'straight-bar': 'Straight', 'ez-bar': 'EZ', 'v-handle': 'V', 'single-handle': 'Single' };
/** Other words people type for an option (search). */
export const WORDS: Record<string, string[]> = {
  close: ['close', 'narrow', 'grip'], medium: ['medium', 'shoulder width'], wide: ['wide', 'grip'],
  overhand: ['overhand', 'pronated'], underhand: ['underhand', 'reverse', 'supinated'], neutral: ['neutral', 'hammer', 'parallel'], mixed: ['mixed'],
  bar: ['bar'], 'straight-bar': ['straight bar'], 'ez-bar': ['ez bar'], rope: ['rope'], 'v-handle': ['v bar', 'vbar', 'v handle', 'v grip'],
  'single-handle': ['single handle', 'd handle'],
};

/** An attachment that fixes other axes: a V-handle is a close neutral grip, a rope a neutral one. Only applied to axes the group offers. */
const IMPLIES: Partial<Record<Attachment, Variant>> = { 'v-handle': { width: 'close', grip: 'neutral' }, rope: { grip: 'neutral' } };

export interface Group {
  axes: Axis[];
  /** what the plain base exercise is (chips start here) */
  defaults: Variant;
  /** allowed values per axis; default = all of OPTIONS */
  options?: Partial<{ width: Width[]; grip: Grip[]; attachment: Attachment[] }>;
}
export interface Family {
  /** name of the base exercise (seeded) */
  name: string;
  /** variant groups by equipment value */
  groups: Record<string, Group>;
}

const BAR_WIDTH: Group = { axes: ['width'], defaults: { width: 'medium' } };
const DB_GRIP: Group = { axes: ['grip'], defaults: { grip: 'overhand' }, options: { grip: ['overhand', 'neutral'] } };
const PRESS = { barbell: BAR_WIDTH, 'smith machine': BAR_WIDTH, dumbbell: DB_GRIP };
const PULL_UP: Group = { axes: ['width', 'grip'], defaults: { width: 'medium', grip: 'overhand' } };
const HANDLES: Group = { axes: ['width', 'grip'], defaults: { width: 'close', grip: 'neutral' }, options: { grip: ['overhand', 'underhand', 'neutral'] } };
const FLY: Group = { axes: ['width', 'grip'], defaults: { width: 'medium', grip: 'neutral' }, options: { grip: ['overhand', 'neutral'] } };

/** Which axes each family offers, per equipment. Families/equipment not listed have no variants (picker behaves as before). */
export const FAMILIES: Record<string, Family> = {
  'bench-press': { name: 'Bench Press', groups: PRESS },
  'incline-bench-press': { name: 'Incline Bench Press', groups: PRESS },
  'decline-bench-press': { name: 'Decline Bench Press', groups: PRESS },
  'chest-press': { name: 'Chest Press', groups: { machine: DB_GRIP } },
  'push-up': { name: 'Push-Up', groups: { 'body only': BAR_WIDTH } },
  'pec-deck': { name: 'Pec Deck', groups: { machine: FLY } },
  'reverse-fly': { name: 'Reverse Fly', groups: { machine: FLY } },
  'pull-up': { name: 'Pull-Up', groups: { 'body only': PULL_UP } },
  'assisted-pull-up': { name: 'Assisted Pull-Up', groups: { machine: PULL_UP, bands: PULL_UP } },
  'lat-pulldown': { name: 'Lat Pulldown', groups: {
    cable: { axes: ['width', 'grip', 'attachment'], defaults: { width: 'wide', grip: 'overhand', attachment: 'bar' },
      options: { grip: ['overhand', 'underhand', 'neutral'], attachment: ['bar', 'v-handle', 'single-handle', 'rope'] } },
    machine: { axes: ['width', 'grip'], defaults: { width: 'wide', grip: 'overhand' }, options: { grip: ['overhand', 'underhand', 'neutral'] } },
  } },
  'seated-cable-row': { name: 'Seated Cable Row', groups: {
    cable: { axes: ['width', 'grip', 'attachment'], defaults: { width: 'close', grip: 'neutral', attachment: 'v-handle' },
      options: { grip: ['overhand', 'underhand', 'neutral'], attachment: ['v-handle', 'bar', 'rope', 'single-handle'] } },
  } },
  'seated-row': { name: 'Seated Row', groups: { machine: { ...HANDLES, defaults: { width: 'medium', grip: 'neutral' } } } },
  't-bar-row': { name: 'T-Bar Row', groups: { barbell: HANDLES } },
  'chest-supported-t-bar-row': { name: 'Chest-Supported T-Bar Row', groups: { machine: HANDLES } },
  'chest-supported-row': { name: 'Chest-Supported Row', groups: { dumbbell: { axes: ['grip'], defaults: { grip: 'neutral' }, options: { grip: ['neutral', 'overhand'] } } } },
  'bent-over-row': { name: 'Bent-Over Row', groups: {
    barbell: { axes: ['grip'], defaults: { grip: 'overhand' }, options: { grip: ['overhand', 'underhand'] } },
    'smith machine': { axes: ['grip'], defaults: { grip: 'overhand' }, options: { grip: ['overhand', 'underhand'] } },
    dumbbell: DB_GRIP,
  } },
  'triceps-pushdown': { name: 'Triceps Pushdown', groups: {
    cable: { axes: ['attachment'], defaults: { attachment: 'straight-bar' }, options: { attachment: ['straight-bar', 'ez-bar', 'rope', 'v-handle', 'single-handle'] } },
  } },
  'overhead-triceps-extension': { name: 'Overhead Triceps Extension', groups: {
    cable: { axes: ['attachment'], defaults: { attachment: 'rope' }, options: { attachment: ['rope', 'straight-bar', 'ez-bar', 'single-handle'] } },
  } },
  // cable curl with a rope = the cable hammer curl (its own family), so the curl offers bars and a single handle only
  'bicep-curl': { name: 'Bicep Curl', groups: {
    cable: { axes: ['attachment'], defaults: { attachment: 'straight-bar' }, options: { attachment: ['straight-bar', 'ez-bar', 'single-handle'] } },
    barbell: BAR_WIDTH, 'e-z curl bar': BAR_WIDTH,
  } },
  'hammer-curl': { name: 'Hammer Curl', groups: { cable: { axes: ['attachment'], defaults: { attachment: 'rope' }, options: { attachment: ['rope', 'single-handle'] } } } },
};

const FAMILY_BY_NAME = new Map(Object.entries(FAMILIES).map(([slug, f]) => [f.name, slug]));
/** Family slug of a base exercise by its name + equipment, or undefined when that equipment has no variant group. */
export function familyFor(name: string, equipment: string): string | undefined {
  const slug = FAMILY_BY_NAME.get(name);
  return slug && FAMILIES[slug].groups[equipment] ? slug : undefined;
}
export function groupOf(e: { family?: string; equipment: string } | undefined): Group | undefined {
  return e?.family ? FAMILIES[e.family]?.groups[e.equipment] : undefined;
}
export const optionsOf = (g: Group, axis: Axis): string[] => (g.options?.[axis] as string[] | undefined) ?? OPTIONS[axis];
/** Key that identifies a variant group: family + equipment. */
export const groupKey = (e: { id: string; family?: string; equipment: string }) => (e.family ? `${e.family}|${e.equipment}` : e.id);

/** Does attachment `att` force a different width/grip than the ones given? */
const conflicts = (g: Group, att: string | undefined, v: Variant) => {
  const imp = att ? IMPLIES[att as Attachment] : undefined;
  return !!imp && (['width', 'grip'] as const).some((a) => g.axes.includes(a) && v[a] != null && imp[a] != null && imp[a] !== v[a]);
};
/** First attachment of the group that allows the given width/grip (e.g. Bar when a wide grip is asked of a V-handle row). */
const freeAttachment = (g: Group, v: Variant) => optionsOf(g, 'attachment').find((o) => !conflicts(g, o, v));

/** Fill defaults, apply what an attachment implies, and validate. Throws with the allowed values on a bad input.
 *  A width/grip given without a handle moves a default handle that can't take it to one that can ({ width: 'wide' } on a
 *  V-handle row → bar); a handle and a width/grip that contradict each other (V-handle + wide) are refused. */
export function normalizeVariant(g: Group, v: Variant | undefined): Required<Variant> {
  const out: Record<string, string> = {};
  for (const a of AXES) {
    const val = v?.[a];
    if (val != null && !g.axes.includes(a)) throw new Error(`This exercise has no ${a} variants (it offers: ${g.axes.join(', ') || 'none'})`);
    if (g.axes.includes(a)) out[a] = (val ?? g.defaults[a]) as string;
  }
  if (v && g.axes.includes('attachment') && conflicts(g, out.attachment, v)) {
    if (v.attachment != null) throw new Error(`${LABEL[v.attachment]} can't be used with ${(['width', 'grip'] as const).filter((a) => v[a]).map((a) => `${a} ${v[a]}`).join(' and ')}`);
    const free = freeAttachment(g, v);
    if (!free) throw new Error(`No handle here allows ${(['width', 'grip'] as const).filter((a) => v[a]).map((a) => `${a} ${v[a]}`).join(' and ')}`);
    out.attachment = free;
  }
  const imp = out.attachment ? IMPLIES[out.attachment as Attachment] : undefined;
  if (imp) for (const a of AXES) if (imp[a] && g.axes.includes(a)) out[a] = imp[a]!;
  for (const a of g.axes) {
    const allowed = optionsOf(g, a);
    if (!allowed.includes(out[a])) throw new Error(`${a} "${out[a]}" is not offered here (allowed: ${allowed.join(', ')})`);
  }
  return out as Required<Variant>;
}
/** The chip sheet's selection after tapping one chip: a width/grip the current handle can't take moves the handle to one that can. */
export function withAxis(g: Group, current: Variant, axis: Axis, value: string): Required<Variant> {
  const next = { ...current, [axis]: value } as Variant;
  if (conflicts(g, next.attachment, next)) {
    if (axis !== 'attachment') delete next.attachment; // keep the tapped width/grip, change the handle
    else { const imp = IMPLIES[value as Attachment]!; if (imp.width) delete next.width; if (imp.grip) delete next.grip; } // the handle sets them
  }
  return normalizeVariant(g, next);
}
/** Canonical comparison key of a variant within its group (base = all defaults). */
export const variantKey = (g: Group, v: Variant | undefined) => g.axes.map((a) => normalizeVariant(g, v)[a]).join('|');
/** What is stored on the record: only the values that differ from the base; undefined for the base itself. */
export function storedVariant(g: Group, v: Variant | undefined): Variant | undefined {
  const n = normalizeVariant(g, v);
  const out: Variant = {};
  for (const a of g.axes) if (n[a] !== g.defaults[a]) (out as Record<string, string>)[a] = n[a];
  return Object.keys(out).length ? out : undefined;
}

/** Short description of a variant ("Close Neutral", "Close Grip", "Rope", "Wide Grip, Single Handle"), '' for the base. */
export function variantText(g: Group, v: Variant | undefined, family?: string) {
  const s = storedVariant(g, v);
  if (!s) return '';
  const imp = s.attachment ? IMPLIES[s.attachment] : undefined;
  const shown = (a: 'width' | 'grip') => s[a] && imp?.[a] !== s[a] && !(a === 'grip' && chinUp(family, s));
  const words = (['width', 'grip'] as const).filter(shown).map((a) => LABEL[s[a]!]);
  const grip = words.length ? words.join(' ') + (words.length === 1 ? ' Grip' : '') : '';
  return [grip, s.attachment ? LABEL[s.attachment] : ''].filter(Boolean).join(', ');
}
/** Label for lists and switchers: variantText, with an underhand pull-up called a chin-up ("Chin-Up", "Chin-Up · Wide Grip"); '' for the base. */
export function variantLabel(g: Group, v: Variant | undefined, family?: string) {
  const s = storedVariant(g, v);
  const t = variantText(g, v, family);
  return s && chinUp(family, s) ? (t ? `Chin-Up · ${t}` : 'Chin-Up') : t;
}
const chinUp = (family: string | undefined, v: Variant) => (family === 'pull-up' || family === 'assisted-pull-up') && v.grip === 'underhand';

/** Readable name: "Lat Pulldown · Wide Overhand", "Bench Press · Close Grip", "Triceps Pushdown · Rope". An underhand
 *  pull-up is a chin-up ("Chin-Up · Wide Grip"). */
export function composeName(baseName: string, family: string, g: Group, v: Variant | undefined) {
  const s = storedVariant(g, v);
  const base = s && chinUp(family, s) ? baseName.replace('Pull-Up', 'Chin-Up') : baseName;
  const t = variantText(g, v, family);
  return t ? `${base} · ${t}` : base;
}

// ---------------- muscle emphasis ----------------
// Only where measured; otherwise a variant keeps the base exercise's muscles. `muscles` = prime movers (1 set each),
// `secondary` = synergists (½), same model as scripts/exercise-curation.mjs → MUSCLES.
//  - Close-grip flat bench press (barbell/smith): narrower grips raised elbow-extensor moments and triceps (lateral head),
//    anterior deltoid and clavicular pectoralis EMG in 35 strength-trained adults at 6–8 RM (Mausehund, Werkhausen,
//    Bartsch & Krosshaug 2022, J Strength Cond Res 36(10):2685–2695, PMID 33555823). The pecs stay a prime mover, so
//    triceps join chest as primary rather than replacing it.
//  - Close (narrow-base) push-up: higher pectoralis major and triceps EMG than a wide base (Cogley et al. 2005, J Strength
//    Cond Res 19(3):628–633, PMID 16095407) → chest + triceps primary.
// Not added (checked, no muscle-level difference to encode): underhand vs overhand lat pulldown — pronated gave more lat
// EMG, supination did not raise biceps EMG (Lusk, Hale & Russell 2010, J Strength Cond Res 24(7):1895–1900); biceps are
// already a synergist of every pull-down / pull-up here.
export function variantMuscles(family: string | undefined, equipment: string, v: Variant | undefined, base: { muscles: string[]; secondary: string[] }) {
  if (family === 'bench-press' && (equipment === 'barbell' || equipment === 'smith machine') && v?.width === 'close')
    return { muscles: ['chest', 'triceps'], secondary: ['shoulders'] };
  if (family === 'push-up' && v?.width === 'close') return { muscles: ['chest', 'triceps'], secondary: ['shoulders', 'abdominals'] };
  return { muscles: [...base.muscles], secondary: [...base.secondary] };
}

/** Fields of a new variant record of a group, copied from its base exercise (shared by exercises.variant and file imports). */
export interface VariantBase { name: string; mechanic: 'compound' | 'isolation'; equipment: string; loadType: 'weighted' | 'bodyweight' | 'assisted'; unilateral: boolean;
  muscles: string[]; secondary: string[]; images: string[]; instructions?: string[]; stepKg?: number; variant?: Variant }
export function variantFields(base: VariantBase, family: string, variant: Variant | undefined) {
  const g = FAMILIES[family].groups[base.equipment];
  const stored = storedVariant(g, variant);
  const m = variantMuscles(family, base.equipment, stored, base);
  return {
    name: composeName(base.variant ? FAMILIES[family].name : base.name, family, g, stored), mechanic: base.mechanic, equipment: base.equipment, loadType: base.loadType,
    unilateral: base.unilateral, muscles: m.muscles, secondary: m.secondary.filter((x) => !m.muscles.includes(x)), images: [...base.images],
    instructions: base.instructions && [...base.instructions], stepKg: base.stepKg, custom: true as const, family, variant: stored,
  };
}

/** Variant words found in a search ("close grip bench" → { width: 'close' }), for offering a not-yet-created variant. */
export function variantFromQuery(query: string): Variant {
  const q = ` ${query.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ')} `;
  const out: Variant = {};
  const has = (...w: string[]) => w.some((x) => q.includes(` ${x} `) || q.includes(` ${x}s `));
  if (has('close', 'narrow')) out.width = 'close'; else if (has('wide')) out.width = 'wide'; else if (has('medium')) out.width = 'medium';
  if (has('underhand', 'supinated', 'reverse grip', 'reverse')) out.grip = 'underhand';
  else if (has('neutral', 'parallel')) out.grip = 'neutral'; else if (has('overhand', 'pronated')) out.grip = 'overhand'; else if (has('mixed')) out.grip = 'mixed';
  if (has('rope')) out.attachment = 'rope'; else if (has('v bar', 'vbar', 'v handle', 'v grip')) out.attachment = 'v-handle';
  else if (has('single handle', 'd handle')) out.attachment = 'single-handle'; else if (has('ez bar', 'ez')) out.attachment = 'ez-bar';
  else if (has('straight bar')) out.attachment = 'straight-bar';
  return out;
}
/** The part of `v` a group can take (drops axes it doesn't offer or values it doesn't allow); undefined when nothing is left. */
export function fitVariant(g: Group, v: Variant): Variant | undefined {
  const out: Variant = {};
  for (const a of g.axes) if (v[a] && optionsOf(g, a).includes(v[a]!)) (out as Record<string, string>)[a] = v[a]!;
  return Object.keys(out).length ? out : undefined;
}
