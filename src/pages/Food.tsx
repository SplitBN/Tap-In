import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router';
import { AddFoodSheet, EntriesTransferSheet, EntrySheet, FoodTile, MacroLine, RecipeEditor } from '../components/FoodSheets';
import { toast } from '../components/Toast';
import { ImportHint } from '../components/ImportHint';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { entriesDeleteMany } from '../api/food';
import { DayStatusChip, MorningCheck } from '../components/DayStatus';
import { recordsRestore } from '../api/body';
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
  return { entries, goal, total: sum(entries.map((e) => e.n)) };
}


type Tab = 'search' | 'scan' | 'quick' | 'mine';

export function FoodPage() {
  // a brand-new food log (nothing ever logged): offer the MyNetDiary import
  const neverLogged = useLiveQuery(async () => !(await db.entries.filter(alive).first()), []) ?? false;
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const today = useToday();
  const date = params.get('d') ?? today;
  const setDate = (d: string) => setParams(d === today ? {} : { d }, { replace: true });
  const { entries, goal, total } = useDay(date);
  const [adding, setAdding] = useState<{ meal: Meal; tab: Tab } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [menu, setMenu] = useState(false);
  const [recipe, setRecipe] = useState(false);
  const [editing, setEditing] = useState<FoodEntry | null>(null);
  const byMeal = (m: Meal) => entries.filter((e) => e.meal === m);
  // selection mode: tick entries (any meal) -> copy / move / delete
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [xfer, setXfer] = useState<'copy' | 'move' | null>(null);
  const chosen = entries.filter((e) => picked.includes(e.id)); // only live entries of this day count
  const [seenDate, setSeenDate] = useState(date);
  if (seenDate !== date) { setSeenDate(date); setSelecting(false); setPicked([]); }
  const endSelect = () => { setSelecting(false); setPicked([]); };
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const press = useLongPress((id) => { setSelecting(true); setPicked((p) => (p.includes(id) ? p : [...p, id])); });
  const removePicked = async () => {
    const ids = chosen.map((e) => e.id); if (!ids.length) return;
    await run(entriesDeleteMany, { ids }); endSelect();
    toast(`${ids.length} deleted`, async () => { for (const id of ids) await run(recordsRestore, { table: 'entries', id }); });
  };
  const log = (tab: Tab) => { setShortcuts(false); setAdding({ meal: mealNow(), tab }); };

  const label = date === today ? 'Today' : date === shiftDate(today, -1) ? 'Yesterday'
    : keyToDate(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const shell = document.querySelector('.shell');

  return (
    <div className="page" data-role="food">
      <header className="title-more lt">
        <h1>Food</h1>
        {selecting
          ? <button className="btn ghost sel-done" onClick={endSelect}>Done</button>
          : <button className="more-pill" aria-label="Food options" onClick={() => setMenu(true)}><Icon name="more" size={22} stroke={3} /></button>}
      </header>

      <div className="date-pill">
        <button className="icon-btn sm" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))}><Icon name="chevronLeft" size={18} /></button>
        <button className="date-pill-label" onClick={() => setDate(today)} aria-label={date === today ? 'Today' : `${label}. Go to today`}><Icon name="calendar" size={16} />{label}</button>
        <button className="icon-btn sm" aria-label="Next day" onClick={() => setDate(shiftDate(date, 1))} disabled={date >= today}><Icon name="chevronRight" size={18} /></button>
      </div>

      {goal === undefined ? null : !goal && !entries.length ? (
        <button className="group pressable row setup-cta" onClick={() => nav('/nutrition')}>
          <span className="tile-ic" aria-hidden><Icon name="target" size={22} stroke={2} /></span>
          <span className="grow"><b className="t-17">Set up your goals</b><span className="muted t-15" style={{ display: 'block' }}>7 quick questions, or just start logging</span></span>
          <Icon name="chevronRight" className="chev" size={18} />
        </button>
      ) : null}

      {neverLogged && date === today && <ImportHint from="MyNetDiary" />}
      {date === today && <MorningCheck />}
      <div className="day-chip-row"><DayStatusChip date={date} /></div>

      <Dashboard total={total} goal={goal ?? null} meals={MEALS.map((m) => ({ ...m, kcal: sum(byMeal(m.id).map((e) => e.n)).kcal }))}
        onMeal={(m) => document.getElementById(`meal-${m}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />

      {MEALS.map((m) => {
        const list = byMeal(m.id);
        const mt = sum(list.map((e) => e.n));
        return (
          <section key={m.id} id={`meal-${m.id}`} className="meal" aria-labelledby={`meal-h-${m.id}`}>
            <div className="meal-head">
              <span className="role-chip" aria-hidden><Icon name={m.icon} size={16} stroke={2} /></span>
              <h2 id={`meal-h-${m.id}`} className="grow">{m.label}</h2>
              {mt.kcal > 0 && <span className="num muted">{k(mt.kcal)} kcal</span>}
              {!selecting
                ? <button className="icon-btn sm tint" aria-label={`Add to ${m.label}`} onClick={() => setAdding({ meal: m.id, tab: 'search' })}><Icon name="plus" size={18} stroke={2.4} /></button>
                : list.length > 0 && (() => {
                  const all = list.every((e) => picked.includes(e.id));
                  return <button className={'sel-circle' + (all ? ' on' : '')} aria-pressed={all} aria-label={`Select all ${m.label}`}
                    onClick={() => setPicked((p) => (all ? p.filter((id) => !list.some((e) => e.id === id)) : [...new Set([...p, ...list.map((e) => e.id)])]))}>
                    {all && <Icon name="check" size={16} stroke={3} />}</button>;
                })()}
            </div>
            {list.length > 0 && (
              <div className="group">
                {list.map((e) => (
                  <button key={e.id} className={'fd-row pressable' + (selecting ? ' selecting' : '')} {...press.bind(e.id)}
                    aria-pressed={selecting ? picked.includes(e.id) : undefined}
                    onClick={() => { if (press.fired()) return; if (selecting) togglePick(e.id); else setEditing(e); }}>
                    {selecting && <span className={'sel-circle' + (picked.includes(e.id) ? ' on' : '')} aria-hidden>{picked.includes(e.id) && <Icon name="check" size={16} stroke={3} />}</span>}
                    <FoodTile name={e.name} quick={e.source === 'quick'} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="fd-name ellipsis bidi-start" dir="auto">{e.name}</span>
                      <span className="fd-sub">{e.source === 'quick' ? (e.amount ? `${e.amount} · ` : 'Quick add · ') : `${fmtQty(e)} · `}<MacroLine m={e.n} /></span>
                    </span>
                    <span className="fd-kcal num">{k(e.n.kcal)}<span className="sr-only"> kcal</span></span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}

      <nav className="text-links" aria-label="Food">
        <button className="text-link" onClick={() => nav('/nutrition')}>Goals</button>
        <button className="text-link" onClick={() => setAdding({ meal: mealNow(), tab: 'mine' })}>My foods</button>
        <button className="text-link" onClick={() => setRecipe(true)}>New recipe</button>
      </nav>

      {selecting && <div className="sel-spacer" aria-hidden />}
      {/* floating + (lives in the app frame, above the tab bar) */}
      {shell && createPortal(selecting ? (
        <div className="sel-bar" data-role="food" role="toolbar" aria-label="Selected entries">
          <button className="icon-btn" aria-label="Cancel selection" onClick={endSelect}><Icon name="close" size={20} /></button>
          <span className="sel-count num" aria-live="polite">{chosen.length}<span className="sr-only"> selected</span></span>
          <span className="grow" />
          <button className="sel-act" disabled={!chosen.length} onClick={() => setXfer('copy')}><Icon name="copy" size={20} /><span>Copy</span></button>
          <button className="sel-act" disabled={!chosen.length} onClick={() => setXfer('move')}><Icon name="chevronRight" size={20} stroke={2.4} /><span>Move</span></button>
          <button className="sel-act danger" disabled={!chosen.length} onClick={removePicked}><Icon name="trash" size={20} /><span>Delete</span></button>
        </div>
      ) : <button className="fab" aria-label="Log food" onClick={() => setShortcuts(true)}><Icon name="plus" size={28} stroke={2.4} /></button>, shell)}

      <Sheet open={shortcuts} onClose={() => setShortcuts(false)} title="Log food">
        <div className="am">
          <div className="tile-pair">
            <button className="tile pressable" onClick={() => log('search')}><Icon name="search" size={22} /><span>Search</span></button>
            <button className="tile pressable" onClick={() => log('scan')}><Icon name="barcode" size={22} /><span>Scan</span></button>
          </div>
          <div className="group">
            <button className="am-row pressable" onClick={() => log('quick')}><Icon name="bolt" /><span className="grow">Quick add<span className="am-sub">Calories and macros only</span></span></button>
            <button className="am-row pressable" onClick={() => log('mine')}><Icon name="food" /><span className="grow">My foods<span className="am-sub">Yours, scanned and recipes</span></span></button>
          </div>
          <nav className="text-links" aria-label="More">
            <button className="text-link" onClick={() => { setShortcuts(false); setRecipe(true); }}>New recipe</button>
            <button className="text-link" onClick={() => { setShortcuts(false); nav('/nutrition'); }}>Goals</button>
          </nav>
        </div>
      </Sheet>

      <Sheet open={menu} onClose={() => setMenu(false)} title="Food">
        <div className="am">
          <div className="group">
            <button className="am-row pressable" onClick={() => { setMenu(false); nav('/nutrition'); }}><Icon name="target" /><span className="grow">Goals</span></button>
            <button className="am-row pressable" onClick={() => { setMenu(false); setAdding({ meal: mealNow(), tab: 'mine' }); }}><Icon name="food" /><span className="grow">My foods</span></button>
            <button className="am-row pressable" onClick={() => { setMenu(false); setRecipe(true); }}><Icon name="note" /><span className="grow">New recipe</span></button>
          </div>
          {entries.length > 0 && <div className="group">
            <button className="am-row pressable" onClick={() => { setMenu(false); setSelecting(true); }}><Icon name="check" /><span className="grow">Select<span className="am-sub">Copy, move or delete entries · or hold one</span></span></button>
          </div>}
          {date !== today && <nav className="text-links" aria-label="Day"><button className="text-link" onClick={() => { setMenu(false); setDate(today); }}>Go to today</button></nav>}
        </div>
      </Sheet>

      <AddFoodSheet open={!!adding} meal={adding?.meal ?? 'snacks'} initialTab={adding?.tab} date={date} onClose={() => setAdding(null)} />
      <RecipeEditor open={recipe} onClose={() => setRecipe(false)} />
      <EntrySheet entry={editing} onClose={() => setEditing(null)} />
      <EntriesTransferSheet open={!!xfer} kind={xfer ?? 'copy'} entries={chosen} viewing={date} today={today} onClose={() => setXfer(null)}
        onDone={(text, undo) => { setXfer(null); endSelect(); toast(text, undo); }} />
    </div>
  );
}

/** Hold ~0.45 s on a row (without scrolling) to start selecting; the click that follows is swallowed. */
function useLongPress(onLong: (id: string) => void) {
  const t = useRef(0), start = useRef<{ x: number; y: number } | null>(null), fired = useRef(false);
  const cb = useRef(onLong); cb.current = onLong;
  useEffect(() => () => clearTimeout(t.current), []);
  const cancel = () => { clearTimeout(t.current); start.current = null; };
  return {
    fired: () => { const f = fired.current; fired.current = false; return f; },
    bind: (id: string) => ({
      onPointerDown: (e: RPointerEvent) => {
        if (e.button !== 0) return;
        fired.current = false; start.current = { x: e.clientX, y: e.clientY }; clearTimeout(t.current);
        t.current = window.setTimeout(() => { fired.current = true; start.current = null; cb.current(id); }, 450);
      },
      onPointerMove: (e: RPointerEvent) => { const s = start.current; if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) cancel(); },
      onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel,
      onContextMenu: (e: RMouseEvent) => e.preventDefault(),
    }),
  };
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
