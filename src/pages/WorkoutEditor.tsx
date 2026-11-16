import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog } from '../components/Dialog';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ExerciseEditor, ExercisePicker } from '../components/ExercisePicker';
import { ExerciseMenu } from '../components/ExerciseMenu';
import { ExThumb } from '../components/ExThumb';
import { exerciseLabel, equipmentTag } from '../lib/equipment';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { SortableItem, SortableList } from '../components/Sortable';
import { itemExtras, setsReps } from '../components/WorkoutPreview';
import { alive, db } from '../db/db';
import { useSettings } from '../db/settings';
import type { Exercise, WorkoutItem } from '../db/types';
import { run } from '../api/registry';
import { itemsAdd, itemsRemove, itemsReorder, itemsReplace, itemsRestore, itemsSuperset, itemsUpdate, workoutsDelete, workoutsRename } from '../api/gym';
import { plural } from '../lib/format';
import { toast } from '../components/Toast';
import { NameSheet } from './Plans';
import { ExerciseInfo, moveItem } from './Session';

/** Workout editor: large title + ⋯, the exercises as grouped rows with photos (tap = the exercise sheet), text links below. */
export function WorkoutEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const settings = useSettings();
  const headId = useId();
  const workout = useLiveQuery(() => db.workouts.get(id!), [id]);
  const plan = useLiveQuery(async () => (workout ? db.plans.get(workout.planId) : undefined), [workout?.planId]);
  const exMap = useExerciseMap(workout?.items);
  const [picking, setPicking] = useState<null | { replaceKey?: string }>(null);
  const [menuKey, setMenuKey] = useState<string>();
  const [lastKey, setLastKey] = useState<string>(); // keeps the sheet's content while it animates out
  const [sub, setSub] = useState<'info' | 'editEx' | null>(null);
  const [more, setMore] = useState(false);
  const [renaming, setRenaming] = useState(false);

  if (!workout || !alive(workout)) return null;
  const t = { workoutId: workout.id };
  const items = workout.items;
  const reorder = (next: WorkoutItem[]) => run(itemsReorder, { ...t, itemKeys: next.map((i) => i.key) });
  const openMenu = (key: string) => { setMenuKey(key); setLastKey(key); };
  const shownKey = menuKey ?? lastKey;
  const current = items.find((i) => i.key === shownKey);
  const curIdx = items.findIndex((i) => i.key === shownKey);
  const ex = current ? exMap[current.exerciseId] : undefined;
  const sets = items.reduce((a, i) => a + i.sets, 0);
  const back = () => nav(`/plans/${workout.planId}`);

  const remove = async (removed: WorkoutItem, index: number) => {
    const supersetWith = removed.supersetId ? items.filter((i) => i.key !== removed.key && i.supersetId === removed.supersetId).map((i) => i.key) : undefined;
    setMenuKey(undefined);
    await run(itemsRemove, { ...t, itemKey: removed.key });
    toast(`${exerciseLabel(exMap[removed.exerciseId], 'Exercise')} removed`, () => run(itemsRestore, { workoutId: workout.id, index, item: { ...removed }, supersetWith }));
  };
  const del = async () => {
    setMore(false);
    if (!(await confirmDialog({ title: `Delete “${workout.name}”?`, message: 'It is removed from this plan. Past sessions stay in your history.', confirm: 'Delete workout', danger: true }))) return;
    await run(workoutsDelete, { id: workout.id });
    back();
  };

  return (
    <div className="page" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={back}><Icon name="chevronLeft" /></button>
      </header>
      <header className="title-more lt" style={{ marginTop: 0 }}>
        <h1 id={headId}>{workout.name}</h1>
        <button className="more-pill" aria-label={`${workout.name} options`} onClick={() => setMore(true)}><Icon name="more" size={22} stroke={3} /></button>
      </header>
      <div className="plan-meta muted">
        {plan && <span className="ellipsis">{plan.name}</span>}
        {items.length > 0 && <span className="num">{plural(items.length, 'exercise', 'exercises')} · {plural(sets, 'set', 'sets')}</span>}
      </div>

      {items.length ? (
        <SortableList items={items} onReorder={reorder}>
          <div className="group">
            {items.map((it, i) => {
              const e = exMap[it.exerciseId];
              const g = groupPos(items, i);
              return (
                <SortableItem key={it.key} id={it.key}>
                  <button className={'ex-row pressable' + (g !== 'solo' ? ' ss ss-' + g : '')} onClick={() => openMenu(it.key)} aria-haspopup="dialog">
                    <ExThumb ex={e} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="ex-row-name">{e?.name ?? '…'}</span>
                      <span className="ex-row-sub num">{summary(it, e, settings, g !== 'solo')}</span>
                    </span>
                    <Icon name="more" size={20} className="chev" />
                  </button>
                </SortableItem>
              );
            })}
          </div>
        </SortableList>
      ) : (
        <div className="group empty compact">
          <Icon name="dumbbell" size={36} />
          <h3>No exercises yet</h3>
          <p>Add the exercises you do in this workout.</p>
          <button className="btn primary" onClick={() => setPicking({})}><Icon name="plus" size={18} /> Exercises</button>
        </div>
      )}

      <nav className="text-links" aria-label="Workout">
        {items.length > 0 && <button className="text-link" onClick={() => setPicking({})}>Add exercises</button>}
        {plan && <Link className="text-link" to={`/plans/${plan.id}`}>{plan.name}</Link>}
      </nav>

      <ExercisePicker open={!!picking} multi={!picking?.replaceKey} title={picking?.replaceKey ? 'Replace exercise' : 'Add exercises'}
        onClose={() => setPicking(null)}
        onPick={(exs) => {
          if (picking?.replaceKey) run(itemsReplace, { ...t, itemKey: picking.replaceKey, exerciseId: exs[0].id });
          else if (exs.length) run(itemsAdd, { ...t, exerciseIds: exs.map((x) => x.id) });
        }} />

      {current && (
        <ExerciseMenu open={!!menuKey && !sub} onClose={() => setMenuKey(undefined)} item={current} ex={ex} settings={settings}
          nextEx={curIdx < items.length - 1 ? exMap[items[curIdx + 1].exerciseId] ?? null : undefined}
          linked={!!current.supersetId && current.supersetId === items[curIdx + 1]?.supersetId}
          canLeft={curIdx > 0} canRight={curIdx < items.length - 1}
          onChange={(n) => run(itemsUpdate, { ...t, itemKey: n.key, patch: itemPatch(current, n) })}
          onSuperset={() => run(itemsSuperset, { ...t, itemKey: current.key })}
          onMove={(d) => reorder(moveItem(items, curIdx, d))}
          onInfo={() => setSub('info')}
          onEditEx={() => setSub('editEx')}
          onAdd={() => { setMenuKey(undefined); setPicking({}); }}
          onReplace={() => { setMenuKey(undefined); setPicking({ replaceKey: current.key }); }}
          onRemove={() => remove(current, curIdx)} />
      )}
      <Sheet open={!!menuKey && sub === 'info'} onClose={() => setSub(null)} title={ex && exerciseLabel(ex)}>
        {ex && <ExerciseInfo ex={ex} />}
      </Sheet>
      <ExerciseEditor open={!!menuKey && sub === 'editEx'} exercise={ex} onClose={() => setSub(null)} />

      <Sheet open={more} onClose={() => setMore(false)} title={workout.name}>
        <div className="am">
          <div className="group">
            <button className="am-row pressable" onClick={() => { setMore(false); setPicking({}); }}><Icon name="plus" /><span className="grow">Add exercises</span></button>
            <button className="am-row pressable" onClick={() => { setMore(false); setRenaming(true); }}><Icon name="pencil" /><span className="grow">Rename</span></button>
          </div>
          <div className="group">
            <button className="am-row pressable danger" onClick={del}><Icon name="trash" /><span className="grow">Delete workout</span></button>
          </div>
        </div>
      </Sheet>
      <NameSheet open={renaming} title="Rename workout" initial={workout.name} onClose={() => setRenaming(false)}
        onSubmit={(name) => run(workoutsRename, { id: workout.id, name })} />
    </div>
  );
}

/** The exercise sheet hands back a whole edited item; items.update wants only the changed fields (null = cleared). */
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

/** "Dumbbell · 3 × 8–12 reps · 1 drop set" (rest and the note live in the exercise sheet) */
function summary(it: WorkoutItem, ex: Exercise | undefined, s: ReturnType<typeof useSettings>, inSuperset: boolean) {
  return [equipmentTag(ex), setsReps(it), ...itemExtras(it, s.features.warmups, inSuperset)].filter(Boolean).join(' · ');
}
