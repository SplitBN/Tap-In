// Workout preview sheet (opened from the Gym tab): title + ⋯, plan, "N exercises · N sets", one big Start,
// muscle map, and the exercise list. Modelled on docs/design-refs/alpha-workout-preview.png.
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { run } from '../api/registry';
import { sessionsStart, workoutsRename } from '../api/gym';
import { alive, db } from '../db/db';
import { activeSession } from '../db/gym';
import { useSettings } from '../db/settings';
import type { Exercise, WorkoutItem } from '../db/types';
import { equipmentTag } from '../lib/equipment';
import { plural } from '../lib/format';
import { NameSheet } from '../pages/Plans';
import { groupPos } from '../pages/WorkoutEditor';
import { Icon } from './Icon';
import { MuscleMap, musclesOf } from './MuscleMap';
import { ExThumb } from './ExThumb';
import { Sheet } from './Sheet';

/** "2 × 8–12" (sets × reps), "3 sets" without a rep target */
export function setsReps(it: Pick<WorkoutItem, 'sets' | 'repsMin' | 'repsMax'>) {
  if (it.repsMin == null) return plural(it.sets, 'set', 'sets');
  const reps = it.repsMax != null && it.repsMax !== it.repsMin ? `${it.repsMin}–${it.repsMax}` : String(it.repsMin);
  return `${it.sets} × ${reps} reps`;
}

/** Extra notes after sets × reps: warm-ups, drop sets, superset. */
export function itemExtras(it: WorkoutItem, warmupsOn: boolean, inSuperset: boolean) {
  const out: string[] = [];
  if (warmupsOn && it.warmups) out.push(plural(it.warmups, 'warm-up', 'warm-ups'));
  if (it.drops) out.push(plural(it.drops, 'drop set', 'drop sets'));
  if (inSuperset) out.push('superset');
  return out;
}

export function WorkoutPreview({ workoutId, planName, planWeek, onClose }: { workoutId: string | null; planName?: string; planWeek?: number; onClose: () => void }) {
  const nav = useNavigate();
  const settings = useSettings();
  const headId = useId();
  const w = useLiveQuery(async () => (workoutId ? (await db.workouts.get(workoutId)) ?? null : null), [workoutId]);
  const exs = useLiveQuery(async () => {
    if (!w) return {} as Record<string, Exercise>;
    const list = await db.exercises.bulkGet(w.items.map((i) => i.exerciseId));
    return Object.fromEntries(list.filter(Boolean).map((e) => [e!.id, e!])) as Record<string, Exercise>;
  }, [w]) ?? {};
  const live = useLiveQuery(() => activeSession(), []);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const open = !!workoutId && !!w && alive(w);
  const items = w?.items ?? [];
  const totalSets = items.reduce((a, i) => a + i.sets, 0);
  const { primary, secondary } = musclesOf(items.map((i) => exs[i.exerciseId]));
  const resume = !!live;

  const start = async () => {
    if (!w) return;
    const { session } = await run(sessionsStart, { workoutId: w.id }); // returns the running workout if one is live
    onClose();
    nav(`/session/${session.id}`);
  };

  return (
    <>
      <Sheet open={open} onClose={onClose} role="gym" labelledBy={headId}>
        {w && (
          <div className="pv">
            <div className="pv-top">
              <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
            </div>
            <div className="title-more pv-head">
              <h2 id={headId} className="pv-title">{w.name}</h2>
              <button className="more-pill" aria-label={`${w.name} options`} onClick={() => setMenu(true)}><Icon name="more" size={22} stroke={3} /></button>
            </div>
            <div className="pv-hero">
              <div className="grow" style={{ minWidth: 0 }}>
                {planName && <div className="pv-meta row" style={{ gap: 0 }}><span className="ellipsis">{planName}</span>{planWeek ? <span className="num" style={{ flex: 'none', whiteSpace: 'pre' }}> · Week {planWeek}</span> : null}</div>}
                <div className="pv-meta num">{plural(items.length, 'exercise', 'exercises')} · {plural(totalSets, 'set', 'sets')}</div>
                <button className="btn primary lg pv-start" onClick={start} disabled={!items.length && !resume}>
                  <Icon name="play" size={20} />{resume ? 'Resume' : 'Start'}
                </button>
              </div>
              {primary.length > 0 && <MuscleMap primary={primary} secondary={secondary} height={120} />}
            </div>

            {items.length ? (
              <div className="group pv-list">
                {items.map((it, i) => {
                  const ex = exs[it.exerciseId];
                  const g = groupPos(items, i);
                  const extras = itemExtras(it, settings.features.warmups, g !== 'solo');
                  return (
                    <div key={it.key} className={'ex-row' + (g !== 'solo' ? ' ss ss-' + g : '')}>
                      <ExThumb ex={ex} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="ex-row-name">{ex?.name ?? '…'}</span>
                        <span className="ex-row-sub num">{[equipmentTag(ex), setsReps(it), ...extras].filter(Boolean).join(' · ')}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : <p className="muted" style={{ margin: '20px 4px' }}>No exercises yet.</p>}

            <nav className="text-links" aria-label="Workout">
              <button className="text-link" onClick={() => { onClose(); nav(`/workouts/${w.id}`); }}>Edit workout</button>
            </nav>
          </div>
        )}
      </Sheet>
      <Sheet open={menu && open} onClose={() => setMenu(false)} title={w?.name}>
        <div className="menu-group">
          <button className="menu-item" onClick={() => { setMenu(false); onClose(); nav(`/workouts/${w!.id}`); }}><Icon name="edit" />Edit exercises</button>
          <button className="menu-item" onClick={() => { setMenu(false); setRenaming(true); }}><Icon name="pencil" />Rename</button>
        </div>
      </Sheet>
      <NameSheet open={renaming} title="Rename workout" initial={w?.name ?? ''} onClose={() => setRenaming(false)}
        onSubmit={(name) => w && run(workoutsRename, { id: w.id, name })} />
    </>
  );
}
