import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router';
import { AddFoodSheet, EntrySheet, MacroLine, RecipeEditor } from '../components/FoodSheets';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { daysComplete } from '../api/food';
import { run } from '../api/registry';
import { alive, db } from '../db/db';
import { goalFor } from '../db/food';
import type { FoodEntry, Macros, Meal, NutritionGoal } from '../db/types';
import { keyToDate, shiftDate, sum } from '../lib/nutrition';
import { MEALS, mealNow, k } from '../lib/meals';
import { hasHebrew, unitLabel } from '../lib/units';
import { useToday } from '../lib/today';

export { MEALS, mealNow, k } from '../lib/meals';

export function useDay(date: string) {
  const entries = useLiveQuery(() => db.entries.where('date').equals(date).filter(alive).sortBy('at'), [date]) ?? [];
  // undefined = loading, null = no goals set yet
  const goal = useLiveQuery(async () => (await goalFor(date)) ?? null, [date]);
  const status = useLiveQuery(() => db.days.get(date), [date]);
  return { entries, goal, status, total: sum(entries.map((e) => e.n)) };
}


type Tab = 'search' | 'scan' | 'quick' | 'mine';

export function FoodPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const today = useToday();
  const date = params.get('d') ?? today;
  const setDate = (d: string) => setParams(d === today ? {} : { d }, { replace: true });
  const { entries, goal, status, total } = useDay(date);
  const [adding, setAdding] = useState<{ meal: Meal; tab: Tab } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [recipe, setRecipe] = useState(false);
  const [editing, setEditing] = useState<FoodEntry | null>(null);
  const byMeal = (m: Meal) => entries.filter((e) => e.meal === m);

  const label = date === today ? 'Today' : date === shiftDate(today, -1) ? 'Yesterday'
    : keyToDate(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const shell = document.querySelector('.shell');

  return (
    <div className="page" data-role="food">
      <header className="page-head">
        <h1>Food</h1>
        <button className="icon-btn" aria-label="Goals" onClick={() => nav('/nutrition')}><Icon name="target" /></button>
      </header>

      <div className="date-pill">
        <button className="icon-btn sm" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))}><Icon name="chevronLeft" size={18} /></button>
        <button className="date-pill-label" onClick={() => setDate(today)} aria-label={date === today ? 'Today' : `${label}. Go to today`}><Icon name="calendar" size={16} />{label}</button>
        <button className="icon-btn sm" aria-label="Next day" onClick={() => setDate(shiftDate(date, 1))} disabled={date >= today}><Icon name="chevronRight" size={18} /></button>
      </div>

      {goal === undefined ? null : !goal && !entries.length ? (
        <button className="card pressable row setup-cta" onClick={() => nav('/nutrition')}>
          <span className="role-chip" style={{ width: 44, height: 44, borderRadius: 14 }}><Icon name="target" size={22} stroke={2} /></span>
          <span className="grow"><b className="t-17">Set up your goals</b><br /><span className="muted t-15">7 quick questions, or just start logging</span></span>
          <Icon name="chevronRight" className="chev" size={18} />
        </button>
      ) : null}

      <Dashboard total={total} goal={goal ?? null} meals={MEALS.map((m) => ({ ...m, kcal: sum(byMeal(m.id).map((e) => e.n)).kcal }))}
        onMeal={(m) => document.getElementById(`meal-${m}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />

      <div className="stack" style={{ gap: 12, marginTop: 12 }}>
        {MEALS.map((m) => {
          const list = byMeal(m.id);
          const mt = sum(list.map((e) => e.n));
          return (
            <section key={m.id} id={`meal-${m.id}`} className="card meal-card" style={{ scrollMarginTop: 'calc(var(--safe-t) + 12px)' }}>
              <div className="row" style={{ minHeight: 40 }}>
                <span className="role-chip"><Icon name={m.icon} size={16} stroke={2} /></span>
                <span className="grow">
                  <h2 className="w-7 t-17" style={{ margin: 0 }}>{m.label}</h2>
                  {list.length > 0 && <span className="food-row-sub"><MacroLine m={mt} /></span>}
                </span>
                {mt.kcal > 0 && <span className="num" style={{ fontWeight: 750 }}>{k(mt.kcal)}<span className="sr-only"> kcal</span></span>}
                <button className="round-btn sm-round" aria-label={`Add to ${m.label}`} onClick={() => setAdding({ meal: m.id, tab: 'search' })}><Icon name="plus" size={18} stroke={2.4} /></button>
              </div>
              {list.length > 0 && (
                <div className="entry-list">
                  {list.map((e) => (
                    <button key={e.id} className="entry-row pressable" onClick={() => setEditing(e)}>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="ellipsis bidi-start" dir="auto" style={{ display: 'block', fontWeight: 560 }}>{e.name}</span>
                        <span className="food-row-sub">{e.source === 'quick' ? <><Icon name="bolt" size={11} /> Quick add · </> : `${fmtQty(e)} · `}<MacroLine m={e.n} /></span>
                      </span>
                      <span className="num" style={{ fontWeight: 750, flex: 'none' }}>{k(e.n.kcal)}<span className="sr-only"> kcal</span></span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <label className="card row" style={{ marginTop: 12, cursor: 'pointer' }}>
        <span className="grow"><b style={{ fontWeight: 650 }}>Day fully logged</b><br /><span className="muted t-13">Only full days count toward your maintenance estimate</span></span>
        <span className="switch"><input type="checkbox" checked={!!status?.complete}
          onChange={(e) => run(daysComplete, { date, complete: e.target.checked })} /><span /></span>
      </label>

      {/* floating + (lives in the app frame, above the tab bar) */}
      {shell && createPortal(
        <button className="fab" aria-label="Log food" onClick={() => setShortcuts(true)}><Icon name="plus" size={28} stroke={2.4} /></button>, shell)}

      <Sheet open={shortcuts} onClose={() => setShortcuts(false)} title="Log">
        <div className="shortcut-grid">
          {/* one food-green tint: per-shortcut colours collided with the macro colours (yellow = fat, purple = protein) */}
          <Shortcut icon="search" label="Search" onClick={() => { setShortcuts(false); setAdding({ meal: mealNow(), tab: 'search' }); }} />
          <Shortcut icon="barcode" label="Scan" onClick={() => { setShortcuts(false); setAdding({ meal: mealNow(), tab: 'scan' }); }} />
          <Shortcut icon="bolt" label="Quick add" onClick={() => { setShortcuts(false); setAdding({ meal: mealNow(), tab: 'quick' }); }} />
          <Shortcut icon="food" label="Mine" onClick={() => { setShortcuts(false); setAdding({ meal: mealNow(), tab: 'mine' }); }} />
        </div>
        <div className="grid-2" style={{ marginTop: 14 }}>
          <button className="shortcut-wide pressable" onClick={() => { setShortcuts(false); setRecipe(true); }}><Icon name="note" size={22} />New recipe</button>
          <button className="shortcut-wide pressable" onClick={() => { setShortcuts(false); nav('/nutrition'); }}><Icon name="target" size={22} />Goals</button>
        </div>
      </Sheet>

      <AddFoodSheet open={!!adding} meal={adding?.meal ?? 'snacks'} initialTab={adding?.tab} date={date} onClose={() => setAdding(null)} />
      <RecipeEditor open={recipe} onClose={() => setRecipe(false)} />
      <EntrySheet entry={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function Shortcut({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button className="shortcut pressable" onClick={onClick}>
      <span className="shortcut-circle role-text"><Icon name={icon} size={28} stroke={2} /></span>
      <span>{label}</span>
    </button>
  );
}

const fmtQty = (e: FoodEntry) => {
  // same wording as the amount picker: Hebrew household measures read in English when the food name is English
  if (e.unit && e.unit !== 'g' && e.unit !== 'ml' && e.qty != null) return `${+e.qty.toFixed(2)} × ${unitLabel(e.unit, !hasHebrew(e.name)).replace(/^1 /, '')}`;
  return `${Math.round(e.qty ?? e.grams ?? 0)} ${e.unit === 'ml' ? 'ml' : 'g'}`;
};

/** MyNetDiary-style day card: calorie ring in the middle, macros left, meals right. */
function Dashboard({ total, goal, meals, onMeal }: {
  total: Macros; goal: NutritionGoal | null; meals: { id: Meal; label: string; kcal: number }[]; onMeal: (m: Meal) => void;
}) {
  const kcalGoal = goal?.kcal ?? null;
  const left = kcalGoal != null ? kcalGoal - total.kcal : null;
  return (
    <div className="card dash">
      <div className="dash-top">
        {kcalGoal != null
          ? <><span className="muted">Eaten</span> <b className="num">{k(total.kcal)}</b> <span className="muted">/ {k(kcalGoal)} kcal goal</span></>
          : <span className="muted">No calorie goal</span>}
      </div>
      <div className="dash-grid">
        <div className="dash-col">
          <DashStat label="Carbs" value={total.c} goal={goal?.carbsG ?? null} cls="mc-c" />
          <DashStat label="Protein" value={total.p} goal={goal?.proteinG ?? null} cls="mc-p" />
          <DashStat label="Fat" value={total.f} goal={goal?.fatG ?? null} cls="mc-f" />
        </div>
        <Ring value={total.kcal} max={kcalGoal ?? Math.max(total.kcal, 1)} size={150} track={kcalGoal == null}>
          <span className="num dash-eaten">{k(left != null ? Math.abs(left) : total.kcal)}</span>
          <span className="dash-left num">{left == null ? 'kcal eaten' : left >= 0 ? 'kcal left' : 'kcal over'}</span>
        </Ring>
        <div className="dash-col right">
          {meals.map((m) => (
            <button key={m.id} className="dash-meal" onClick={() => onMeal(m.id)}>
              <span className="muted">{m.label}</span>
              <b className="num">{k(m.kcal)}<span className="sr-only"> kcal</span></b>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DashStat({ label, value, goal, cls }: { label: string; value: number; goal: number | null; cls: string }) {
  return (
    <div className="dash-stat">
      <span className={cls + ' w-6'}>{label}</span>
      <b className="num">{Math.round(value)}<small className="muted">{goal != null ? ` / ${Math.round(goal)}` : ''} g</small></b>
      {goal != null && <span className="bar thin" aria-hidden><i style={{ width: `${Math.min(100, (value / goal) * 100)}%`, background: `var(--${cls})` }} /></span>}
    </div>
  );
}

/** Compact version for the Home widget. */
export function Summary({ total, goal, compact }: { total: Macros; goal: NutritionGoal; compact?: boolean }) {
  const kcalGoal = goal.kcal;
  const left = kcalGoal != null ? kcalGoal - total.kcal : null;
  return (
    <div className="row" style={{ gap: compact ? 12 : 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <Ring value={total.kcal} max={kcalGoal ?? Math.max(total.kcal, 1)} size={compact ? 84 : 132} track={kcalGoal == null}>
        <span className="num" style={{ fontSize: compact ? '1.125rem' : '1.75rem', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 }}>{k(left != null ? Math.abs(left) : total.kcal)}</span>
        <span className="w-6" style={{ fontSize: '0.6875rem', color: 'var(--text-2)' }}>{left == null ? 'kcal eaten' : left >= 0 ? 'kcal left' : 'kcal over'}</span>
      </Ring>
      <div className="grow stack" style={{ gap: 6, minWidth: '9rem' }}>
        {goal.proteinG != null ? (
          <div>
            <div className="row" style={{ justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 650, marginBottom: 4 }}>
              <span className="mc-p">Protein</span><span className="num">{Math.round(total.p)}<span className="muted"> / {Math.round(goal.proteinG)} g</span></span>
            </div>
            <div className="bar" aria-hidden><i style={{ width: `${Math.min(100, (total.p / goal.proteinG) * 100)}%`, background: 'var(--mc-p)' }} /></div>
          </div>
        ) : <MacroLine m={total} />}
        <div className="muted num t-13">{k(total.kcal)}{kcalGoal != null ? ` / ${k(kcalGoal)}` : ''} kcal eaten</div>
      </div>
    </div>
  );
}

export function Ring({ value, max, size, children, track }: { value: number; max: number; size: number; children: ReactNode; track?: boolean }) {
  const stroke = Math.round(size * 0.09);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = track ? 0 : max > 0 ? Math.min(1, value / max) : 0;
  const over = !track && value > max * 1.1;
  return (
    // sized in rem so the ring grows with the user's text size and its number always fits inside
    <div style={{ position: 'relative', width: `${size / 16}rem`, height: `${size / 16}rem`, flex: 'none' }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ rotate: '-90deg', display: 'block' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--card-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={over ? 'var(--warn)' : 'var(--c-food)'} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: 'stroke-dashoffset 600ms var(--ease-out)' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', alignContent: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  );
}
