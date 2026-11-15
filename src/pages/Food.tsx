import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AddFoodSheet, EntrySheet } from '../components/FoodSheets';
import { Icon } from '../components/Icon';
import { alive, db, newRecord, save } from '../db/db';
import { goalFor } from '../db/food';
import type { FoodEntry, Macros, Meal, NutritionGoal } from '../db/types';
import { dateKey, keyToDate, shiftDate, sum } from '../lib/nutrition';

export const MEALS: { id: Meal; label: string; icon: string }[] = [
  { id: 'breakfast', label: 'Breakfast', icon: 'sun' },
  { id: 'lunch', label: 'Lunch', icon: 'food' },
  { id: 'dinner', label: 'Dinner', icon: 'moon' },
  { id: 'snacks', label: 'Snacks', icon: 'cookie' },
];
/** Default meal by time of day, so "+" usually lands in the right place. */
export const mealNow = (): Meal => { const h = new Date().getHours(); return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snacks'; };

export function useDay(date: string) {
  const entries = useLiveQuery(() => db.entries.where('date').equals(date).filter(alive).sortBy('at'), [date]) ?? [];
  const goal = useLiveQuery(() => goalFor(date), [date]);
  const status = useLiveQuery(() => db.days.get(date), [date]);
  return { entries, goal, status, total: sum(entries.map((e) => e.n)) };
}

export const k = (v: number) => Math.round(v).toLocaleString();

export function FoodPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const today = dateKey();
  const date = params.get('d') ?? today;
  const setDate = (d: string) => setParams(d === today ? {} : { d }, { replace: true });
  const { entries, goal, status, total } = useDay(date);
  const [adding, setAdding] = useState<Meal | null>(null);
  const [editing, setEditing] = useState<FoodEntry | null>(null);

  const label = date === today ? 'Today' : date === shiftDate(today, -1) ? 'Yesterday'
    : keyToDate(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div className="page" data-role="food">
      <header className="page-head">
        <h1>Food</h1>
        <button className="icon-btn" aria-label="Nutrition goals" onClick={() => nav('/nutrition')}><Icon name="target" /></button>
      </header>

      <div className="date-pill">
        <button className="icon-btn sm" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))}><Icon name="chevronLeft" size={18} /></button>
        <button className="date-pill-label" onClick={() => setDate(today)}><Icon name="calendar" size={16} />{label}</button>
        <button className="icon-btn sm" aria-label="Next day" onClick={() => setDate(shiftDate(date, 1))} disabled={date >= today}><Icon name="chevronRight" size={18} /></button>
      </div>

      {goal ? <Summary total={total} goal={goal} /> : (
        <button className="card pressable row" style={{ width: '100%', border: 0, color: 'inherit', textAlign: 'left', marginTop: 12 }} onClick={() => nav('/nutrition')}>
          <span className="role-chip"><Icon name="target" size={16} stroke={2} /></span>
          <span className="grow"><b>Set your goals</b><br /><span className="muted" style={{ fontSize: '0.875rem' }}>Maintenance, calories and protein</span></span>
          <Icon name="chevronRight" className="chev" size={18} />
        </button>
      )}

      <div className="stack" style={{ gap: 12, marginTop: 12 }}>
        {MEALS.map((m) => {
          const list = entries.filter((e) => e.meal === m.id);
          const kcal = sum(list.map((e) => e.n)).kcal;
          return (
            <section key={m.id} className="card meal-card">
              <div className="row" style={{ minHeight: 40 }}>
                <span className="role-chip"><Icon name={m.icon} size={16} stroke={2} /></span>
                <span className="grow" style={{ fontWeight: 700, fontSize: '1.0625rem' }}>{m.label}</span>
                {kcal > 0 && <span className="num muted" style={{ fontWeight: 650 }}>{k(kcal)}</span>}
                <button className="round-btn sm-round" aria-label={`Add to ${m.label}`} onClick={() => setAdding(m.id)}><Icon name="plus" size={18} stroke={2.4} /></button>
              </div>
              {list.length > 0 && (
                <div className="entry-list">
                  {list.map((e) => (
                    <button key={e.id} className="entry-row pressable" onClick={() => setEditing(e)}>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="ellipsis" style={{ display: 'block', fontWeight: 560 }}>{e.name}</span>
                        <span className="muted ellipsis" style={{ display: 'block', fontSize: '0.8125rem' }}>
                          {e.source === 'quick' ? <><Icon name="bolt" size={11} /> quick</> : `${fmtQty(e)}${e.brand ? ` · ${e.brand}` : ''}`}
                        </span>
                      </span>
                      <span className="entry-macros num">
                        <b>{k(e.n.kcal)}</b>
                        <small>{Math.round(e.n.p)}p · {Math.round(e.n.c)}c · {Math.round(e.n.f)}f</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <label className="card row" style={{ marginTop: 12, cursor: 'pointer' }}>
        <span className="grow"><b style={{ fontWeight: 650 }}>Day fully logged</b><br /><span className="muted" style={{ fontSize: '0.8125rem' }}>Only complete days tune your maintenance</span></span>
        <span className="switch"><input type="checkbox" checked={!!status?.complete}
          onChange={(e) => save('days', status ? { ...status, complete: e.target.checked } : { ...newRecord({ complete: e.target.checked }), id: date })} /><span /></span>
      </label>

      <AddFoodSheet open={!!adding} meal={adding ?? 'snacks'} date={date} onClose={() => setAdding(null)} />
      <EntrySheet entry={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

const fmtQty = (e: FoodEntry) => {
  if (e.unit && e.unit !== 'g' && e.qty != null) return `${+e.qty.toFixed(2)} × ${e.unit.replace(/^1 /, '')}`;
  return `${Math.round(e.grams ?? 0)} g`;
};

/** Calories ring + macro bars. */
export function Summary({ total, goal, compact }: { total: Macros; goal: NutritionGoal; compact?: boolean }) {
  const left = goal.kcal - total.kcal;
  return (
    <div className={compact ? '' : 'card'} style={compact ? undefined : { marginTop: 12, padding: '18px 16px' }}>
      <div className="row" style={{ gap: compact ? 12 : 18, alignItems: 'center' }}>
        <Ring value={total.kcal} max={goal.kcal} size={compact ? 84 : 132}>
          <span className="num" style={{ fontSize: compact ? '1.125rem' : '1.75rem', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 }}>{k(Math.abs(left))}</span>
          <span style={{ fontSize: compact ? '0.6875rem' : '0.8125rem', color: 'var(--text-2)', fontWeight: 600 }}>{left >= 0 ? 'left' : 'over'}</span>
        </Ring>
        <div className="grow stack" style={{ gap: compact ? 6 : 10 }}>
          <MacroBar label="Protein" short="P" value={total.p} goal={goal.proteinG} color="var(--c-food)" compact={compact} />
          {!compact && <MacroBar label="Carbs" short="C" value={total.c} goal={goal.carbsG ?? undefined} color="#64d2ff" />}
          {!compact && <MacroBar label="Fat" short="F" value={total.f} goal={goal.fatG ?? undefined} color="#ffd60a" />}
          {compact && <div className="muted num" style={{ fontSize: '0.8125rem' }}>{k(total.kcal)} / {k(goal.kcal)} kcal</div>}
          {!compact && <div className="muted num" style={{ fontSize: '0.8125rem' }}>{k(total.kcal)} of {k(goal.kcal)} kcal</div>}
        </div>
      </div>
    </div>
  );
}

export function Ring({ value, max, size, children }: { value: number; max: number; size: number; children: React.ReactNode }) {
  const stroke = Math.round(size * 0.1);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const over = value > max * 1.1;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ rotate: '-90deg' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--card-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={over ? 'var(--warn)' : 'var(--c-food)'} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: 'stroke-dashoffset 500ms var(--ease-out)' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', alignContent: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  );
}

function MacroBar({ label, short, value, goal, color, compact }: { label: string; short: string; value: number; goal?: number; color: string; compact?: boolean }) {
  const pct = goal ? Math.min(1, value / goal) : 0;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: compact ? '0.75rem' : '0.8125rem', fontWeight: 650, marginBottom: 4 }}>
        <span className="muted">{compact ? short : label}</span>
        <span className="num">{Math.round(value)}{goal ? <span className="muted"> / {Math.round(goal)} g</span> : ' g'}</span>
      </div>
      <div className="bar" aria-hidden><i style={{ width: `${(goal ? pct : 0) * 100}%`, background: color }} /></div>
    </div>
  );
}
