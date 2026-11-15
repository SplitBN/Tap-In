import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { alive, db, newRecord, remove, save } from '../db/db';
import { foodToItem, frequentFor, getItem, logEntry, lookupBarcode, quickAdd, recipeNutrition, searchFoods, type FoodItem } from '../db/food';
import type { Food, FoodEntry, Ingredient, Macros, Meal, Portion } from '../db/types';
import { scale } from '../lib/nutrition';
import { MEALS, k } from '../lib/meals';
import { confirmDialog } from './Dialog';
import { Icon } from './Icon';
import { PickerRow, WheelPicker } from './Picker';
import { Sheet } from './Sheet';

const baseUnit = (it: { unitBase?: 'g' | 'ml' }) => it.unitBase ?? 'g';

/** "28C 4P 11F" in the macro colours. */
export function MacroLine({ m }: { m: Macros }) {
  return (
    <span className="macro-line num">
      <b className="mc-c">{Math.round(m.c)}C</b> <b className="mc-p">{Math.round(m.p)}P</b> <b className="mc-f">{Math.round(m.f)}F</b>
    </span>
  );
}

/* ================================================================== */
/* Add food: tabs Search · Scan · Quick · Mine                          */
/* ================================================================== */
type Tab = 'search' | 'scan' | 'quick' | 'mine';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'search', label: 'Search', icon: 'search' }, { id: 'scan', label: 'Scan', icon: 'barcode' },
  { id: 'quick', label: 'Quick', icon: 'bolt' }, { id: 'mine', label: 'Mine', icon: 'food' },
];

/** Full-screen add sheet. mode "log" writes entries; mode "pick" returns a food + grams (recipe ingredients). */
export function AddFoodSheet({ open, onClose, meal: meal0, date, initialTab = 'search', mode = 'log', onPick }: {
  open: boolean; onClose: () => void; meal: Meal; date: string; initialTab?: Tab; mode?: 'log' | 'pick';
  onPick?: (item: FoodItem, grams: number) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [meal, setMeal] = useState<Meal>(meal0);
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [picked, setPicked] = useState<{ item: FoodItem; qty?: number; unit?: string } | null>(null);
  const [results, setResults] = useState<FoodItem[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [editor, setEditor] = useState<null | { kind: 'food'; draft?: Partial<Food> } | { kind: 'recipe' }>(null);
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) { setTab(initialTab); setMeal(meal0); setQ(''); setSel([]); setResults(null); } }

  const frequent = useLiveQuery(() => (open ? frequentFor(meal) : Promise.resolve([])), [open, meal]) ?? [];
  const mine = useLiveQuery(() => db.foods.filter(alive).sortBy('name'), []) ?? [];
  const mealLabel = MEALS.find((m) => m.id === meal)!.label;

  useEffect(() => {
    let live = true;
    if (!dq.trim()) { setResults(null); return; }
    searchFoods(dq).then((r) => live && setResults(r));
    return () => { live = false; };
  }, [dq]);

  const english = !!dq.trim() && !/\p{Script=Hebrew}/u.test(dq);
  const show = (it: FoodItem) => (english && it.alt ? { ...it, name: it.alt, alt: it.name } : it);
  const close = () => onClose();

  const logSelected = async () => {
    for (const f of frequent.filter((x) => sel.includes(x.item.key))) await logEntry(f.item, f.grams, f.qty, f.unit, meal, date);
    close();
  };

  return (
    <Sheet open={open} onClose={close} full title={mode === 'pick' ? 'Add ingredient' : undefined}
      actions={mode === 'log' && sel.length ? <button className="btn primary" onClick={logSelected}><Icon name="check" size={18} stroke={2.6} /> Add {sel.length}</button> : undefined}>
      {mode === 'log' && (
        <div className="add-head">
          <MealPill meal={meal} onChange={setMeal} />
        </div>
      )}
      <div className="tabs-row" role="tablist">
        {TABS.filter((t) => mode === 'log' || t.id !== 'quick').map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={'tab-btn' + (tab === t.id ? ' on' : '')} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={22} /><span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'search' && (
        <>
          <label className="search" style={{ margin: '12px 0 4px' }}>
            <Icon name="search" size={18} />
            <input className="input" placeholder="Search foods · חיפוש" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" autoCorrect="off" aria-label="Search foods" />
          </label>
          {!results && frequent.length > 0 && <div className="section-title">Frequent {mealLabel.toLowerCase()} foods</div>}
          <div>
            {(results ?? []).map((raw) => {
              const it = show(raw);
              const p = it.portions[0];
              const g = p ? p.g : 100;
              return (
                <FoodRow key={it.key} item={it} m={scale(it.per100, g)} amount={p ? (english && /\p{Script=Hebrew}/u.test(p.label) ? `${Math.round(g)} ${baseUnit(it)}` : p.label.replace(/^1 /, '')) : `100 ${baseUnit(it)}`}
                  onOpen={() => setPicked({ item: it })} />
              );
            })}
            {!results && frequent.map((f) => (
              <FoodRow key={f.item.key} item={f.item} m={scale(f.item.per100, f.grams)}
                amount={f.unit === 'g' || f.unit === 'ml' ? `${Math.round(f.qty)} ${f.unit}` : `${+f.qty.toFixed(2)} × ${f.unit.replace(/^1 /, '')}`}
                selected={mode === 'log' ? sel.includes(f.item.key) : undefined}
                onToggle={mode === 'log' ? () => setSel(sel.includes(f.item.key) ? sel.filter((x) => x !== f.item.key) : [...sel, f.item.key]) : undefined}
                onOpen={() => setPicked({ item: f.item, qty: f.qty, unit: f.unit })} />
            ))}
            {results && !results.length && (
              <div className="empty" style={{ padding: 28 }}>
                <p style={{ margin: 0 }}>No match for “{q}”.</p>
                <button className="btn" style={{ marginTop: 12 }} onClick={() => setEditor({ kind: 'food', draft: { name: q } })}><Icon name="plus" size={16} /> Create it</button>
              </div>
            )}
            {!results && !frequent.length && <p className="empty" style={{ padding: 28 }}>Search in Hebrew or English — typos are fine.</p>}
          </div>
        </>
      )}

      {tab === 'scan' && <ScanPane active={open && tab === 'scan'}
        onFood={(f) => setPicked({ item: foodToItem(f) })} onDraft={(d) => setEditor({ kind: 'food', draft: d })} />}

      {tab === 'quick' && mode === 'log' && <QuickForm meal={meal} date={date} onDone={close} />}

      {tab === 'mine' && (
        <>
          <div className="row" style={{ margin: '12px 0' }}>
            <button className="btn grow" onClick={() => setEditor({ kind: 'food' })}><Icon name="plus" size={16} /> Food</button>
            {mode === 'log' && <button className="btn grow" onClick={() => setEditor({ kind: 'recipe' })}><Icon name="plus" size={16} /> Recipe</button>}
          </div>
          {mine.length ? mine.map((f) => {
            const it = foodToItem(f); const p = it.portions[0];
            return <FoodRow key={f.id} item={it} m={scale(it.per100, p ? p.g : 100)} amount={p ? p.label.replace(/^1 /, '') : `100 ${baseUnit(it)}`} onOpen={() => setPicked({ item: it })} />;
          }) : <p className="empty" style={{ padding: 28 }}>Your own foods, scanned products and recipes live here.</p>}
        </>
      )}

      <AmountSheet item={picked?.item ?? null} initialQty={picked?.qty} initialUnit={picked?.unit} meal={meal} date={date} mode={mode}
        onClose={() => setPicked(null)}
        onDone={(item, grams) => { if (mode === 'pick') onPick?.(item, grams); close(); }} />
      <FoodEditor open={editor?.kind === 'food'} draft={editor?.kind === 'food' ? editor.draft : undefined} onClose={() => setEditor(null)}
        onSaved={(f) => { setEditor(null); setPicked({ item: foodToItem(f) }); }} />
      <RecipeEditor open={editor?.kind === 'recipe'} onClose={() => setEditor(null)} onSaved={(f) => { setEditor(null); setPicked({ item: foodToItem(f) }); }} />
    </Sheet>
  );
}

function FoodRow({ item, m, amount, onOpen, selected, onToggle }: {
  item: FoodItem; m: Macros; amount: string; onOpen: () => void; selected?: boolean; onToggle?: () => void;
}) {
  return (
    <div className="food-row">
      <button className="food-row-main pressable" onClick={onOpen}>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="food-row-name" dir="auto">{item.name}</span>
          {(item.brand || item.alt) && <bdi className="food-row-alt">{item.brand || item.alt}</bdi>}
          <span className="food-row-sub" dir="ltr">
            {item.israeli && <span className="il-tag" aria-label="Israeli">IL</span>}
            {item.source === 'recipe' && <span className="il-tag" style={{ background: 'color-mix(in srgb, var(--c-food) 18%, transparent)', color: 'var(--c-food)' }}>R</span>}
            <MacroLine m={m} />
          </span>
        </span>
        <span className="food-row-kcal num"><b>{k(m.kcal)}</b><span>{amount}</span></span>
      </button>
      {onToggle && (
        <button className={'sel-circle' + (selected ? ' on' : '')} onClick={onToggle} aria-pressed={selected} aria-label={`Select ${item.name}`}>
          {selected && <Icon name="check" size={16} stroke={3} />}
        </button>
      )}
    </div>
  );
}

const MEAL_OPTS = MEALS.map((m) => ({ value: m.id, label: m.label }));
function MealPill({ meal, onChange }: { meal: Meal; onChange: (m: Meal) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(meal);
  const m = MEALS.find((x) => x.id === meal)!;
  return (
    <>
      <button className="meal-pill pressable" onClick={() => { setDraft(meal); setOpen(true); }} aria-label={`Meal: ${m.label}`}>
        <Icon name={m.icon} size={16} stroke={2} />{m.label}<Icon name="chevronDown" size={14} />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Meal">
        <div className="stack" style={{ gap: 14 }}>
          <WheelPicker options={MEAL_OPTS} value={draft} onChange={setDraft} ariaLabel="Meal" />
          <button className="btn primary lg block" onClick={() => { onChange(draft); setOpen(false); }}><Icon name="check" size={20} stroke={2.6} /> Done</button>
        </div>
      </Sheet>
    </>
  );
}


/** Tzameret household measures are Hebrew; when the food is shown in English, translate the common words. */
const HE_UNITS: Record<string, string> = {
  'יחידה': 'unit', 'יחידות': 'units', 'כוס': 'cup', 'כף': 'tbsp', 'כפית': 'tsp', 'פרוסה': 'slice', 'מנה': 'serving', 'קערה': 'bowl',
  'חופן': 'handful', 'קופסה': 'can', 'בקבוק': 'bottle', 'שקית': 'bag', 'חבילה': 'pack', 'גביע': 'tub', 'משולש': 'wedge', 'כדור': 'ball',
  'מגש': 'tray', 'צלחת': 'plate', 'חצי': 'half', 'רבע': 'quarter', 'מעוך': 'mashed', 'חתוך': 'chopped', 'מגורר': 'grated',
};
const HE_SIZES: Record<string, string> = { 'קטנה': 'small', 'קטן': 'small', 'בינונית': 'medium', 'בינוני': 'medium', 'גדולה': 'large', 'גדול': 'large', 'מאד': 'very', 'דקה': 'thin', 'עבה': 'thick' };
function unitLabel(label: string, english: boolean) {
  if (!english || !/\p{Script=Hebrew}/u.test(label)) return label;
  const words = label.replace(/^1 /, '').split(/\s+/);
  const sizes = words.filter((w) => HE_SIZES[w]).map((w) => HE_SIZES[w]);
  const rest = words.filter((w) => !HE_SIZES[w]).map((w) => HE_UNITS[w] ?? w);
  const out = [...sizes, ...rest].join(' ');
  return /\p{Script=Hebrew}/u.test(out) ? label.replace(/^1 /, '') : out; // unknown words: keep the original
}

/* ================================================================== */
/* Amount: big number + unit, preset chips, meal, macro pie             */
/* ================================================================== */
function AmountSheet({ item, entry, initialQty, initialUnit, meal: meal0, date, mode = 'log', onClose, onDone }: {
  item: FoodItem | null; entry?: FoodEntry; initialQty?: number; initialUnit?: string; meal: Meal; date: string; mode?: 'log' | 'pick';
  onClose: () => void; onDone?: (item: FoodItem, grams: number) => void;
}) {
  const [qty, setQty] = useState('100');
  const [unit, setUnit] = useState('g');
  const [meal, setMeal] = useState<Meal>(meal0);
  const [key, setKey] = useState<string | null>(null);
  const curKey = item ? `${item.key}:${entry?.id ?? ''}` : null;
  if (curKey !== key) {
    setKey(curKey);
    if (item) {
      const b = baseUnit(item);
      if (entry) { setUnit(entry.unit ?? b); setQty(String(+(entry.qty ?? entry.grams ?? 100).toFixed(2))); setMeal(entry.meal); }
      else if (initialQty != null) { setUnit(initialUnit ?? b); setQty(String(+initialQty.toFixed(2))); setMeal(meal0); }
      else { const p = item.portions[0]; setUnit(p ? p.label : b); setQty(p ? '1' : '100'); setMeal(meal0); }
    }
  }
  if (!item) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const b = baseUnit(item);
  const english = !/\p{Script=Hebrew}/u.test(item.name);
  const portion = item.portions.find((p) => p.label === unit);
  const n = parseFloat(qty.replace(',', '.'));
  const grams = Number.isFinite(n) && n > 0 ? (portion ? portion.g * n : n) : 0;
  const m = scale(item.per100, grams);
  const presets: { label: string; qty: string; unit: string }[] = [
    ...item.portions.map((p) => ({ label: unitLabel(p.label, english).replace(/^1 /, ''), qty: '1', unit: p.label })),
    { label: `100 ${b}`, qty: '100', unit: b },
  ];
  const go = async () => {
    if (mode === 'pick') { onDone?.(item, grams); onClose(); return; }
    await logEntry(item, grams, n, unit, meal, entry?.date ?? date, entry);
    onClose(); onDone?.(item, grams);
  };

  return (
    <Sheet open={!!item} onClose={onClose}>
      <div className="stack" style={{ gap: 16 }}>
        <div>
          <div dir="auto" className="amount-title">{item.name}</div>
          {(item.alt || item.brand) && <div className="muted" dir="auto" style={{ fontSize: '0.875rem' }}>{[item.brand, item.alt].filter(Boolean).join(' · ')}</div>}
        </div>
        <div className="amount-top">
          <div>
            <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
              <input className="amount-input num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Amount" />
              <span className="amount-unit" dir="auto">{portion ? unitLabel(portion.label, english).replace(/^1 /, '') : b}</span>
            </div>
            <div className="muted num" style={{ fontSize: '0.8125rem' }}>{portion ? `= ${Math.round(grams)} ${b}` : ' '}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="amount-kcal num">{k(m.kcal)}<span> kcal</span></div>
            <div className="muted num" style={{ fontSize: '0.875rem' }}><b className="mc-p">{Math.round(m.p)} g</b> protein</div>
          </div>
        </div>
        <div className="preset-grid">
          {presets.map((p) => (
            <button key={p.unit + p.qty} className={'preset' + (unit === p.unit && (p.unit !== b || qty === p.qty) ? ' on' : '')}
              onClick={() => { setUnit(p.unit); setQty(p.qty); }}>{p.label}</button>
          ))}
          <button className={'preset' + (unit === b ? ' on' : '')} onClick={() => { if (portion) setQty(String(Math.round(grams))); setUnit(b); }}>{b}</button>
        </div>
        {mode === 'log' && <div><MealPill meal={meal} onChange={setMeal} /></div>}
        <MacroPie m={m} />
        <button className="btn primary lg block" onClick={go} disabled={!grams}><Icon name="check" size={20} stroke={2.6} /> {mode === 'pick' ? 'Add to recipe' : entry ? 'Save' : 'Add'}</button>
        {entry && <DeleteEntry entry={entry} onDone={onClose} />}
      </div>
    </Sheet>
  );
}

/** Calorie split by macro (Atwater 4/4/9) + grams. */
export function MacroPie({ m }: { m: Macros }) {
  const parts = [
    { key: 'c', label: 'Carbs', g: m.c, kcal: m.c * 4, color: 'var(--mc-c)' },
    { key: 'p', label: 'Protein', g: m.p, kcal: m.p * 4, color: 'var(--mc-p)' },
    { key: 'f', label: 'Fat', g: m.f, kcal: m.f * 9, color: 'var(--mc-f)' },
  ];
  const total = parts.reduce((a, p) => a + p.kcal, 0) || 1;
  let acc = 0;
  const r = 15.9155; // circumference 100
  return (
    <div className="pie-row">
      <svg viewBox="0 0 42 42" width="104" height="104" aria-hidden style={{ rotate: '-90deg', flex: 'none' }}>
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--card-2)" strokeWidth="9" />
        {parts.map((p) => {
          const pct = (p.kcal / total) * 100;
          const el = <circle key={p.key} cx="21" cy="21" r={r} fill="none" stroke={p.color} strokeWidth="9" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={-acc} />;
          acc += pct;
          return el;
        })}
      </svg>
      <div className="grow stack" style={{ gap: 6 }}>
        {parts.map((p) => (
          <div key={p.key} className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ color: p.color, fontWeight: 700 }}>{p.label}</span>
            <span className="num"><b>{Math.round(p.g)} g</b> <span className="muted">{Math.round((p.kcal / total) * 100)}%</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DeleteEntry({ entry, onDone }: { entry: FoodEntry; onDone: () => void }) {
  return <button className="btn danger block" onClick={async () => { await remove('entries', entry.id); onDone(); }}><Icon name="trash" size={18} /> Delete</button>;
}

/* ================================================================== */
/* Edit a logged entry                                                  */
/* ================================================================== */
export function EntrySheet({ entry, onClose }: { entry: FoodEntry | null; onClose: () => void }) {
  const item = useLiveQuery(async () => (entry?.foodId ? (await getItem(entry.foodId)) ?? null : null), [entry?.foodId]);
  if (entry?.source === 'quick') return <QuickEditSheet entry={entry} onClose={onClose} />;
  const fallback: FoodItem | null = entry && entry.grams ? {
    key: entry.foodId ?? entry.id, source: 'custom', name: entry.name, brand: entry.brand, portions: [], per100: scale(entry.n, 10000 / entry.grams),
  } : null;
  const it = entry ? (item ? { ...item, name: entry.name } : fallback) : null;
  return <AmountSheet item={it} entry={entry ?? undefined} meal={entry?.meal ?? 'snacks'} date={entry?.date ?? ''} onClose={onClose} />;
}

/* ================================================================== */
/* Quick add: a name + macros (estimates, restaurant meals)             */
/* ================================================================== */
function QuickForm({ meal, date, entry, onDone }: { meal: Meal; date: string; entry?: FoodEntry; onDone: () => void }) {
  const [v, setV] = useState(() => entry
    ? { name: entry.name, kcal: String(Math.round(entry.n.kcal)), p: entry.n.p ? String(entry.n.p) : '', c: entry.n.c ? String(entry.n.c) : '', f: entry.n.f ? String(entry.n.f) : '' }
    : { name: '', kcal: '', p: '', c: '', f: '' });
  const num = (s: string) => Math.max(0, parseFloat(s.replace(',', '.')) || 0);
  const p = num(v.p), c = num(v.c), f = num(v.f);
  const fromMacros = Math.round(p * 4 + c * 4 + f * 9); // Atwater general factors
  const kcal = v.kcal ? num(v.kcal) : fromMacros;
  const go = async () => { await quickAdd({ kcal, p, c, f, fiber: 0 }, v.name.trim(), entry?.meal ?? meal, entry?.date ?? date, entry); onDone(); };
  const field = (key: keyof typeof v, label: string, cls: string, ph?: string) => (
    <label className="field"><span className={cls}>{label}</span>
      <input className="input num" inputMode="decimal" value={v[key]} placeholder={ph ?? '0'} onChange={(e) => setV({ ...v, [key]: e.target.value })} />
    </label>
  );
  return (
    <div className="stack" style={{ gap: 12, marginTop: 12 }}>
      <label className="field"><span>Name</span><input className="input" dir="auto" value={v.name} placeholder="Shawarma in pita (estimate)" onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
      <div className="grid-4">{field('p', 'Protein', 'mc-p')}{field('c', 'Carbs', 'mc-c')}{field('f', 'Fat', 'mc-f')}{field('kcal', 'kcal', '', fromMacros ? String(fromMacros) : '0')}</div>
      <p className="faint" style={{ margin: 0, fontSize: '0.75rem' }}>Leave kcal empty to calculate it from the macros (4 / 4 / 9 kcal per gram).</p>
      <button className="btn primary lg block" onClick={go} disabled={!kcal}><Icon name="check" size={20} stroke={2.6} /> {entry ? 'Save' : `Add · ${k(kcal)} kcal`}</button>
    </div>
  );
}

function QuickEditSheet({ entry, onClose }: { entry: FoodEntry; onClose: () => void }) {
  return (
    <Sheet open onClose={onClose} title="Quick add">
      <QuickForm meal={entry.meal} date={entry.date} entry={entry} onDone={onClose} />
      <div style={{ marginTop: 10 }}><DeleteEntry entry={entry} onDone={onClose} /></div>
    </Sheet>
  );
}

/* ================================================================== */
/* Your own food: g or ml, several units (serving, bar, scoop…)          */
/* ================================================================== */
export function FoodEditor({ open, onClose, onSaved, draft, food }: {
  open: boolean; onClose: () => void; onSaved?: (f: Food) => void; draft?: Partial<Food>; food?: Food;
}) {
  const src = food ?? draft;
  type Row = { label: string; g: string };
  const [v, setV] = useState({ name: '', brand: '', barcode: '', base: 'g' as 'g' | 'ml', basis: '100' as '100' | number, kcal: '', p: '', c: '', f: '' });
  const [units, setUnits] = useState<Row[]>([]);
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      const pr = src?.per100;
      setV({ name: src?.name ?? '', brand: src?.brand ?? '', barcode: src?.barcode ?? '', base: src?.unitBase ?? 'g', basis: '100',
        kcal: pr?.kcal != null ? String(pr.kcal) : '', p: pr?.p != null ? String(pr.p) : '', c: pr?.c != null ? String(pr.c) : '', f: pr?.f != null ? String(pr.f) : '' });
      setUnits((src?.portions ?? []).map((p) => ({ label: p.label.replace(/^1 /, ''), g: String(p.g) })));
    }
  }
  const num = (s: string) => parseFloat(s.replace(',', '.'));
  const portions: Portion[] = units.filter((u) => u.label.trim() && num(u.g) > 0).map((u) => ({ label: `1 ${u.label.trim()}`, g: num(u.g) }));
  const basisG = v.basis === '100' ? 100 : portions[v.basis]?.g ?? 100;
  const factor = 100 / basisG;
  const per100: Macros = { kcal: num(v.kcal) * factor, p: (num(v.p) || 0) * factor, c: (num(v.c) || 0) * factor, f: (num(v.f) || 0) * factor, fiber: src?.per100?.fiber ?? 0 };
  const valid = v.name.trim() && Number.isFinite(per100.kcal);
  const basisOptions = [{ value: '100' as '100' | number, label: `100 ${v.base}` }, ...portions.map((p, i) => ({ value: i as '100' | number, label: `${p.label} (${p.g} ${v.base})` }))];
  const go = async () => {
    const r = (x: number) => Math.round(x * 10) / 10;
    const base = food ?? newRecord({ source: 'custom' as const, name: '', per100, portions });
    const saved = await save('foods', {
      ...base, source: base.source === 'off' ? 'off' : 'custom', name: v.name.trim(), brand: v.brand.trim() || undefined,
      barcode: v.barcode.trim() || undefined, unitBase: v.base, portions,
      per100: { kcal: r(per100.kcal), p: r(per100.p), c: r(per100.c), f: r(per100.f), fiber: r(per100.fiber ?? 0) },
    } as Food);
    onSaved?.(saved); onClose();
  };
  const field = (key: 'name' | 'brand' | 'barcode' | 'kcal' | 'p' | 'c' | 'f', label: string, decimal = true, ph?: string, cls = '') => (
    <label className="field"><span className={cls}>{label}</span>
      <input className={'input' + (decimal ? ' num' : '')} inputMode={decimal ? 'decimal' : 'text'} dir={decimal ? undefined : 'auto'} value={v[key]} placeholder={ph} onChange={(e) => setV({ ...v, [key]: e.target.value })} />
    </label>
  );
  if (food?.source === 'recipe') return <RecipeEditor open={open} recipe={food} onClose={onClose} onSaved={onSaved} />;
  return (
    <Sheet open={open} onClose={onClose} title={food ? 'Edit food' : draft?.barcode ? 'New product' : 'New food'}>
      <div className="stack" style={{ gap: 12 }}>
        {draft?.barcode && !food && <p className="muted" style={{ margin: 0, fontSize: '0.875rem' }}><Icon name="barcode" size={14} /> {draft.barcode} — fill it in once; it's saved for the next scan.</p>}
        {field('name', 'Name', false, 'Protein bar, chocolate')}
        <div className="grid-2">{field('brand', 'Brand', false)}{field('barcode', 'Barcode')}</div>
        <div className="field"><span>Measured in</span>
          <div className="seg">{(['g', 'ml'] as const).map((b) => <button key={b} aria-pressed={v.base === b} onClick={() => setV({ ...v, base: b })}>{b === 'g' ? 'Grams' : 'Millilitres'}</button>)}</div>
        </div>
        <div className="field"><span>Units</span>
          <div className="stack" style={{ gap: 8 }}>
            {units.map((u, i) => (
              <div key={i} className="row">
                <input className="input grow" dir="auto" placeholder="bar, scoop, cup" value={u.label} aria-label="Unit name"
                  onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input className="input num" style={{ width: 90, textAlign: 'center' }} inputMode="decimal" placeholder={v.base} value={u.g} aria-label={`${v.base} per unit`}
                  onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, g: e.target.value } : x)))} />
                <span className="faint">{v.base}</span>
                <button className="icon-btn sm" aria-label="Remove unit" onClick={() => { setUnits(units.filter((_, j) => j !== i)); if (v.basis === i) setV({ ...v, basis: '100' }); }}><Icon name="close" size={16} /></button>
              </div>
            ))}
            <button className="btn" onClick={() => setUnits([...units, { label: '', g: '' }])}><Icon name="plus" size={16} /> Unit</button>
          </div>
        </div>
        <PickerRowInline label="Nutrition per" options={basisOptions} value={v.basis} onChange={(basis) => setV({ ...v, basis })} />
        <div className="grid-4">{field('kcal', 'kcal')}{field('p', 'Protein', true, '', 'mc-p')}{field('c', 'Carbs', true, '', 'mc-c')}{field('f', 'Fat', true, '', 'mc-f')}</div>
        <button className="btn primary lg block" onClick={go} disabled={!valid}><Icon name="check" size={20} stroke={2.6} /> Save</button>
        {food && <button className="btn danger block" onClick={async () => {
          if (!(await confirmDialog({ title: `Delete “${food.name}”?`, message: 'Past log entries keep their numbers.', confirm: 'Delete food', danger: true }))) return;
          await remove('foods', food.id); onClose();
        }}><Icon name="trash" size={18} /> Delete</button>}
      </div>
    </Sheet>
  );
}

function PickerRowInline<T>(p: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return <div className="list" style={{ background: 'var(--card-2)' }}><PickerRow {...p} /></div>;
}

/* ================================================================== */
/* Recipe: a list of foods; nutrition per serving is derived            */
/* ================================================================== */
export function RecipeEditor({ open, onClose, onSaved, recipe }: { open: boolean; onClose: () => void; onSaved?: (f: Food) => void; recipe?: Food }) {
  const [name, setName] = useState('');
  const [servings, setServings] = useState(1);
  const [cooked, setCooked] = useState('');
  const [items, setItems] = useState<Ingredient[]>([]);
  const [adding, setAdding] = useState(false);
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) { setName(recipe?.name ?? ''); setServings(recipe?.servings ?? 1); setCooked(recipe?.cookedG ? String(recipe.cookedG) : ''); setItems(recipe?.ingredients ?? []); }
  }
  const cookedG = parseFloat(cooked) || null;
  const r = recipeNutrition(items, servings, cookedG);
  const perServing = scale(r.per100, r.servingG);
  const go = async () => {
    const rd = (x: number) => Math.round(x * 10) / 10;
    const fields = {
      source: 'recipe' as const, name: name.trim(), unitBase: 'g' as const, ingredients: items, servings, cookedG,
      per100: { kcal: rd(r.per100.kcal), p: rd(r.per100.p), c: rd(r.per100.c), f: rd(r.per100.f), fiber: rd(r.per100.fiber ?? 0) },
      portions: [{ label: '1 serving', g: Math.round(r.servingG * 10) / 10 }],
    };
    const saved = await save('foods', recipe ? { ...recipe, ...fields } : newRecord(fields) as Food);
    onSaved?.(saved); onClose();
  };
  const SERV = Array.from({ length: 24 }, (_, i) => ({ value: i + 1, label: `${i + 1} serving${i ? 's' : ''}` }));
  return (
    <Sheet open={open} onClose={onClose} title={recipe ? 'Edit recipe' : 'New recipe'} full>
      <div className="stack" style={{ gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" dir="auto" value={name} placeholder="Overnight oats" onChange={(e) => setName(e.target.value)} /></label>
        <div className="list" style={{ background: 'var(--card-2)' }}>
          <PickerRow label="Makes" options={SERV} value={servings} onChange={setServings} title="Servings" />
        </div>
        <div className="section-title" style={{ margin: '8px 4px 0' }}>Ingredients</div>
        <div className="list" style={{ background: 'var(--card-2)' }}>
          {items.map((it, i) => (
            <div key={i} className="list-item">
              <span className="grow" style={{ minWidth: 0 }}><span className="title ellipsis" dir="auto" style={{ display: 'block' }}>{it.name}</span>
                <span className="sub"><MacroLine m={scale(it.per100, it.grams)} /> · {k(scale(it.per100, it.grams).kcal)} kcal</span></span>
              <input className="input num" style={{ width: 76, textAlign: 'center', minHeight: 40 }} inputMode="decimal" value={it.grams} aria-label={`${it.name} grams`}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, grams: parseFloat(e.target.value) || 0 } : x)))} />
              <span className="faint">g</span>
              <button className="icon-btn sm" aria-label={`Remove ${it.name}`} onClick={() => setItems(items.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>
            </div>
          ))}
          <button className="list-item pressable" onClick={() => setAdding(true)} style={{ color: 'var(--accent)' }}><Icon name="plus" size={18} /><span className="title">Ingredient</span></button>
        </div>
        <label className="field"><span>Cooked weight (optional)</span>
          <input className="input num" inputMode="decimal" value={cooked} placeholder={`${Math.round(r.weight)} g raw`} onChange={(e) => setCooked(e.target.value)} />
        </label>
        <div className="card" style={{ background: 'var(--card-2)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontWeight: 650 }}>Per serving · {Math.round(r.servingG)} g</span>
            <span className="num" style={{ fontWeight: 800, fontSize: '1.25rem' }}>{k(perServing.kcal)} kcal</span>
          </div>
          <MacroLine m={perServing} />
        </div>
        <button className="btn primary lg block" onClick={go} disabled={!name.trim() || !items.length}><Icon name="check" size={20} stroke={2.6} /> Save recipe</button>
        {recipe && <button className="btn danger block" onClick={async () => {
          if (!(await confirmDialog({ title: `Delete “${recipe.name}”?`, message: 'Past log entries keep their numbers.', confirm: 'Delete recipe', danger: true }))) return;
          await remove('foods', recipe.id); onClose();
        }}><Icon name="trash" size={18} /> Delete</button>}
      </div>
      <AddFoodSheet open={adding} onClose={() => setAdding(false)} meal="lunch" date="" mode="pick"
        onPick={(it, grams) => setItems([...items, { foodKey: it.key, name: it.name, grams: Math.round(grams * 10) / 10, per100: it.per100 }])} />
    </Sheet>
  );
}

/* ================================================================== */
/* Barcode scanner (camera) + manual entry                              */
/* ================================================================== */
function ScanPane({ active, onFood, onDraft }: { active: boolean; onFood: (f: Food) => void; onDraft: (d: Partial<Food>) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'starting' | 'scanning' | 'looking' | 'denied' | 'offline'>('starting');
  const [manual, setManual] = useState('');
  const busy = useRef(false);

  const handle = useMemo(() => async (code: string) => {
    if (busy.current) return;
    busy.current = true; setState('looking');
    const r = await lookupBarcode(code);
    busy.current = false;
    if (r.food) onFood(r.food);
    else if (r.status === 'offline' && !r.draft?.name) setState('offline'); // offline but a known Israeli product → prefill
    else onDraft(r.draft ?? { barcode: code });
  }, [onFood, onDraft]);

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null; let stop = false; let timer = 0;
    setState('starting'); busy.current = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop) return;
        const v = video.current!; v.srcObject = stream; await v.play();
        setState('scanning');
        const { BarcodeDetector } = await import('barcode-detector/ponyfill');
        const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        const tick = async () => {
          if (stop) return;
          try { const found = await det.detect(v); if (found[0]?.rawValue) { handle(found[0].rawValue); return; } } catch { /* frame not ready */ }
          timer = window.setTimeout(tick, 180);
        };
        tick();
      } catch { setState('denied'); }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [active, handle]);

  return (
    <div className="stack" style={{ gap: 12, marginTop: 12 }}>
      <div className="scan-box">
        <video ref={video} playsInline muted aria-label="Camera preview" />
        <div className="scan-frame" aria-hidden />
        {state !== 'scanning' && (
          <div className="scan-state">
            {state === 'starting' && 'Starting camera…'}
            {state === 'looking' && 'Looking up…'}
            {state === 'denied' && 'Camera unavailable. Type the number below.'}
            {state === 'offline' && 'No connection. Try again or type it in.'}
          </div>
        )}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) handle(manual.trim()); }}>
        <input className="input num grow" inputMode="numeric" placeholder="7290004127329" aria-label="Barcode number" value={manual} onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))} />
        <button className="btn primary" disabled={manual.length < 8} aria-label="Look up barcode"><Icon name="search" size={18} /></button>
      </form>
      <p className="faint" style={{ margin: 0, fontSize: '0.75rem', textAlign: 'center' }}>Israeli products are built in; others come from Open Food Facts (only the barcode is sent).</p>
    </div>
  );
}

/** Your own, scanned and recipe foods (Goals page list). */
export function useMyFoods() {
  return useLiveQuery(() => db.foods.filter(alive).sortBy('name'), []) ?? [];
}
