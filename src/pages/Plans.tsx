import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db, remove, save } from '../db/db';
import { createPlan, createWorkout, startSession, activeSession } from '../db/gym';
import { updateSettings, useSettings } from '../db/settings';
import type { Plan } from '../db/types';

export function PlansPage() {
  const settings = useSettings();
  const plans = useLiveQuery(() => db.plans.filter(alive).toArray(), []) ?? [];
  const [naming, setNaming] = useState(false);
  const nav = useNavigate();
  return (
    <div className="page">
      <header className="page-head">
        <h1>Plans</h1>
        <button className="icon-btn filled" aria-label="New plan" onClick={() => setNaming(true)}><Icon name="plus" /></button>
      </header>
      {plans.length ? (
        <div className="list">
          {plans.map((p) => (
            <Link key={p.id} to={`/plans/${p.id}`} className="list-item pressable">
              <span className="grow">
                <span className="title">{p.name}</span>
                <span className="sub" style={{ display: 'block' }}>{p.workoutIds.length} workout{p.workoutIds.length === 1 ? '' : 's'}</span>
              </span>
              {settings.activePlanId === p.id && <span className="badge accent">Active</span>}
              <Icon name="chevronRight" className="chev" size={18} />
            </Link>
          ))}
        </div>
      ) : (
        <div className="empty">
          <Icon name="dumbbell" size={40} />
          <h3>No plans yet</h3>
          <p>A plan is a list of workouts you rotate through.</p>
          <button className="btn primary" onClick={() => setNaming(true)}>Create a plan</button>
        </div>
      )}
      <NameSheet open={naming} title="New plan" placeholder="e.g. Upper / Lower" onClose={() => setNaming(false)}
        onSubmit={async (name) => { const p = await createPlan(name); nav(`/plans/${p.id}`); }} />
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
    return Object.fromEntries(ex.filter(Boolean).map((e) => [e!.id, e!.name]));
  }, [workouts]) ?? {};
  const [naming, setNaming] = useState<'workout' | 'rename' | null>(null);

  if (!plan) return null;
  const items = workouts.map((w) => ({ key: w.id, w }));
  const reorder = (next: typeof items) => save('plans', { ...plan, workoutIds: next.map((x) => x.key) });
  const start = async (wid: string) => {
    const cur = await activeSession();
    if (cur) return nav(`/session/${cur.id}`);
    const w = await db.workouts.get(wid);
    const s = await startSession(w);
    nav(`/session/${s.id}`);
  };

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('/plans')}><Icon name="chevronLeft" /></button>
        <h1 className="small ellipsis">{plan.name}</h1>
        <button className="icon-btn" aria-label="Rename" onClick={() => setNaming('rename')}><Icon name="edit" size={20} /></button>
      </header>

      {settings.activePlanId !== plan.id ? (
        <button className="btn block" style={{ marginBottom: 12 }} onClick={() => updateSettings({ activePlanId: plan.id })}>Make active plan</button>
      ) : <p className="muted" style={{ margin: '0 4px 12px', fontSize: '0.875rem' }}>Active plan · Home suggests the next workout in this order. Hold and drag to reorder.</p>}

      <SortableList items={items} onReorder={reorder}>
        <div className="stack">
          {items.map(({ key, w }) => (
            <SortableItem key={key} id={key} className="card">
              <div className="row">
                <Link to={`/workouts/${w.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <div style={{ fontWeight: 650, fontSize: '1.0625rem' }}>{w.name}</div>
                  <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 2 }}>
                    {w.items.length ? w.items.map((i) => exNames[i.exerciseId] ?? '…').join(' · ') : 'No exercises yet'}
                  </div>
                </Link>
                <button className="icon-btn filled" aria-label={`Start ${w.name}`} onClick={() => start(w.id)} style={{ color: 'var(--accent)' }}>
                  <Icon name="play" size={18} />
                </button>
              </div>
            </SortableItem>
          ))}
        </div>
      </SortableList>

      <button className="btn block" style={{ marginTop: 12 }} onClick={() => setNaming('workout')}><Icon name="plus" size={18} /> Add workout</button>
      <button className="btn danger block" style={{ marginTop: 32 }} onClick={async () => {
        if (!confirm(`Delete plan “${plan.name}”? Past workouts stay in your history.`)) return;
        await remove('plans', plan.id);
        if (settings.activePlanId === plan.id) await updateSettings({ activePlanId: undefined });
        nav('/plans');
      }}>Delete plan</button>

      <NameSheet open={naming === 'workout'} title="New workout" placeholder="e.g. Push A" onClose={() => setNaming(null)}
        onSubmit={async (name) => { const w = await createWorkout(plan, name); nav(`/workouts/${w.id}`); }} />
      <NameSheet open={naming === 'rename'} title="Rename plan" initial={plan.name} onClose={() => setNaming(null)}
        onSubmit={(name) => save('plans', { ...plan, name } as Plan)} />
    </div>
  );
}

export function NameSheet({ open, onClose, onSubmit, title, placeholder, initial = '' }: {
  open: boolean; onClose: () => void; onSubmit: (name: string) => void; title: string; placeholder?: string; initial?: string;
}) {
  const [v, setV] = useState(initial);
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) setV(initial); }
  const go = () => { if (!v.trim()) return; onSubmit(v.trim()); onClose(); };
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); go(); }}>
        <input className="input" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} autoFocus enterKeyHint="done" />
        <button className="btn primary lg block" disabled={!v.trim()}>Save</button>
      </form>
    </Sheet>
  );
}
