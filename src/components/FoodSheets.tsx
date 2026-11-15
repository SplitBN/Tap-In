import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { alive, db, newRecord, remove, save } from '../db/db';
import { getItem, logEntry, lookupBarcode, quickAdd, recentItems, searchFoods, type FoodItem } from '../db/food';
import type { Food, FoodEntry, Macros, Meal } from '../db/types';
import { scale } from '../lib/nutrition';
import { MEALS, k } from '../pages/Food';
import { confirmDialog } from './Dialog';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/* ------------------------------------------------------------------ */
/* Add food: search + recents + scan + quick add + new food             */
/* ------------------------------------------------------------------ */
export function AddFoodSheet({ open, onClose, meal, date }: { open: boolean; onClose: () => void; meal: Meal; date: string }) {
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [picked, setPicked] = useState<FoodItem | null>(null);
  const [mode, setMode] = useState<null | 'quick' | 'new' | 'scan'>(null);
  const [draft, setDraft] = useState<Partial<Food> | undefined>();
  const [results, setResults] = useState<FoodItem[] | null>(null);
  const recents = useLiveQuery(() => (open ? recentItems() : Promise.resolve([])), [open]) ?? [];
  const mealLabel = MEALS.find((m) => m.id === meal)!.label;

  useEffect(() => {
    let live = true;
    if (!dq.trim()) { setResults(null); return; }
    searchFoods(dq).then((r) => live && setResults(r));
    return () => { live = false; };
  }, [dq]);

  const close = () => { setQ(''); setResults(null); onClose(); };
  const list = results ?? recents;
  // an English search shows English names first (Hebrew underneath), and logs them that way
  const english = !!dq.trim() && !/\p{Script=Hebrew}/u.test(dq);

  return (
    <Sheet open={open} onClose={close} title={mealLabel} full>
      <div className="stack" style={{ position: 'sticky', top: -4, background: 'var(--bg-raised)', paddingBottom: 10, zIndex: 1, gap: 10 }}>
        <div className="row">
          <label className="search grow">
            <Icon name="search" size={18} />
            <input className="input" placeholder="Search foods · חיפוש" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" autoCorrect="off" aria-label="Search foods" />
          </label>
          <button className="icon-btn filled" aria-label="Scan barcode" onClick={() => setMode('scan')}><Icon name="barcode" /></button>
        </div>
        <div className="chips">
          <button className="chip" onClick={() => setMode('quick')}><Icon name="bolt" size={14} /> Quick add</button>
          <button className="chip" onClick={() => { setDraft(q ? { name: q } : undefined); setMode('new'); }}><Icon name="plus" size={14} /> New food</button>
        </div>
      </div>
      {!results && recents.length > 0 && <div className="section-title" style={{ marginTop: 6 }}>Recent</div>}
      <div>
        {list.map((it) => (
          <button key={it.key} className="list-item pressable" style={{ paddingLeft: 4, paddingRight: 4 }} onClick={() => setPicked(english && it.alt ? { ...it, name: it.alt, alt: it.name } : it)}>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="title" dir="auto" style={{ display: 'block' }}>{english && it.alt ? it.alt : it.name}</span>
              <span className="sub" dir="auto">
                {it.israeli && <span className="il-tag" aria-label="Israeli">IL</span>}
                {[it.brand, english && it.alt ? it.name : it.alt, it.source === 'usda' ? it.category : it.source === 'moh' ? 'Tzameret' : it.israeli ? null : it.source === 'off' ? 'scanned' : 'mine'].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="num muted" style={{ fontSize: '0.8125rem', textAlign: 'right', flex: 'none' }}><b style={{ color: 'var(--text)', fontSize: '0.9375rem' }}>{k(it.per100.kcal)}</b><br />/100 g</span>
          </button>
        ))}
        {results && !results.length && (
          <div className="empty" style={{ padding: 28 }}>
            <p style={{ margin: 0 }}>No match for “{q}”.</p>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => { setDraft({ name: q }); setMode('new'); }}><Icon name="plus" size={16} /> Create it</button>
          </div>
        )}
        {!results && !recents.length && <p className="empty" style={{ padding: 28 }}>Search in Hebrew or English — Israeli foods and products first — or scan a barcode.</p>}
      </div>

      <AmountSheet item={picked} meal={meal} date={date} onClose={() => setPicked(null)} onDone={close} />
      <QuickAddSheet open={mode === 'quick'} meal={meal} date={date} onClose={() => setMode(null)} onDone={close} />
      <FoodEditor open={mode === 'new'} draft={draft} onClose={() => setMode(null)}
        onSaved={(f) => { setMode(null); setPicked({ key: f.id, source: f.source, name: f.name, brand: f.brand, per100: f.per100, portions: f.portions }); }} />
      <ScanSheet open={mode === 'scan'} onClose={() => setMode(null)}
        onFood={(f) => { setMode(null); setPicked({ key: f.id, source: f.source, name: f.name, brand: f.brand, per100: f.per100, portions: f.portions }); }}
        onDraft={(d) => { setDraft(d); setMode('new'); }} />
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Amount: grams or a portion, live macros, meal                        */
/* ------------------------------------------------------------------ */
function AmountSheet({ item, meal: meal0, date, onClose, onDone, entry }: {
  item: FoodItem | null; meal: Meal; date: string; onClose: () => void; onDone?: () => void; entry?: FoodEntry;
}) {
  const [qty, setQty] = useState('100');
  const [unit, setUnit] = useState('g');
  const [meal, setMeal] = useState<Meal>(meal0);
  const [key, setKey] = useState<string | null>(null);
  if ((item?.key ?? null) !== key) {
    setKey(item?.key ?? null);
    if (item) {
      if (entry) { setUnit(entry.unit ?? 'g'); setQty(String(entry.qty ?? entry.grams ?? 100)); setMeal(entry.meal); }
      else { const p = item.portions[0]; setUnit(p ? p.label : 'g'); setQty(p ? '1' : '100'); setMeal(meal0); }
    }
  }
  if (!item) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const portion = item.portions.find((p) => p.label === unit);
  const n = parseFloat(qty.replace(',', '.'));
  const grams = Number.isFinite(n) && n > 0 ? (portion ? portion.g * n : n) : 0;
  const m = scale(item.per100, grams);
  const go = async () => { await logEntry(item, grams, n, unit, meal, entry?.date ?? date, entry); onClose(); onDone?.(); };

  return (
    <Sheet open={!!item} onClose={onClose} title={entry ? 'Edit' : 'Add'}>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <div dir="auto" style={{ fontWeight: 700, fontSize: '1.125rem', lineHeight: 1.25 }}>{item.name}</div>
          {item.alt && <div className="muted" style={{ fontSize: '0.875rem' }}>{item.alt}</div>}
          {item.brand && <div className="muted" style={{ fontSize: '0.875rem' }}>{item.brand}</div>}
        </div>
        <MacroTiles m={m} />
        <div className="row">
          <input className="input num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} onFocus={(e) => e.target.select()}
            aria-label="Amount" style={{ width: 96, textAlign: 'center', borderRadius: 999, fontSize: '1.25rem', fontWeight: 750 }} />
          <div className="chips grow">
            {item.portions.map((p) => <button key={p.label} className="chip" aria-pressed={unit === p.label} onClick={() => { setUnit(p.label); if (unit === 'g') setQty('1'); }}>{p.label.replace(/^1 /, '')} <span className="faint">{Math.round(p.g)}g</span></button>)}
            <button className="chip" aria-pressed={unit === 'g'} onClick={() => { if (portion) setQty(String(Math.round(grams))); setUnit('g'); }}>g</button>
          </div>
        </div>
        <MealPicker value={meal} onChange={setMeal} />
        <button className="btn primary lg block" onClick={go} disabled={!grams}><Icon name="check" size={20} stroke={2.6} /> {entry ? 'Save' : `Add · ${k(m.kcal)} kcal`}</button>
        {entry && <DeleteEntry entry={entry} onDone={onClose} />}
      </div>
    </Sheet>
  );
}

export function MacroTiles({ m }: { m: Macros }) {
  return (
    <div className="macro-tiles">
      <div><b className="num">{k(m.kcal)}</b><span>kcal</span></div>
      <div style={{ color: 'var(--c-food)' }}><b className="num">{Math.round(m.p)}</b><span>protein</span></div>
      <div style={{ color: '#64d2ff' }}><b className="num">{Math.round(m.c)}</b><span>carbs</span></div>
      <div style={{ color: '#ffd60a' }}><b className="num">{Math.round(m.f)}</b><span>fat</span></div>
    </div>
  );
}

function MealPicker({ value, onChange }: { value: Meal; onChange: (m: Meal) => void }) {
  return (
    <div className="seg" role="group" aria-label="Meal">
      {MEALS.map((m) => (
        <button key={m.id} aria-pressed={value === m.id} onClick={() => onChange(m.id)} aria-label={m.label} title={m.label}>
          <Icon name={m.icon} size={18} />
        </button>
      ))}
    </div>
  );
}

function DeleteEntry({ entry, onDone }: { entry: FoodEntry; onDone: () => void }) {
  return (
    <button className="btn danger block" onClick={async () => { await remove('entries', entry.id); onDone(); }}>
      <Icon name="trash" size={18} /> Delete
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Edit a logged entry                                                  */
/* ------------------------------------------------------------------ */
export function EntrySheet({ entry, onClose }: { entry: FoodEntry | null; onClose: () => void }) {
  const item = useLiveQuery(async () => (entry?.foodId ? (await getItem(entry.foodId)) ?? null : null), [entry?.foodId]);
  if (entry?.source === 'quick') return <QuickAddSheet open entry={entry} meal={entry.meal} date={entry.date} onClose={onClose} />;
  // food deleted since? fall back to the snapshot (per-100 g derived from it)
  const fallback: FoodItem | null = entry && entry.grams ? {
    key: entry.foodId ?? entry.id, source: 'custom', name: entry.name, brand: entry.brand, portions: [],
    per100: scale(entry.n, 10000 / entry.grams),
  } : null;
  return <AmountSheet item={entry ? item ?? fallback : null} entry={entry ?? undefined} meal={entry?.meal ?? 'snacks'} date={entry?.date ?? ''} onClose={onClose} />;
}

/* ------------------------------------------------------------------ */
/* Quick add                                                            */
/* ------------------------------------------------------------------ */
function QuickAddSheet({ open, onClose, onDone, meal: meal0, date, entry }: {
  open: boolean; onClose: () => void; onDone?: () => void; meal: Meal; date: string; entry?: FoodEntry;
}) {
  const [v, setV] = useState({ name: '', kcal: '', p: '', c: '', f: '' });
  const [meal, setMeal] = useState<Meal>(meal0);
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setMeal(entry?.meal ?? meal0);
      setV(entry ? { name: entry.name, kcal: String(Math.round(entry.n.kcal)), p: String(entry.n.p || ''), c: String(entry.n.c || ''), f: String(entry.n.f || '') } : { name: '', kcal: '', p: '', c: '', f: '' });
    }
  }
  const num = (s: string) => Math.max(0, parseFloat(s.replace(',', '.')) || 0);
  const p = num(v.p), c = num(v.c), f = num(v.f);
  const fromMacros = Math.round(p * 4 + c * 4 + f * 9); // Atwater general factors: 4/4/9 kcal per g
  const kcal = v.kcal ? num(v.kcal) : fromMacros;
  const go = async () => { await quickAdd({ kcal, p, c, f, fiber: 0 }, v.name.trim(), meal, entry?.date ?? date, entry); onClose(); onDone?.(); };
  const field = (key: keyof typeof v, label: string, ph?: string) => (
    <label className="field"><span>{label}</span>
      <input className="input num" inputMode="decimal" value={v[key]} placeholder={ph} onChange={(e) => setV({ ...v, [key]: e.target.value })} />
    </label>
  );
  return (
    <Sheet open={open} onClose={onClose} title={entry ? 'Edit quick add' : 'Quick add'}>
      <div className="stack" style={{ gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" value={v.name} placeholder="Restaurant burger" onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
        <div className="grid-4">{field('p', 'Protein g')}{field('c', 'Carbs g')}{field('f', 'Fat g')}{field('kcal', 'kcal', fromMacros ? String(fromMacros) : '')}</div>
        <MealPicker value={meal} onChange={setMeal} />
        <button className="btn primary lg block" onClick={go} disabled={!kcal}><Icon name="check" size={20} stroke={2.6} /> {entry ? 'Save' : `Add · ${k(kcal)} kcal`}</button>
        {entry && <DeleteEntry entry={entry} onDone={onClose} />}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Create / edit your own food (also used to fix scanned products)      */
/* ------------------------------------------------------------------ */
export function FoodEditor({ open, onClose, onSaved, draft, food }: {
  open: boolean; onClose: () => void; onSaved?: (f: Food) => void; draft?: Partial<Food>; food?: Food;
}) {
  const src = food ?? draft;
  const [v, setV] = useState({ name: '', brand: '', barcode: '', basis: 'serving' as '100' | 'serving', servingG: '', servingLabel: '', kcal: '', p: '', c: '', f: '' });
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      const pr = src?.per100; const s = src?.portions?.[0];
      setV({
        name: src?.name ?? '', brand: src?.brand ?? '', barcode: src?.barcode ?? '', basis: pr ? '100' : 'serving',
        servingG: s ? String(s.g) : '', servingLabel: s ? s.label.replace(/^1 /, '') : '',
        kcal: pr?.kcal != null ? String(pr.kcal) : '', p: pr?.p != null ? String(pr.p) : '', c: pr?.c != null ? String(pr.c) : '', f: pr?.f != null ? String(pr.f) : '',
      });
    }
  }
  const num = (s: string) => parseFloat(s.replace(',', '.'));
  const sg = num(v.servingG);
  const factor = v.basis === '100' ? 1 : sg > 0 ? 100 / sg : NaN;
  const per100: Macros = { kcal: num(v.kcal) * factor, p: (num(v.p) || 0) * factor, c: (num(v.c) || 0) * factor, f: (num(v.f) || 0) * factor, fiber: src?.per100?.fiber ?? 0 };
  const valid = v.name.trim() && Number.isFinite(per100.kcal);
  const go = async () => {
    const portions = sg > 0 ? [{ label: `1 ${v.servingLabel.trim() || 'serving'}`, g: sg }] : [];
    const base = food ?? newRecord({ source: 'custom' as const, name: '', per100, portions });
    const r = (x: number) => Math.round(x * 10) / 10;
    const saved = await save('foods', {
      ...base, source: base.source === 'off' ? 'off' : 'custom', name: v.name.trim(), brand: v.brand.trim() || undefined,
      barcode: v.barcode.trim() || undefined, portions,
      per100: { kcal: r(per100.kcal), p: r(per100.p), c: r(per100.c), f: r(per100.f), fiber: r(per100.fiber ?? 0) },
    } as Food);
    onSaved?.(saved); onClose();
  };
  const field = (key: keyof typeof v, label: string, mode: 'decimal' | 'text' = 'decimal', ph?: string) => (
    <label className="field"><span>{label}</span>
      <input className={'input' + (mode === 'decimal' ? ' num' : '')} inputMode={mode} value={v[key] as string} placeholder={ph} onChange={(e) => setV({ ...v, [key]: e.target.value })} />
    </label>
  );
  return (
    <Sheet open={open} onClose={onClose} title={food ? 'Edit food' : draft?.barcode ? 'New product' : 'New food'}>
      <div className="stack" style={{ gap: 12 }}>
        {draft?.barcode && !food && <p className="muted" style={{ margin: 0, fontSize: '0.875rem' }}><Icon name="barcode" size={14} /> {draft.barcode} — not found or incomplete. Fill it in once, it's saved for next time.</p>}
        {field('name', 'Name', 'text', 'Greek yogurt 2%')}
        <div className="grid-2">{field('brand', 'Brand', 'text')}{field('barcode', 'Barcode', 'decimal')}</div>
        <div className="grid-2">{field('servingLabel', 'Serving name', 'text', 'cup, bar, scoop')}{field('servingG', 'Serving g')}</div>
        <div className="seg" role="group" aria-label="Values are per">
          <button aria-pressed={v.basis === 'serving'} onClick={() => setV({ ...v, basis: 'serving' })} disabled={!(sg > 0)}>Per serving</button>
          <button aria-pressed={v.basis === '100'} onClick={() => setV({ ...v, basis: '100' })}>Per 100 g</button>
        </div>
        <div className="grid-4">{field('kcal', 'kcal')}{field('p', 'Protein')}{field('c', 'Carbs')}{field('f', 'Fat')}</div>
        <button className="btn primary lg block" onClick={go} disabled={!valid}><Icon name="check" size={20} stroke={2.6} /> Save</button>
        {food && <button className="btn danger block" onClick={async () => {
          if (!(await confirmDialog({ title: `Delete “${food.name}”?`, message: 'Past log entries keep their numbers.', confirm: 'Delete food', danger: true }))) return;
          await remove('foods', food.id); onClose();
        }}><Icon name="trash" size={18} /> Delete</button>}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Barcode scanner (camera) + manual entry                              */
/* ------------------------------------------------------------------ */
function ScanSheet({ open, onClose, onFood, onDraft }: { open: boolean; onClose: () => void; onFood: (f: Food) => void; onDraft: (d: Partial<Food>) => void }) {
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
    if (!open) return;
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
  }, [open, handle]);

  return (
    <Sheet open={open} onClose={onClose} title="Scan barcode">
      <div className="stack" style={{ gap: 12 }}>
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
          <input className="input num grow" inputMode="numeric" placeholder="5000159484695" aria-label="Barcode number" value={manual} onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))} />
          <button className="btn primary" disabled={manual.length < 8}><Icon name="search" size={18} /></button>
        </form>
        <p className="faint" style={{ margin: 0, fontSize: '0.75rem', textAlign: 'center' }}>Product data: Open Food Facts (open database). Only the barcode is sent.</p>
      </div>
    </Sheet>
  );
}

/** Your own and scanned foods, for the nutrition settings page. */
export function useMyFoods() {
  return useLiveQuery(() => db.foods.filter(alive).sortBy('name'), []) ?? [];
}
