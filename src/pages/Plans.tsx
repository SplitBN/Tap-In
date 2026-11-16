import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog } from '../components/Dialog';
import { useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db } from '../db/db';
import { activeSession, nextWorkoutId } from '../db/gym';
import type { Plan, Workout } from '../db/types';
import { ThumbPill } from '../components/ExThumb';
import { WorkoutPreview } from '../components/WorkoutPreview';
import { useToday } from '../lib/today';
import { useTick } from '../lib/rest';
import { moveItem } from './Session';
import { equipmentTag } from '../lib/equipment';
import { fmtDuration, plural } from '../lib/format';
import { useSettings } from '../db/settings';
import { run } from '../api/registry';
import { plansCreate, plansDelete, plansRename, plansReorder, plansSetActive, sessionsStart, workoutsCreate } from '../api/gym';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/** Gym tab: week strip, the active plan as a large title with ⋯, its workouts (tap = preview), then plain links. */
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
  const now = useTick(!!live, 1000);

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
          </div>
        </>
      )}

      <nav className="text-links" aria-label="Gym">
        {plans.length > 0 && <Link className="text-link" to="/plans/all">All plans</Link>}
        <Link className="text-link" to="/exercises">Exercises</Link>
        <Link className="text-link" to="/stats">Stats</Link>
        <Link className="text-link" to="/history">History</Link>
      </nav>

      <WorkoutPreview workoutId={preview} planName={plan?.name} onClose={() => setPreview(null)} />
      <Sheet open={menu && !!plan} onClose={() => setMenu(false)} title={plan?.name}>
        <div className="menu-group">
          <button className="menu-item" onClick={() => { setMenu(false); nav(`/plans/${plan!.id}`); }}><Icon name="edit" />Edit plan</button>
          <button className="menu-item" onClick={() => { setMenu(false); setNaming('workout'); }}><Icon name="plus" />New workout</button>
        </div>
        <div className="menu-group">
          <button className="menu-item" onClick={() => { setMenu(false); nav('/plans/all'); }}><Icon name="swap" />Switch plan</button>
          <button className="menu-item" onClick={async () => { setMenu(false); const { session } = await run(sessionsStart, {}); nav(`/session/${session.id}`); }}><Icon name="play" />{live ? 'Resume workout' : 'Empty workout'}</button>
        </div>
      </Sheet>
      <NameSheet open={naming === 'plan'} title="New plan" placeholder="e.g. Upper / Lower" onClose={() => setNaming(null)}
        onSubmit={async (name) => { const p = await run(plansCreate, { name }); nav(`/plans/${p.id}`); }} />
      <NameSheet open={naming === 'workout'} title="New workout" placeholder="e.g. Push A" onClose={() => setNaming(null)}
        onSubmit={async (name) => { if (!plan) return; const w = await run(workoutsCreate, { planId: plan.id, name }); nav(`/workouts/${w.id}`); }} />
    </div>
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
  const plans = useLiveQuery(() => db.plans.filter(alive).toArray(), []) ?? [];
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
        </div>
      )}
      <NameSheet open={naming} title="New plan" placeholder="e.g. Upper / Lower" onClose={() => setNaming(false)}
        onSubmit={async (name) => { const p = await run(plansCreate, { name }); nav(`/plans/${p.id}`); }} />
    </div>
  );
}

export function PlanPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const settings = useSettings();
  const plan = useLiveQuery(() => db.plans.get(id!), [id]);
  const workouts = useLiveQuery(async () => (plan ? (await db.workouts.bulkGet(plan.workoutIds)).filter(alive) : []), [plan]) ?? [];
  const exNames = useLiveQuery(async () => {
    const ids = [...new Set(workouts.flatMap((w) => w.items.map((i) => i.exerciseId)))];
    const ex = await db.exercises.bulkGet(ids);
    // "Bench Press (Dumbbell)": the list is joined with " · ", so the equipment tag goes in brackets here
    return Object.fromEntries(ex.filter(Boolean).map((e) => { const tag = equipmentTag(e); return [e!.id, tag ? `${e!.name} (${tag})` : e!.name]; }));
  }, [workouts]) ?? {};
  const [naming, setNaming] = useState<'workout' | 'rename' | null>(null);
  const [ordering, setOrdering] = useState(false);

  if (!plan) return null;
  const items = workouts.map((w) => ({ key: w.id, w }));
  const reorder = (next: typeof items) => run(plansReorder, { id: plan.id, workoutIds: next.map((x) => x.key) });
  // sessions.start returns the running workout instead if one is already live
  const start = async (wid: string) => { const { session } = await run(sessionsStart, { workoutId: wid }); nav(`/session/${session.id}`); };

  return (
    <div className="page" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('/plans')}><Icon name="chevronLeft" /></button>
        <h1 className="small ellipsis">{plan.name}</h1>
        {items.length > 1 && <button aria-label={ordering ? "Done reordering" : "Reorder workouts"} aria-pressed={ordering} onClick={() => setOrdering(!ordering)} className={'icon-btn' + (ordering ? ' tint' : '')}><Icon name={ordering ? 'check' : 'swap'} size={20} style={{ rotate: ordering ? '0deg' : '90deg' }} /></button>}
        <button className="icon-btn" aria-label="Rename" onClick={() => setNaming('rename')}><Icon name="edit" size={20} /></button>
      </header>

      {settings.activePlanId !== plan.id ? (
        <button className="btn block" style={{ marginBottom: 12 }} onClick={() => run(plansSetActive, { id: plan.id })}><Icon name="flag" size={16} /> Set active</button>
      ) : <div style={{ margin: '0 4px 12px' }}><span className="badge accent"><Icon name="flag" size={12} /> Active</span></div>}

      <SortableList items={items} onReorder={reorder}>
        <div className="stack">
          {items.map(({ key, w }, i) => (
            <SortableItem key={key} id={key} className="card">
              <div className="row">
                <Link to={`/workouts/${w.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <div style={{ fontWeight: 650, fontSize: '1.0625rem' }}>{w.name}</div>
                  <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 2 }}>
                    {w.items.length ? w.items.map((i) => exNames[i.exerciseId] ?? '…').join(' · ') : 'No exercises yet'}
                  </div>
                </Link>
                {ordering ? (
                  <>
                    <button className="icon-btn filled" aria-label={`Move ${w.name} up`} disabled={i === 0} onClick={() => reorder(moveItem(items, i, -1))}><Icon name="chevronUp" size={18} /></button>
                    <button className="icon-btn filled" aria-label={`Move ${w.name} down`} disabled={i === items.length - 1} onClick={() => reorder(moveItem(items, i, 1))}><Icon name="chevronDown" size={18} /></button>
                  </>
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

      <button className="btn block" style={{ marginTop: 12 }} onClick={() => setNaming('workout')}><Icon name="plus" size={18} /> New workout</button>
      <button className="btn danger block" style={{ marginTop: 32 }} onClick={async () => {
        if (!(await confirmDialog({ title: `Delete “${plan.name}”?`, message: "Past workouts stay in your history.", confirm: "Delete plan", danger: true }))) return;
        await run(plansDelete, { id: plan.id }); // also clears the active plan if it was this one
        nav('/plans');
      }}><Icon name="trash" size={18} /> Delete</button>

      <NameSheet open={naming === 'workout'} title="New workout" placeholder="e.g. Push A" onClose={() => setNaming(null)}
        onSubmit={async (name) => { const w = await run(workoutsCreate, { planId: plan.id, name }); nav(`/workouts/${w.id}`); }} />
      <NameSheet open={naming === 'rename'} title="Rename plan" initial={plan.name} onClose={() => setNaming(null)}
        onSubmit={(name) => run(plansRename, { id: plan.id, name })} />
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
