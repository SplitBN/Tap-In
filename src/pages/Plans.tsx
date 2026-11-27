import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog } from '../components/Dialog';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ImportHint } from '../components/ImportHint';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db } from '../db/db';
import { activeSession, nextWorkoutId } from '../db/gym';
import type { Exercise, Plan, Workout } from '../db/types';
import { ThumbPill } from '../components/ExThumb';
import { WorkoutPreview } from '../components/WorkoutPreview';
import { useToday } from '../lib/today';
import { useTick } from '../lib/rest';
import { moveItem } from './Session';
import { fmtDate, fmtDuration, plural } from '../lib/format';
import { useSettings } from '../db/settings';
import { run } from '../api/registry';
import { plansCreate, plansDelete, plansReorder, plansSetActive, plansUpdate, sessionsStart, workoutsCreate } from '../api/gym';
import { planStart, planWeek } from '../lib/planWeek';
import { MuscleVolumeSection } from '../components/MuscleVolume';
import { muscleRows, plannedSetsByMuscle } from '../lib/workoutStats';
import { dateKey, keyToDate } from '../lib/nutrition';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

const totalSets = (w: Workout) => w.items.reduce((a, i) => a + i.sets, 0);

/** Gym tab: week strip, the active plan as a large title with ⋯ and its week, its workouts (tap = preview), then plain links. */
export function PlansPage() {
  const settings = useSettings();
  const nav = useNavigate();
  const todayKey = useToday();
  const plans = useLiveQuery(() => db.plans.filter(alive).toArray(), []) ?? [];
  const plan = plans.find((p) => p.id === settings.activePlanId);
  const workouts = useLiveQuery(async () => (plan ? (await db.workouts.bulkGet(plan.workoutIds)).filter((w) => w && alive(w)) as Workout[] : []), [plan]) ?? [];
  const nextId = useLiveQuery(() => (plan ? nextWorkoutId(plan) : Promise.resolve(undefined)), [plan]);
  const live = useLiveQuery(() => activeSession(), []);
  const [naming, setNaming] = useState<'plan' | 'workout' | null>(null);
  const [menu, setMenu] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [dating, setDating] = useState(false);
  const now = useTick(!!live, 1000);
  const showWeek = settings.features.planWeek !== false;
  const week = plan ? planWeek(plan) : 1;

  // this week (Mon → Sun) and the days a workout was done (plans aren't tied to weekdays: no schedule to show)
  const ws = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }, [todayKey]);
  const trained = useLiveQuery(async () => {
    const list = await db.sessions.where('startedAt').aboveOrEqual(ws).filter(alive).toArray();
    return new Set(list.map((s) => new Date(s.startedAt).toDateString()));
  }, [ws]) ?? new Set<string>();
  const days = Array.from({ length: 7 }, (_, i) => new Date(ws + i * 86400000 + 3600000)); // +1h: DST-safe
  const today = new Date().toDateString();

  return (
    <div className="page" data-role="gym">
      <div className="gym-top">
        <button className="icon-btn filled" aria-label="New plan" onClick={() => setNaming('plan')}><Icon name="plus" /></button>
      </div>
      <div className="week-strip" role="list" aria-label="This week">
        {days.map((d, i) => {
          const on = trained.has(d.toDateString());
          const isToday = d.toDateString() === today;
          return (
            <div key={i} role="listitem" className={'ws-day' + (isToday ? ' today' : '') + (on ? ' on' : '')}
              aria-label={`${isToday ? 'Today, ' : ''}${longDay.format(d)}${on ? ', workout done' : ''}`}>
              <span aria-hidden>{WEEKDAYS[i]}</span>
              <span className="num" aria-hidden>{d.getDate()}</span>
              <i aria-hidden />
            </div>
          );
        })}
      </div>

      {live && (
        <button className="live-row pressable" onClick={() => nav(`/session/${live.id}`)}>
          <span className="live-dot" aria-hidden />
          <span className="grow ellipsis"><span className="sr-only">Workout in progress: </span>{live.name}</span>
          <span className="num muted">{fmtDuration(now - live.startedAt)}</span>
          <Icon name="chevronRight" size={18} className="chev" />
        </button>
      )}

      {plan ? (
        <>
          <header className="title-more lt">
            <h1 className="role-text">{plan.name}</h1>
            <button className="more-pill" aria-label="Plan options" onClick={() => setMenu(true)}><Icon name="more" size={22} stroke={3} /></button>
            {showWeek && (
              <button className="plan-week num" onClick={() => setDating(true)} aria-haspopup="dialog" aria-label={`Week ${week}. Change start date`}>Week {week}</button>
            )}
          </header>
          {workouts.length ? (
            <div className="group">
              {workouts.map((w, i) => (
                <button key={w.id} className="wk-row pressable" onClick={() => setPreview(w.id)} aria-haspopup="dialog"
                  aria-label={`${w.name}, ${plural(w.items.length, 'exercise', 'exercises')}${w.id === nextId ? ', next' : ''}`}>
                  <span className={'wk-no num' + (w.id === nextId ? ' next' : '')} aria-hidden>{i + 1}</span>
                  <span className="wk-name grow ellipsis">{w.name}</span>
                  <ThumbPill ids={w.items.map((it) => it.exerciseId)} />
                </button>
              ))}
            </div>
          ) : (
            <div className="group empty compact">
              <p>No workouts in this plan yet.</p>
              <button className="btn primary" onClick={() => setNaming('workout')}><Icon name="plus" size={18} /> Workout</button>
            </div>
          )}
        </>
      ) : plans.length ? (
        <>
          <header className="title-more lt"><h1>Gym</h1></header>
          <p className="muted" style={{ margin: '0 4px 10px' }}>Pick a plan to train from.</p>
          <PlanList plans={plans} activeId={settings.activePlanId} />
        </>
      ) : (
        <>
          <header className="title-more lt"><h1>Gym</h1></header>
          <div className="empty">
            <Icon name="dumbbell" size={40} />
            <h3>No plans yet</h3>
            <p>A plan is a few workouts you rotate through.</p>
            <button className="btn primary" onClick={() => setNaming('plan')}><Icon name="plus" size={18} /> New plan</button>
            <ImportHint from="Alpha Progression" />
          </div>
        </>
      )}

      <nav className="text-links" aria-label="Gym">
        {plans.length > 0 && <Link className="text-link" to="/plans/all">All plans</Link>}
        <Link className="text-link" to="/exercises">Exercises</Link>
        <Link className="text-link" to="/stats">Stats</Link>
        <Link className="text-link" to="/history">History</Link>
      </nav>

      <WorkoutPreview workoutId={preview} planName={plan?.name} planWeek={plan && showWeek ? week : undefined} onClose={() => setPreview(null)} />
      {plan && (
        <PlanMenu open={menu} onClose={() => setMenu(false)} plan={plan} onDate={() => setDating(true)}>
          <div className="group">
            <button className="am-row pressable" onClick={() => { setMenu(false); nav(`/plans/${plan.id}`); }}><Icon name="edit" /><span className="grow">Edit plan</span></button>
            <button className="am-row pressable" onClick={() => { setMenu(false); setNaming('workout'); }}><Icon name="plus" /><span className="grow">New workout</span></button>
          </div>
          <div className="group">
            <button className="am-row pressable" onClick={() => { setMenu(false); nav('/plans/all'); }}><Icon name="swap" /><span className="grow">Switch plan</span></button>
            <button className="am-row pressable" onClick={async () => { setMenu(false); const { session } = await run(sessionsStart, {}); nav(`/session/${session.id}`); }}>
              <Icon name="play" /><span className="grow">{live ? 'Resume workout' : 'Empty workout'}</span>
            </button>
          </div>
        </PlanMenu>
      )}
      {plan && <StartDateSheet open={dating} onClose={() => setDating(false)} plan={plan} />}
      <NameSheet open={naming === 'plan'} title="New plan" placeholder="e.g. Upper / Lower" onClose={() => setNaming(null)}
        onSubmit={async (name) => { const p = await run(plansCreate, { name }); nav(`/plans/${p.id}`); }} />
      <NameSheet open={naming === 'workout'} title="New workout" placeholder="e.g. Push A" onClose={() => setNaming(null)}
        onSubmit={async (name) => { if (!plan) return; const w = await run(workoutsCreate, { planId: plan.id, name }); nav(`/workouts/${w.id}`); }} />
    </div>
  );
}

/** Plan ⋯ sheet: screen-specific rows (children) + the shared Rename / Start date rows. */
function PlanMenu({ open, onClose, plan, onDate, children, footer }: {
  open: boolean; onClose: () => void; plan: Plan; onDate: () => void; children?: ReactNode; footer?: ReactNode;
}) {
  const settings = useSettings();
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <Sheet open={open} onClose={onClose} title={plan.name}>
        <div className="am">
          {children}
          <div className="group">
            <button className="am-row pressable" onClick={() => { onClose(); setRenaming(true); }}><Icon name="pencil" /><span className="grow">Rename</span></button>
            <button className="am-row pressable" onClick={() => { onClose(); onDate(); }} aria-haspopup="dialog">
              <Icon name="calendar" /><span className="grow">Start date</span>
              <span className="am-val num">{fmtDate(keyToDate(planStart(plan)).getTime(), { month: 'short', day: 'numeric' })}{settings.features.planWeek !== false ? ` · W${planWeek(plan)}` : ''}</span>
            </button>
          </div>
          {footer}
        </div>
      </Sheet>
      <NameSheet open={renaming} title="Rename plan" initial={plan.name} onClose={() => setRenaming(false)}
        onSubmit={(name) => run(plansUpdate, { id: plan.id, name })} />
    </>
  );
}

/** Where "Week N" counts from: a date row, the week it gives today, and a way back to the created date. */
function StartDateSheet({ open, onClose, plan }: { open: boolean; onClose: () => void; plan: Plan }) {
  const [v, setV] = useState('');
  const [was, setWas] = useState(false);
  const inputId = useId();
  if (open !== was) { setWas(open); if (open) setV(planStart(plan)); }
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const created = dateKey(plan.createdAt);
  const save = async () => { if (!valid) return; await run(plansUpdate, { id: plan.id, startDate: v === created && !plan.startDate ? null : v }); onClose(); };
  return (
    <Sheet open={open} onClose={onClose} title="Start date">
      <div className="stack" style={{ gap: 12 }}>
        <div className="group">
          <label className="am-row" htmlFor={inputId}>
            <Icon name="calendar" /><span className="grow">Week 1 starts</span>
            <input id={inputId} className="inline-input num" type="date" aria-label="Week 1 starts" value={v} onChange={(e) => setV(e.target.value)} />
          </label>
        </div>
        <p className="muted t-15" style={{ margin: '0 4px' }} aria-live="polite">
          {valid ? <>Today is <b className="role-text num">Week {planWeek({ createdAt: plan.createdAt, startDate: v })}</b>. Weeks start on Monday.</> : 'Pick a date.'}
        </p>
        <button className="btn primary lg block" onClick={save} disabled={!valid}><Icon name="check" size={20} stroke={2.6} /> Save</button>
        {plan.startDate && (
          <nav className="text-links" aria-label="Start date">
            <button className="text-link" onClick={async () => { await run(plansUpdate, { id: plan.id, startDate: null }); onClose(); }}>Count from {fmtDate(plan.createdAt)}</button>
          </nav>
        )}
      </div>
    </Sheet>
  );
}

function PlanList({ plans, activeId }: { plans: Plan[]; activeId?: string }) {
  return (
    <div className="group">
      {plans.map((p) => (
        <Link key={p.id} to={`/plans/${p.id}`} className="list-item pressable">
          <span className="grow">
            <span className="title">{p.name}</span>
            <span className="sub" style={{ display: 'block' }}>{plural(p.workoutIds.length, 'workout', 'workouts')}</span>
          </span>
          {activeId === p.id && <span className="badge accent"><Icon name="check" size={12} stroke={3} /><span>Active</span></span>}
          <Icon name="chevronRight" className="chev" size={18} />
        </Link>
      ))}
    </div>
  );
}

/** Every plan (the Gym tab shows only the active one). */
export function AllPlansPage() {
  const settings = useSettings();
  // newest first (by the date its weeks count from), so imported old plans sit below current ones
  const plans = useLiveQuery(async () => (await db.plans.filter(alive).toArray()).sort((a, b) => planStart(b).localeCompare(planStart(a)) || b.createdAt - a.createdAt), []) ?? [];
  const [naming, setNaming] = useState(false);
  const nav = useNavigate();
  return (
    <div className="page" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('/plans')}><Icon name="chevronLeft" /></button>
        <h1 className="small">Plans</h1>
        <button className="icon-btn filled" aria-label="New plan" onClick={() => setNaming(true)}><Icon name="plus" /></button>
      </header>
      {plans.length ? <PlanList plans={plans} activeId={settings.activePlanId} /> : (
        <div className="empty">
          <Icon name="dumbbell" size={40} />
          <h3>No plans yet</h3>
          <button className="btn primary" onClick={() => setNaming(true)}><Icon name="plus" size={18} /> New plan</button>
          <ImportHint from="Alpha Progression" />
        </div>
      )}
      <NameSheet open={naming} title="New plan" placeholder="e.g. Upper / Lower" onClose={() => setNaming(false)}
        onSubmit={async (name) => { const p = await run(plansCreate, { name }); nav(`/plans/${p.id}`); }} />
    </div>
  );
}

/** Plan editor: large title + ⋯, week · active, workouts as grouped rows (tap = edit, ▶ = start), text links below. */
export function PlanPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const settings = useSettings();
  const plan = useLiveQuery(() => db.plans.get(id!), [id]);
  const workouts = useLiveQuery(async () => (plan ? (await db.workouts.bulkGet(plan.workoutIds)).filter((w) => w && alive(w)) as Workout[] : []), [plan]) ?? [];
  const exIdsKey = [...new Set(workouts.flatMap((w) => w.items.map((i) => i.exerciseId)))].join('|');
  const exMap = useLiveQuery(async () => Object.fromEntries((await db.exercises.bulkGet(exIdsKey ? exIdsKey.split('|') : [])).filter(Boolean).map((e) => [e!.id, e!])) as Record<string, Exercise>, [exIdsKey]) ?? {};
  const [naming, setNaming] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [menu, setMenu] = useState(false);
  const [dating, setDating] = useState(false);

  if (!plan || !alive(plan)) return null;
  const items = workouts.map((w) => ({ key: w.id, w }));
  const reorder = (next: typeof items) => run(plansReorder, { id: plan.id, workoutIds: next.map((x) => x.key) });
  // sessions.start returns the running workout instead if one is already live
  const start = async (wid: string) => { const { session } = await run(sessionsStart, { workoutId: wid }); nav(`/session/${session.id}`); };
  const active = settings.activePlanId === plan.id;
  const del = async () => {
    setMenu(false);
    if (!(await confirmDialog({ title: `Delete “${plan.name}”?`, message: 'Past workouts stay in your history.', confirm: 'Delete plan', danger: true }))) return;
    await run(plansDelete, { id: plan.id }); // also clears the active plan if it was this one
    nav('/plans');
  };

  return (
    <div className="page" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('/plans')}><Icon name="chevronLeft" /></button>
        <span className="grow" />
        {ordering && <button className="btn ghost" onClick={() => setOrdering(false)}>Done</button>}
      </header>
      <header className="title-more lt" style={{ marginTop: 0 }}>
        <h1>{plan.name}</h1>
        <button className="more-pill" aria-label="Plan options" onClick={() => setMenu(true)}><Icon name="more" size={22} stroke={3} /></button>
      </header>
      <div className="plan-meta">
        {settings.features.planWeek !== false && <button className="meta-btn num" onClick={() => setDating(true)} aria-haspopup="dialog" aria-label={`Week ${planWeek(plan)}. Change start date`}>Week {planWeek(plan)}</button>}
        {active
          ? <span className="badge accent"><Icon name="check" size={12} stroke={3} /><span>Active</span></span>
          : <button className="meta-btn role-text" onClick={() => run(plansSetActive, { id: plan.id })}><Icon name="flag" size={16} /> Set active</button>}
      </div>

      {items.length ? (
        <SortableList items={items} onReorder={reorder}>
          <div className="group">
            {items.map(({ key, w }, i) => (
              <SortableItem key={key} id={key}>
                <div className="pw-row">
                  <Link to={`/workouts/${w.id}`} className="pw-main pressable" aria-label={`Edit ${w.name}, ${plural(w.items.length, 'exercise', 'exercises')}, ${plural(totalSets(w), 'set', 'sets')}`}>
                    <span className="wk-no num" aria-hidden>{i + 1}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="wk-name ellipsis" style={{ display: 'block' }}>{w.name}</span>
                      {w.items.length
                        ? <span className="pw-sub"><ThumbPill ids={w.items.map((it) => it.exerciseId)} max={4} /></span>
                        : <span className="ex-row-sub">No exercises yet</span>}
                    </span>
                  </Link>
                  {ordering ? (
                    <span className="row" style={{ gap: 4 }}>
                      <button className="icon-btn filled" aria-label={`Move ${w.name} up`} disabled={i === 0} onClick={() => reorder(moveItem(items, i, -1))}><Icon name="chevronUp" size={18} /></button>
                      <button className="icon-btn filled" aria-label={`Move ${w.name} down`} disabled={i === items.length - 1} onClick={() => reorder(moveItem(items, i, 1))}><Icon name="chevronDown" size={18} /></button>
                    </span>
                  ) : (
                    <button className="icon-btn filled" aria-label={`Start ${w.name}`} onClick={() => start(w.id)}>
                      <Icon name="play" size={18} />
                    </button>
                  )}
                </div>
              </SortableItem>
            ))}
          </div>
        </SortableList>
      ) : (
        <div className="group empty compact">
          <Icon name="dumbbell" size={36} />
          <h3>No workouts yet</h3>
          <p>A workout is a list of exercises, like “Push A”.</p>
          <button className="btn primary" onClick={() => setNaming(true)}><Icon name="plus" size={18} /> Workout</button>
        </div>
      )}

      {/* one rotation = every workout of the plan once; workout keys are prefixed so slots of different workouts never merge */}
      <MuscleVolumeSection rows={muscleRows(plannedSetsByMuscle(workouts.flatMap((w) => w.items.map((i) => ({ ...i, key: `${w.id}:${i.key}` }))), exMap))}
        note={`All ${plural(workouts.length, 'workout', 'workouts')} once`} />

      <nav className="text-links" aria-label="Plan">
        {items.length > 0 && <button className="text-link" onClick={() => setNaming(true)}>New workout</button>}
        <Link className="text-link" to="/plans/all">All plans</Link>
        <Link className="text-link" to="/exercises">Exercises</Link>
      </nav>

      <PlanMenu open={menu} onClose={() => setMenu(false)} plan={plan} onDate={() => setDating(true)}
        footer={<div className="group"><button className="am-row pressable danger" onClick={del}><Icon name="trash" /><span className="grow">Delete plan</span></button></div>}>
        <div className="group">
          <button className="am-row pressable" onClick={() => { setMenu(false); setNaming(true); }}><Icon name="plus" /><span className="grow">New workout</span></button>
          {items.length > 1 && (
            <button className="am-row pressable" onClick={() => { setMenu(false); setOrdering(true); }}><Icon name="sort" /><span className="grow">Reorder</span></button>
          )}
          {!active && <button className="am-row pressable" onClick={() => { setMenu(false); run(plansSetActive, { id: plan.id }); }}><Icon name="flag" /><span className="grow">Set active</span></button>}
        </div>
      </PlanMenu>
      <StartDateSheet open={dating} onClose={() => setDating(false)} plan={plan} />
      <NameSheet open={naming} title="New workout" placeholder="e.g. Push A" onClose={() => setNaming(false)}
        onSubmit={async (name) => { const w = await run(workoutsCreate, { planId: plan.id, name }); nav(`/workouts/${w.id}`); }} />
    </div>
  );
}

export function NameSheet({ open, onClose, onSubmit, title, placeholder, initial = '' }: {
  open: boolean; onClose: () => void; onSubmit: (name: string) => void; title: string; placeholder?: string; initial?: string;
}) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState('');
  const inputId = useId(), errId = useId();
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) { setV(initial); setErr(''); } }
  const go = () => {
    if (!v.trim()) { setErr('Enter a name.'); document.getElementById(inputId)?.focus(); return; }
    onSubmit(v.trim()); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); go(); }}>
        <input id={inputId} className="input" value={v} onChange={(e) => { setV(e.target.value); setErr(''); }} placeholder={placeholder} aria-label={`${title}: name`} autoFocus enterKeyHint="done"
          aria-invalid={!!err} aria-describedby={err ? errId : undefined} />
        <p id={errId} className="field-err" role="status">{err}</p>
        <button className="btn primary lg block">Save</button>
      </form>
    </Sheet>
  );
}
