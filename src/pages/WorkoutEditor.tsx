import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog } from '../components/Dialog';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ExercisePicker, ExerciseThumb } from '../components/ExercisePicker';
import { Icon } from '../components/Icon';
import { ItemSettings } from '../components/ItemSettings';
import { Sheet } from '../components/Sheet';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db } from '../db/db';
import { useSettings } from '../db/settings';
import type { Exercise, WorkoutItem } from '../db/types';
import { run } from '../api/registry';
import { itemsAdd, itemsRemove, itemsReorder, itemsReplace, itemsSuperset, itemsUpdate, workoutsDelete, workoutsRename } from '../api/gym';
import { fmtDuration } from '../lib/format';
import { defaultRestSec } from '../lib/science';
import { NameSheet } from './Plans';
import { moveItem } from './Session';

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
  const t = { workoutId: workout.id };
  const reorder = (items: WorkoutItem[]) => run(itemsReorder, { ...t, itemKeys: items.map((i) => i.key) });
  const editing = workout.items.find((i) => i.key === editKey);
  const editIdx = workout.items.findIndex((i) => i.key === editKey);

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(`/plans/${workout.planId}`)}><Icon name="chevronLeft" /></button>
        <h1 className="small ellipsis">{workout.name}</h1>
        <button className="icon-btn" aria-label="Rename" onClick={() => setRenaming(true)}><Icon name="edit" size={20} /></button>
      </header>


      <SortableList items={workout.items} onReorder={reorder}>
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
        <div className="empty"><Icon name="dumbbell" size={40} /><h3>No exercises</h3></div>
      )}
      <button className="btn primary block lg" style={{ marginTop: 16 }} onClick={() => setPicking({})}><Icon name="plus" size={18} /> Exercise</button>
      <button className="btn danger block" style={{ marginTop: 32 }} onClick={async () => {
        if (!(await confirmDialog({ title: `Delete “${workout.name}”?`, message: "It is removed from this plan. Past sessions stay in your history.", confirm: "Delete workout", danger: true }))) return;
        await run(workoutsDelete, { id: workout.id });
        nav(`/plans/${workout.planId}`);
      }}><Icon name="trash" size={18} /> Delete</button>

      <ExercisePicker open={!!picking} multi={!picking?.replaceKey} title={picking?.replaceKey ? 'Replace exercise' : 'Add exercises'}
        onClose={() => setPicking(null)}
        onPick={(exs) => {
          if (picking?.replaceKey) run(itemsReplace, { ...t, itemKey: picking.replaceKey, exerciseId: exs[0].id });
          else if (exs.length) run(itemsAdd, { ...t, exerciseIds: exs.map((e) => e.id) });
        }} />

      <Sheet open={!!editing} onClose={() => setEditKey(undefined)} title={editing ? exMap[editing.exerciseId]?.name : ''}>
        {editing && (
          <>
            <ItemSettings item={editing} exercise={exMap[editing.exerciseId]} settings={settings}
              onChange={(n) => run(itemsUpdate, { ...t, itemKey: n.key, patch: itemPatch(editing, n) })} />
            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
              {editIdx < workout.items.length - 1 && (
                <button className="menu-item" onClick={() => run(itemsSuperset, { ...t, itemKey: editing.key })}>
                  <Icon name={editing.supersetId && editing.supersetId === workout.items[editIdx + 1]?.supersetId ? 'unlink' : 'link'} />
                  <span className="grow ellipsis">{editing.supersetId && editing.supersetId === workout.items[editIdx + 1]?.supersetId ? 'Unlink superset' : `Superset + ${exMap[workout.items[editIdx + 1].exerciseId]?.name ?? 'next'}`}</span>
                </button>
              )}
              {editIdx > 0 && <button className="menu-item" onClick={() => reorder(moveItem(workout.items, editIdx, -1))}><Icon name="chevronUp" />Move up</button>}
              {editIdx < workout.items.length - 1 && <button className="menu-item" onClick={() => reorder(moveItem(workout.items, editIdx, 1))}><Icon name="chevronDown" />Move down</button>}
              <button className="menu-item" onClick={() => { setPicking({ replaceKey: editing.key }); setEditKey(undefined); }}><Icon name="swap" />Replace</button>
              <button className="menu-item danger" onClick={() => { run(itemsRemove, { ...t, itemKey: editing.key }); setEditKey(undefined); }}><Icon name="trash" />Remove</button>
            </div>
          </>
        )}
      </Sheet>
      <NameSheet open={renaming} title="Rename workout" initial={workout.name} onClose={() => setRenaming(false)}
        onSubmit={(name) => run(workoutsRename, { id: workout.id, name })} />
    </div>
  );
}

/** ItemSettings hands back a whole edited item; items.update wants only the changed fields (null = cleared). */
export function itemPatch(before: WorkoutItem, after: WorkoutItem) {
  const p: { sets?: number; repsMin?: number | null; repsMax?: number | null; warmups?: number; drops?: number; rest?: WorkoutItem['rest']; notes?: string | null } = {};
  if (after.sets !== before.sets) p.sets = after.sets;
  if (after.repsMin !== before.repsMin) p.repsMin = after.repsMin ?? null;
  if (after.repsMax !== before.repsMax) p.repsMax = after.repsMax ?? null;
  if (after.warmups !== before.warmups && after.warmups != null) p.warmups = after.warmups;
  if (after.drops !== before.drops && after.drops != null) p.drops = after.drops;
  if (JSON.stringify(after.rest) !== JSON.stringify(before.rest)) p.rest = after.rest;
  if (after.notes !== before.notes) p.notes = after.notes ?? null;
  return p;
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
