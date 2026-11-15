import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ExercisePicker, ExerciseThumb } from '../components/ExercisePicker';
import { Icon } from '../components/Icon';
import { ItemSettings, normalizeSupersets, toggleSupersetWithNext } from '../components/ItemSettings';
import { Sheet } from '../components/Sheet';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db, remove, save } from '../db/db';
import { newItem } from '../db/gym';
import { useSettings } from '../db/settings';
import type { Exercise, Workout, WorkoutItem } from '../db/types';
import { fmtDuration } from '../lib/format';
import { defaultRestSec } from '../lib/science';
import { NameSheet } from './Plans';

export function WorkoutEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const settings = useSettings();
  const workout = useLiveQuery(() => db.workouts.get(id!), [id]);
  const exMap = useExerciseMap(workout?.items);
  const [picking, setPicking] = useState<null | { replaceKey?: string }>(null);
  const [editKey, setEditKey] = useState<string>();
  const [renaming, setRenaming] = useState(false);

  if (!workout || !alive(workout)) return null;
  const setItems = (items: WorkoutItem[]) => save('workouts', { ...workout, items: normalizeSupersets(items) } as Workout);
  const editing = workout.items.find((i) => i.key === editKey);
  const editIdx = workout.items.findIndex((i) => i.key === editKey);

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(`/plans/${workout.planId}`)}><Icon name="chevronLeft" /></button>
        <h1 className="small ellipsis">{workout.name}</h1>
        <button className="icon-btn" aria-label="Rename" onClick={() => setRenaming(true)}><Icon name="edit" size={20} /></button>
      </header>

      {workout.items.length > 1 && <p className="muted" style={{ margin: '0 4px 12px', fontSize: '0.875rem' }}>Hold and drag to reorder. Tap an exercise to set sets, reps, rest and supersets.</p>}

      <SortableList items={workout.items} onReorder={setItems}>
        <div className="stack" style={{ gap: 0 }}>
          {workout.items.map((it, i) => {
            const ex = exMap[it.exerciseId];
            const g = groupPos(workout.items, i);
            return (
              <SortableItem key={it.key} id={it.key} style={{ marginTop: g === 'mid' || g === 'last' ? 2 : i ? 8 : 0 }}>
                <button className="card pressable row" onClick={() => setEditKey(it.key)}
                  style={{ width: '100%', border: 0, textAlign: 'left', color: 'inherit', ...groupStyle(g) }}>
                  <ExerciseThumb ex={ex} />
                  <span className="grow">
                    <span style={{ fontWeight: 600, display: 'block' }} className="ellipsis">{ex?.name ?? '…'}</span>
                    <span className="muted" style={{ fontSize: '0.8125rem' }}>{summary(it, ex, settings)}</span>
                  </span>
                  {g === 'first' && <span className="badge accent">Superset</span>}
                  <Icon name="chevronRight" className="chev" size={18} />
                </button>
              </SortableItem>
            );
          })}
        </div>
      </SortableList>

      {!workout.items.length && (
        <div className="empty"><Icon name="dumbbell" size={40} /><h3>Add your first exercise</h3><p>Pick from about 680 exercises, or make your own.</p></div>
      )}
      <button className="btn primary block lg" style={{ marginTop: 16 }} onClick={() => setPicking({})}><Icon name="plus" size={18} /> Add exercises</button>
      <button className="btn danger block" style={{ marginTop: 32 }} onClick={async () => {
        if (!confirm(`Delete workout “${workout.name}”?`)) return;
        const plan = await db.plans.get(workout.planId);
        if (plan) await save('plans', { ...plan, workoutIds: plan.workoutIds.filter((x) => x !== workout.id) });
        await remove('workouts', workout.id);
        nav(`/plans/${workout.planId}`);
      }}>Delete workout</button>

      <ExercisePicker open={!!picking} multi={!picking?.replaceKey} title={picking?.replaceKey ? 'Replace exercise' : 'Add exercises'}
        onClose={() => setPicking(null)}
        onPick={(exs) => {
          if (picking?.replaceKey) setItems(workout.items.map((i) => (i.key === picking.replaceKey ? { ...i, exerciseId: exs[0].id, rest: { mode: i.rest.mode } } : i)));
          else setItems([...workout.items, ...exs.map(newItem)]);
        }} />

      <Sheet open={!!editing} onClose={() => setEditKey(undefined)} title={editing ? exMap[editing.exerciseId]?.name : ''}>
        {editing && (
          <>
            <ItemSettings item={editing} exercise={exMap[editing.exerciseId]} settings={settings}
              onChange={(n) => setItems(workout.items.map((i) => (i.key === n.key ? n : i)))} />
            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
              {editIdx < workout.items.length - 1 && (
                <button className="menu-item" onClick={() => setItems(toggleSupersetWithNext(workout.items, editIdx))}>
                  <Icon name={editing.supersetId && editing.supersetId === workout.items[editIdx + 1]?.supersetId ? 'unlink' : 'link'} />
                  {editing.supersetId && editing.supersetId === workout.items[editIdx + 1]?.supersetId ? 'Unlink from next exercise' : `Superset with ${exMap[workout.items[editIdx + 1].exerciseId]?.name ?? 'next'}`}
                </button>
              )}
              <button className="menu-item" onClick={() => { setPicking({ replaceKey: editing.key }); setEditKey(undefined); }}><Icon name="swap" />Replace exercise</button>
              <button className="menu-item danger" onClick={() => { setItems(workout.items.filter((i) => i.key !== editing.key)); setEditKey(undefined); }}><Icon name="trash" />Remove from workout</button>
            </div>
          </>
        )}
      </Sheet>
      <NameSheet open={renaming} title="Rename workout" initial={workout.name} onClose={() => setRenaming(false)}
        onSubmit={(name) => save('workouts', { ...workout, name })} />
    </div>
  );
}

export function useExerciseMap(items?: { exerciseId: string }[]) {
  return useLiveQuery(async () => {
    const ids = [...new Set((items ?? []).map((i) => i.exerciseId))];
    const ex = await db.exercises.bulkGet(ids);
    return Object.fromEntries(ex.filter(Boolean).map((e) => [e!.id, e!])) as Record<string, Exercise>;
  }, [items]) ?? {};
}

export type GroupPos = 'solo' | 'first' | 'mid' | 'last';
export function groupPos(items: WorkoutItem[], i: number): GroupPos {
  const id = items[i].supersetId;
  if (!id) return 'solo';
  const p = items[i - 1]?.supersetId === id, n = items[i + 1]?.supersetId === id;
  return p && n ? 'mid' : p ? 'last' : n ? 'first' : 'solo';
}
function groupStyle(g: GroupPos) {
  if (g === 'solo') return {};
  const rail = { boxShadow: 'inset 3px 0 0 var(--accent)' };
  if (g === 'first') return { ...rail, borderBottomLeftRadius: 4, borderBottomRightRadius: 4 };
  if (g === 'last') return { ...rail, borderTopLeftRadius: 4, borderTopRightRadius: 4 };
  return { ...rail, borderRadius: 4 };
}

function summary(it: WorkoutItem, ex: Exercise | undefined, s: ReturnType<typeof useSettings>) {
  const parts = [`${it.sets} × ${it.repsMin != null ? (it.repsMax && it.repsMax !== it.repsMin ? `${it.repsMin}–${it.repsMax}` : it.repsMin) : '—'}`];
  if (it.warmups) parts.push(`${it.warmups} warm-up`);
  if (it.drops) parts.push(`${it.drops} drop${it.drops > 1 ? 's' : ''}`);
  if (s.features.restTimer && ex) parts.push(it.rest.mode === 'countup' ? 'rest ↑' : `rest ${fmtDuration((it.rest.sec ?? defaultRestSec(ex.mechanic, s.restCompoundSec, s.restIsolationSec)) * 1000)}`);
  return parts.join(' · ');
}
