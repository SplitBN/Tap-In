// Exercise variant checks (runs before every build; Node strips the TS types): name composition, normalisation,
// the seeded family mapping in src/data/exercises.json and the variant-word parser used by the picker.
import { readFileSync } from 'node:fs';
import { composeName, FAMILIES, fitVariant, groupKey, groupOf, normalizeVariant, storedVariant, variantFromQuery, variantKey, variantMuscles, withAxis } from '../src/lib/variants.ts';

const list = JSON.parse(readFileSync(new URL('../src/data/exercises.json', import.meta.url), 'utf8'));
const fails = [];
const check = (name, ok, detail = '') => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ''}`); };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const G = (fam, eqp) => FAMILIES[fam].groups[eqp];
const name = (fam, eqp, v) => composeName(FAMILIES[fam].name, fam, G(fam, eqp), v);

// ---- names ----
eq('bench close', name('bench-press', 'barbell', { width: 'close' }), 'Bench Press · Close Grip');
eq('pulldown base', name('lat-pulldown', 'cable', { width: 'wide', grip: 'overhand' }), 'Lat Pulldown');
eq('pulldown close neutral', name('lat-pulldown', 'cable', { width: 'close', grip: 'neutral' }), 'Lat Pulldown · Close Neutral');
eq('pulldown medium underhand', name('lat-pulldown', 'cable', { width: 'medium', grip: 'underhand' }), 'Lat Pulldown · Medium Underhand');
eq('pulldown v-handle implies close neutral', name('lat-pulldown', 'cable', { attachment: 'v-handle' }), 'Lat Pulldown · V-Handle');
eq('pushdown rope', name('triceps-pushdown', 'cable', { attachment: 'rope' }), 'Triceps Pushdown · Rope');
eq('chin-up wide', name('pull-up', 'body only', { width: 'wide', grip: 'underhand' }), 'Chin-Up · Wide Grip');
eq('pull-up wide neutral', name('pull-up', 'body only', { width: 'wide', grip: 'neutral' }), 'Pull-Up · Wide Neutral');
eq('row wide overhand bar', name('seated-cable-row', 'cable', { width: 'wide', grip: 'overhand', attachment: 'bar' }), 'Seated Cable Row · Wide Overhand, Bar');
eq('pec deck wide', name('pec-deck', 'machine', { width: 'wide' }), 'Pec Deck · Wide Grip');

// ---- normalisation ----
eq('v-handle normalises', normalizeVariant(G('lat-pulldown', 'cable'), { attachment: 'v-handle' }), { width: 'close', grip: 'neutral', attachment: 'v-handle' });
eq('base stores nothing', storedVariant(G('bench-press', 'barbell'), { width: 'medium' }), undefined);
check('same key for implied', variantKey(G('lat-pulldown', 'cable'), { attachment: 'v-handle' }) === variantKey(G('lat-pulldown', 'cable'), { width: 'close', grip: 'neutral', attachment: 'v-handle' }));
eq('row wide alone moves the handle', normalizeVariant(G('seated-cable-row', 'cable'), { width: 'wide' }), { width: 'wide', grip: 'neutral', attachment: 'bar' });
eq('row wide name', name('seated-cable-row', 'cable', { width: 'wide' }), 'Seated Cable Row · Wide Grip, Bar');
check('row wide is not the base', variantKey(G('seated-cable-row', 'cable'), { width: 'wide' }) !== variantKey(G('seated-cable-row', 'cable'), undefined));
check('row overhand gets a bar', normalizeVariant(G('seated-cable-row', 'cable'), { grip: 'overhand' }).attachment === 'bar');
eq('chip: wide on a V-handle selection', withAxis(G('seated-cable-row', 'cable'), { width: 'close', grip: 'neutral', attachment: 'v-handle' }, 'width', 'wide'), { width: 'wide', grip: 'neutral', attachment: 'bar' });
eq('chip: overhand on a rope pulldown', withAxis(G('lat-pulldown', 'cable'), { width: 'wide', grip: 'neutral', attachment: 'rope' }, 'grip', 'overhand'), { width: 'wide', grip: 'overhand', attachment: 'bar' });
eq('chip: V sets close neutral', withAxis(G('lat-pulldown', 'cable'), { width: 'wide', grip: 'overhand', attachment: 'bar' }, 'attachment', 'v-handle'), { width: 'close', grip: 'neutral', attachment: 'v-handle' });
let threw = false;
try { normalizeVariant(G('lat-pulldown', 'cable'), { attachment: 'v-handle', width: 'wide' }); } catch { threw = true; }
check('explicit V-handle + wide is refused', threw);
threw = false; try { normalizeVariant(G('triceps-pushdown', 'cable'), { width: 'wide' }); } catch { threw = true; }
check('axis not offered is refused', threw);
threw = false; try { normalizeVariant(G('bench-press', 'dumbbell'), { grip: 'underhand' }); } catch { threw = true; }
check('option not offered is refused', threw);

// ---- muscles ----
eq('close bench muscles', variantMuscles('bench-press', 'barbell', { width: 'close' }, { muscles: ['chest'], secondary: ['shoulders', 'triceps'] }), { muscles: ['chest', 'triceps'], secondary: ['shoulders'] });
eq('dumbbell bench keeps base', variantMuscles('bench-press', 'dumbbell', { grip: 'neutral' }, { muscles: ['chest'], secondary: ['shoulders', 'triceps'] }), { muscles: ['chest'], secondary: ['shoulders', 'triceps'] });

// ---- query words ----
eq('query close grip bench', variantFromQuery('close grip bench'), { width: 'close' });
eq('query rope pushdown', variantFromQuery('rope pushdown'), { attachment: 'rope' });
eq('query wide pulldown', variantFromQuery('wide pulldown'), { width: 'wide' });
eq('query plain', variantFromQuery('bench press'), {});
eq('fit drops unknown axes', fitVariant(G('triceps-pushdown', 'cable'), { width: 'close', attachment: 'rope' }), { attachment: 'rope' });

// ---- seeded data ----
const byName = (n, e) => list.find((x) => x.name === n && x.equipment === e);
const seeded = [
  ['Close-Grip Bench Press', 'barbell', 'bench-press', { width: 'close' }], ['Close-Grip Bench Press', 'smith machine', 'bench-press', { width: 'close' }],
  ['Chin-Up', 'body only', 'pull-up', { grip: 'underhand' }], ['Neutral-Grip Pull-Up', 'body only', 'pull-up', { grip: 'neutral' }],
  ['Reverse-Grip Lat Pulldown', 'cable', 'lat-pulldown', { grip: 'underhand' }],
  ['Close-Grip Lat Pulldown', 'cable', 'lat-pulldown', { width: 'close', grip: 'neutral', attachment: 'v-handle' }],
  ['Close-Grip Push-Up', 'body only', 'push-up', { width: 'close' }],
  ['Bench Press', 'barbell', 'bench-press', undefined], ['Lat Pulldown', 'cable', 'lat-pulldown', undefined], ['Pull-Up', 'body only', 'pull-up', undefined],
];
for (const [n, e, fam, v] of seeded) {
  const x = byName(n, e);
  check(`seeded ${n} / ${e} exists`, !!x);
  if (x) { eq(`seeded ${n} / ${e} family`, x.family, fam); eq(`seeded ${n} / ${e} variant`, x.variant, v); }
}
const groups = new Map();
for (const e of list) if (e.family) groups.set(groupKey(e), [...(groups.get(groupKey(e)) ?? []), e]);
for (const [k, members] of groups) {
  check(`group ${k} has a variant group`, !!groupOf(members[0]));
  check(`group ${k} has one base`, members.filter((m) => !m.variant).length === 1);
}

if (fails.length) { console.error('check-variants failed:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log(`check-variants: ok (${groups.size} variant groups)`);
