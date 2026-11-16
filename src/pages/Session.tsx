import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog } from '../components/Dialog';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { createPortal } from 'react-dom';
import { ExercisePicker, ExerciseEditor, ExerciseThumb } from '../components/ExercisePicker';
import { equipmentLabel, equipmentTag, exerciseLabel } from '../lib/equipment';
import { Icon } from '../components/Icon';
import { ItemSettings } from '../components/ItemSettings';
import { EffortSheet, RepsSheet, WeightSheet } from '../components/SetInputs';
import { Sheet } from '../components/Sheet';
import { WorkoutSummary } from '../components/WorkoutSummary';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db } from '../db/db';
import { lastPerformance, latestBodyweightKg, sessionDiffersFromPlan, setOrder } from '../db/gym';
import { run } from '../api/registry';
import { exercisesNextTarget, itemsAdd, itemsRemove, itemsReorder, itemsReplace, itemsSuperset, itemsUpdate, sessionsDelete, sessionsFinish, sessionsLiveProgress, sessionsUpdate, setBeyond, setsLog, setsUpdate, type LiveProgress, type NextTarget, type SetBadge } from '../api/gym';
import { exerciseImage } from '../db/seed';
import { useSettings } from '../db/settings';
import type { Exercise, Session, SetKind, SetLog, Settings, Side, WorkoutItem } from '../db/types';
import { fmtDuration, fmtNum, fmtWeight, relDay, titleCase } from '../lib/format';
import { rest, useRest, useTick, useWakeLock } from '../lib/rest';
import { defaultRestSec, suggestDrop, defaultStepKg, fromKg, rirToRpe, snappedStepKg } from '../lib/science';
import { workingSetCount } from '../lib/workoutStats';
import { groupPos, itemPatch, useExerciseMap } from './WorkoutEditor';

interface Row { kind: SetKind; setNo: number; dropNo?: number; side: Side }
const rowId = (r: Row) => `${r.kind}:${r.setNo}:${r.dropNo ?? 0}:${r.side}`;
const logId = (l: SetLog) => `${l.kind}:${l.setNo}:${l.dropNo ?? 0}:${l.side}`;

function rowsFor(it: WorkoutItem, ex: Exercise | undefined, s: Settings): Row[][] {
  const sides: Side[] = ex?.unilateral ? ['left', 'right'] : ['both'];
  const groups: Row[][] = [];
  if (s.features.warmups) for (let n = 1; n <= (it.warmups ?? 0); n++) groups.push(sides.map((side) => ({ kind: 'warmup', setNo: n, side })));
  for (let n = 1; n <= it.sets; n++) {
    groups.push(sides.map((side) => ({ kind: 'working', setNo: n, side })));
    for (let d = 1; d <= (it.drops ?? 0); d++) groups.push(sides.map((side) => ({ kind: 'drop', setNo: n, dropNo: d, side })));
  }
  return groups;
}

/** Every working row of the slot is checked off. */
function itemDone(it: WorkoutItem, ex: Exercise | undefined, s: Settings, sets: SetLog[]) {
  const need = rowsFor(it, ex, s).flat().filter((r) => r.kind === 'working');
  return need.length > 0 && need.every((r) => sets.some((l) => l.itemKey === it.key && logId(l) === rowId(r) && l.doneAt));
}

/** items.update, but asks first when fewer sets / warm-ups / drops would delete sets already checked off. */
async function updateItemChecked(sessionId: string, before: WorkoutItem, patch: ReturnType<typeof itemPatch>, sets: SetLog[], beforeConfirm?: () => void) {
  const next = { ...before, ...patch } as WorkoutItem;
  const lost = sets.filter((x) => x.doneAt && setBeyond(x, next));
  if (lost.length) {
    beforeConfirm?.();
    if (!(await confirmDialog({ title: `Delete ${lost.length} done set${lost.length === 1 ? '' : 's'}?`, message: 'Removing sets also deletes what was logged in them.', confirm: 'Delete', danger: true }))) return;
  }
  await run(itemsUpdate, { sessionId, itemKey: before.key, patch });
}

export function SessionPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const settings = useSettings();
  const session = useLiveQuery(async () => (await db.sessions.get(id!)) ?? null, [id]); // undefined = loading, null = no such workout
  const sets = useLiveQuery(() => db.sets.where('sessionId').equals(id!).filter(alive).toArray(), [id]) ?? [];
  const exMap = useExerciseMap(session?.items);
  const live = !!session && !session.endedAt;
  useWakeLock(live);
  const now = useTick(live, 1000);
  // running totals + per-set ↑ / PR badges, computed on read from the logged sets (same counting as the summary)
  const progress = useLiveQuery(() => (id ? run(sessionsLiveProgress, { id }).catch(() => null) : Promise.resolve(null)), [id]);
  // light haptic when a newly ticked set earns ↑ / PR (Android; iOS has no vibration API). Lives here, not in the exercise
  // panel, because the last set of an exercise moves on to the next one. Badges already there on load never vibrate.
  const badged = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!progress) return;
    const now = progress.sets.filter((x) => x.badge).map((x) => x.setId);
    const seen = badged.current;
    if (seen && now.some((sid) => !seen.has(sid))) navigator.vibrate?.(10);
    badged.current = new Set(now);
  }, [progress]);

  const [menu, setMenu] = useState<'item' | 'session' | 'finish' | 'info' | 'editEx' | 'details' | null>(null);
  const [picking, setPicking] = useState<null | 'add' | 'replace'>(null);
  // summary sheet: 'finish' right after finishing (Done goes Home), 'view' for a past session (Done just closes)
  const [summary, setSummary] = useState<null | 'finish' | 'view'>(null);

  // stop a rest timer left over from another workout (e.g. a new one was started)
  const restSt = useRest();
  const liveId = live ? session.id : undefined;
  useEffect(() => { if (liveId && restSt && restSt.sessionId !== liveId) rest.stop(); }, [liveId, restSt]);

  // back: return where the user came from when there is in-app history, else the obvious parent
  const back = () => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav(live ? '/' : '/history'));

  if (session === undefined) return null; // loading (a frame)
  if (!session || !alive(session)) {
    return (
      <div className="page no-tabs">
        <header className="row" style={{ paddingTop: 'calc(var(--safe-t) + 6px)' }}>
          <button className="icon-btn" aria-label="Back" onClick={back}><Icon name="chevronLeft" /></button>
        </header>
        <div className="empty">
          <Icon name="dumbbell" size={40} />
          <h3>{session ? 'Workout deleted' : 'Workout not found'}</h3>
          <p>{session ? 'This workout was deleted.' : 'It may have been deleted on another device.'}</p>
          <Link className="btn primary" to="/history">History</Link>
        </div>
      </div>
    );
  }

  const items = session.items;
  const current = items.find((i) => i.key === session.currentKey) ?? items[0];
  const curIdx = items.findIndex((i) => i.key === current?.key);
  const ex = current ? exMap[current.exerciseId] : undefined;
  const t = { sessionId: session.id };
  const select = (key: string) => run(sessionsUpdate, { id: session.id, currentItemKey: key });
  const reorder = (next: WorkoutItem[]) => run(itemsReorder, { ...t, itemKeys: next.map((i) => i.key) });

  // a slot kept only for a replaced exercise's done sets counts as done
  const isDone = (it: WorkoutItem) => !!it.replacedBy || itemDone(it, exMap[it.exerciseId], settings, sets);
  const doneCount = workingSetCount(sets.filter((s) => s.doneAt)); // same counting as the summary

  return (
    <div className="page no-tabs" style={{ paddingTop: 0, paddingBottom: "calc(var(--safe-b) + 110px)" }}>
      {/* header */}
      <header style={{ position: 'sticky', top: 0, zIndex: 10, margin: '0 -16px', padding: 'calc(var(--safe-t) + 6px) 8px 8px',
        background: 'var(--chrome)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)' }}>
        <div className="row">
          <button className="icon-btn" aria-label="Back" onClick={back}><Icon name="chevronLeft" /></button>
          <div className="grow" style={{ textAlign: 'center' }}>
            <div className="ellipsis" style={{ fontWeight: 650 }}>{session.name}</div>
            <div className="num muted live-stats" style={{ fontSize: '0.8125rem' }}>
              {live ? <>
                <span>{fmtDuration(now - session.startedAt)}</span>
                {progress && <>
                  <span aria-label={`${progress.totals.workingSetsDone} of ${progress.totals.workingSetsPlanned} sets done`}>{progress.totals.workingSetsDone}/{progress.totals.workingSetsPlanned}</span>
                  <span aria-label="Volume">{Math.round(fromKg(progress.totals.volumeKg, settings.unit)).toLocaleString()} {settings.unit}</span>
                </>}
              </> : `${relDay(session.startedAt)} · ${fmtDuration((session.endedAt ?? now) - session.startedAt)}`}
            </div>
          </div>
          {!live && <button className="icon-btn" aria-label="Workout summary" onClick={() => setSummary('view')}><Icon name="chart" /></button>}
          <button className="icon-btn" aria-label="Workout options" onClick={() => setMenu('session')}><Icon name="more" /></button>
          {live && <button className="round-btn finish" aria-label="Finish workout" onClick={() => setMenu('finish')}><Icon name="flag" size={18} stroke={2.2} /></button>}
        </div>
        <ExerciseStrip items={items} exMap={exMap} currentKey={current?.key} isDone={isDone}
          onSelect={select} onReorder={reorder} onAdd={() => setPicking('add')} />
      </header>

      {current && ex ? (
        <ExercisePanel key={current.key} session={session} item={current} ex={ex} sets={sets.filter((s) => s.itemKey === current.key)}
          replaced={current.replacedBy ? exMap[items.find((i) => i.key === current.replacedBy)?.exerciseId ?? ''] ?? null : undefined}
          settings={settings} onMenu={() => setMenu('item')} progress={progress ?? undefined}
          onSetDone={(row) => afterSetDone(row, current, session.id, items, exMap, settings, live, select)} />
      ) : (
        <div className="empty">
          <Icon name="dumbbell" size={40} />
          <h3>Empty workout</h3>
          <p>Add exercises as you go.</p>
          <button className="btn primary" onClick={() => setPicking('add')}><Icon name="plus" size={18} /> Add exercise</button>
        </div>
      )}

      {live && settings.features.restTimer && <RestBar />}

      {/* item menu: everything editable in a plan is editable here */}
      <Sheet open={menu === 'item' && !!current} onClose={() => setMenu(null)} title={ex && exerciseLabel(ex)}>
        {current && (
          <>
            <ItemSettings item={current} exercise={ex} settings={settings}
              onChange={(n) => updateItemChecked(session.id, current, itemPatch(current, n), sets, () => setMenu(null))} />
            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
              {curIdx < items.length - 1 && (() => {
                const linked = !!current.supersetId && current.supersetId === items[curIdx + 1]?.supersetId;
                return <button className="menu-item" onClick={() => run(itemsSuperset, { ...t, itemKey: current.key })}>
                  <Icon name={linked ? 'unlink' : 'link'} /><span className="grow ellipsis">{linked ? 'Unlink superset' : `Superset + ${exerciseLabel(exMap[items[curIdx + 1].exerciseId], 'next')}`}</span>
                </button>;
              })()}
              <button className="menu-item" onClick={async () => {
                setMenu(null);
                const doneN = workingSetCount(sets.filter((x) => x.itemKey === current.key && x.doneAt));
                if (doneN && !(await confirmDialog({ title: `Replace ${exerciseLabel(ex, 'exercise')}?`,
                  message: `Its ${doneN} done set${doneN === 1 ? '' : 's'} stay${doneN === 1 ? 's' : ''} in this workout as ${exerciseLabel(ex, 'this exercise')}. The new exercise starts fresh.`, confirm: 'Replace' }))) return;
                setPicking('replace');
              }}><Icon name="swap" />Replace</button>
              <button className="menu-item" onClick={() => setMenu('info')}><Icon name="info" />How-to</button>
              <button className="menu-item" onClick={() => setMenu('editEx')}><Icon name="edit" />Edit exercise</button>
              {curIdx > 0 && <button className="menu-item" onClick={() => reorder(moveItem(items, curIdx, -1))}><Icon name="chevronLeft" />Move left</button>}
              {curIdx < items.length - 1 && <button className="menu-item" onClick={() => reorder(moveItem(items, curIdx, 1))}><Icon name="chevronRight" />Move right</button>}
              <button className="menu-item danger" onClick={async () => {
                const mine = sets.filter((x) => x.itemKey === current.key);
                const doneN = mine.filter((x) => x.doneAt).length;
                if (doneN) {
                  setMenu(null);
                  if (!(await confirmDialog({ title: `Remove ${exerciseLabel(ex, 'exercise')}?`, message: `Its ${doneN} logged set${doneN === 1 ? '' : 's'} will be deleted.`, confirm: 'Remove exercise', danger: true }))) return;
                }
                await run(itemsRemove, { ...t, itemKey: current.key }); setMenu(null);
              }}><Icon name="trash" />Remove</button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet open={menu === 'info'} onClose={() => setMenu(null)} title={ex && exerciseLabel(ex)}>
        {ex && <ExerciseInfo ex={ex} />}
      </Sheet>
      <ExerciseEditor open={menu === 'editEx'} exercise={ex} onClose={() => setMenu(null)} />

      <Sheet open={menu === 'session'} onClose={() => setMenu(null)} title="Workout">
        <button className="menu-item" onClick={() => { setMenu(null); setPicking('add'); }}><Icon name="plus" />Add exercise</button>
        {!live && <button className="menu-item" onClick={() => { setMenu(null); setSummary('view'); }}><Icon name="chart" />Summary</button>}
        <button className="menu-item" onClick={() => setMenu('details')}><Icon name="edit" />Name, date & time</button>
        <NotesField value={session.notes} onChange={(notes) => run(sessionsUpdate, { id: session.id, notes: notes ?? null })} />
        {!live && <button className="menu-item" onClick={() => run(sessionsUpdate, { id: session.id, resume: true })}><Icon name="play" />Resume this workout</button>}
        <button className="menu-item danger" onClick={async () => {
          setMenu(null);
          if (!(await confirmDialog(live ? { title: 'Discard this workout?', message: 'All sets logged in it are deleted.', confirm: 'Discard workout', danger: true } : { title: 'Delete this workout?', message: 'It is removed from your history.', confirm: 'Delete workout', danger: true }))) return;
          await run(sessionsDelete, { id: session.id }); rest.stop(); nav('/');
        }}><Icon name="trash" />{live ? 'Discard workout' : 'Delete workout'}</button>
      </Sheet>

      <DetailsSheet open={menu === 'details'} onClose={() => setMenu(null)} session={session} onSave={(p) => run(sessionsUpdate, { id: session.id, ...p })} />
      <FinishSheet open={menu === 'finish'} onClose={() => setMenu(null)} session={session} doneCount={doneCount} sets={sets}
        onFinished={() => { rest.stop(); nav(`/session/${session.id}`, { replace: true }); setSummary('finish'); }} />
      <WorkoutSummary open={!!summary} sessionId={session.id} onClose={() => setSummary(null)}
        onDone={() => { const fromFinish = summary === 'finish'; setSummary(null); if (fromFinish) nav('/'); }} />

      <ExercisePicker open={!!picking} title={picking === 'replace' ? 'Replace exercise' : 'Add exercise'} onClose={() => setPicking(null)}
        onPick={async ([e]) => {
          if (picking === 'replace' && current) {
            await run(itemsReplace, { ...t, itemKey: current.key, exerciseId: e.id });
          } else {
            await run(itemsAdd, { ...t, exerciseIds: [e.id], makeCurrent: true });
          }
        }} />
    </div>
  );
}

/** After a set is checked: start rest, move through supersets, and move on once an exercise is finished.
 *  Reads the sets fresh from the db: the screen's copy doesn't have the set that was just checked yet. */
async function afterSetDone(row: Row, it: WorkoutItem, sessionId: string, items: WorkoutItem[], exMap: Record<string, Exercise>, s: Settings, live: boolean,
  select: (key: string) => void) {
  if (!live) return;
  if (row.side === 'left') return; // right side follows straight away
  if (row.kind === 'working' && (it.drops ?? 0) > 0) return; // drops follow immediately, no rest
  if (row.kind === 'drop' && row.dropNo !== it.drops) return;
  const sets = await db.sets.where('sessionId').equals(sessionId).filter(alive).toArray();
  const done = (x: WorkoutItem) => itemDone(x, exMap[x.exerciseId], s, sets);
  /** next unfinished slot after position `from`, wrapping around, skipping `skip` */
  const nextOpen = (from: number, skip: (x: WorkoutItem) => boolean) => {
    for (let k = 1; k <= items.length; k++) { const x = items[(from + k) % items.length]; if (!skip(x) && !x.replacedBy && !done(x)) return x; }
    return undefined;
  };
  const idx = items.findIndex((x) => x.key === it.key);
  let next: WorkoutItem | undefined;
  if (it.supersetId) {
    // supersets: go to the next unfinished exercise later in this round, no rest in between; rest after the round
    const group = items.filter((x) => x.supersetId === it.supersetId);
    const later = group.slice(group.findIndex((x) => x.key === it.key) + 1).find((x) => !done(x));
    if (later) { select(later.key); return; }
    const lastOfGroup = items.findIndex((x) => x.key === group[group.length - 1].key);
    next = group.find((x) => !done(x)) ?? nextOpen(lastOfGroup, (x) => x.supersetId === it.supersetId);
  } else if (done(it)) {
    next = nextOpen(idx, (x) => x.key === it.key); // exercise finished: on to the next one not done yet
  }
  if (next && next.key !== it.key) select(next.key);
  if (!s.features.restTimer) return;
  const ex = exMap[it.exerciseId];
  const sec = it.rest.mode === 'countup' ? undefined : it.rest.sec ?? (ex ? defaultRestSec(ex.mechanic, s.restCompoundSec, s.restIsolationSec) : 120);
  rest.start(sec, ex && exerciseLabel(ex), { sessionId, setRef: `${it.key}|${rowId(row)}` });
}

function ExerciseStrip({ items, exMap, currentKey, isDone, onSelect, onReorder, onAdd }: {
  items: WorkoutItem[]; exMap: Record<string, Exercise>; currentKey?: string; isDone: (i: WorkoutItem) => boolean;
  onSelect: (k: string) => void; onReorder: (n: WorkoutItem[]) => void; onAdd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [currentKey]);
  return (
    <div ref={ref} className="strip">
      <SortableList items={items} onReorder={onReorder} horizontal>
        {items.map((it, i) => {
          const g = groupPos(items, i);
          const cur = it.key === currentKey;
          const ex = exMap[it.exerciseId];
          return (
            <SortableItem key={it.key} id={it.key} className={'strip-slot tube-' + g}>
              <button data-current={cur} onClick={() => onSelect(it.key)} aria-current={cur ? 'step' : undefined}
                aria-label={exerciseLabel(ex) + (isDone(it) ? ', done' : '')}
                className={'avatar pressable' + (cur ? ' current' : '') + (isDone(it) ? ' done' : '')}>
                <Avatar ex={ex} />
                {isDone(it) && <span className="avatar-badge"><Icon name="check" size={11} stroke={3.2} /></span>}
              </button>
            </SortableItem>
          );
        })}
      </SortableList>
      <button className="avatar add pressable" onClick={onAdd} aria-label="Add exercise"><Icon name="plus" size={20} /></button>
    </div>
  );
}

/** Exercise image, or its initials when there is none. */
export function Avatar({ ex }: { ex?: Exercise }) {
  const src = exerciseImage(ex);
  if (src) return <img src={src} alt="" loading="lazy" />;
  const initials = (ex?.name ?? '?').split(/[\s-]+/).filter((w) => /^[a-z0-9]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return <span className="avatar-initials">{initials || '?'}</span>;
}

function ExercisePanel({ session, item, ex, sets, settings, onMenu, onSetDone, replaced, progress }: {
  session: Session; item: WorkoutItem; ex: Exercise; sets: SetLog[]; settings: Settings; onMenu: () => void; onSetDone: (r: Row) => void;
  /** sessions.liveProgress (undefined while loading): badges for ticked sets */
  progress?: LiveProgress;
  /** defined when this slot only holds the done sets of an exercise that was replaced (by `replaced`, null if unknown) */
  replaced?: Exercise | null;
}) {
  const prev = useLiveQuery(() => lastPerformance(ex.id, session.id), [ex.id, session.id]);
  const bw = useLiveQuery(() => latestBodyweightKg(), []);
  const [weightFor, setWeightFor] = useState<Row | null>(null);
  const [effortFor, setEffortFor] = useState<Row | null>(null);
  const groups = useMemo(() => rowsFor(item, ex, settings), [item, ex, settings]);
  const byId = useMemo(() => new Map(sets.map((l) => [logId(l), l])), [sets]);
  const prevById = useMemo(() => new Map((prev?.sets ?? []).map((l) => [logId(l), l])), [prev]);
  // progression target (exercises.nextTarget) for the live workout; off or no rule → last time's numbers as before
  const progOn = settings.features.progression !== false && !session.endedAt;
  const target = useLiveQuery(() => (progOn ? run(exercisesNextTarget, { exerciseId: ex.id, repsMin: item.repsMin || null, repsMax: item.repsMax || null, beforeSessionId: session.id }).catch(() => null) : Promise.resolve(null)),
    [progOn, ex.id, item.repsMin, item.repsMax, session.id]);
  const targetById = useMemo(() => new Map<string, Partial<SetLog>>(target?.decision ? target.rows.map((t) => [`working:${t.setNo}:0:${t.side}`,
    { loadKg: t.loadKg, reps: t.reps, ...(t.rir != null ? { rir: t.rir, rpe: rirToRpe(t.rir) } : {}) }]) : []), [target]);
  const badgeById = useMemo(() => new Map<string, SetBadge>((progress?.sets ?? []).filter((x) => x.itemKey === item.key).map((x) => [`working:${x.setNo}:0:${x.side}`, x.badge])), [progress, item.key]);
  const [whyOpen, setWhyOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const unit = settings.unit;
  const loadLabel = ex.loadType === 'bodyweight' ? `+${unit}` : ex.loadType === 'assisted' ? `assist` : unit;
  const effortOn = settings.features.effort;
  const img = exerciseImage(ex);
  const [imgIdx, setImgIdx] = useState(0);

  const stepKg = snappedStepKg(ex.stepKg ?? defaultStepKg(ex.equipment, unit), unit);
  const heavier = (a: number, b: number) => (ex.loadType === 'assisted' ? a < b : a > b); // less assistance = heavier
  const typed = (l?: SetLog) => (l && (l.loadKg != null || l.reps != null) ? l : undefined);
  /** Value shown greyed when nothing is entered yet, and saved on a bare ✓. In order:
   *  right side: what was entered on the left side of the same set today;
   *  a later set: today's set above when it went heavier than last time's row, else last time's same row,
   *  else today's set above (or its own suggestion, so the carry-forward runs down the whole table);
   *  first set: last time's same row. Drop steps: a drop from their parent's weight. */
  const suggestion = (r: Row): Partial<SetLog> | undefined => {
    if (r.kind === 'drop') {
      const parentRow: Row = r.dropNo === 1 ? { ...r, kind: 'working', dropNo: undefined } : { ...r, dropNo: r.dropNo! - 1 };
      const parentLoad = byId.get(rowId(parentRow))?.loadKg ?? suggestion(parentRow)?.loadKg;
      const p = prevById.get(rowId(r));
      if (parentLoad != null) return { loadKg: suggestDrop(parentLoad, stepKg), reps: p?.reps };
      return p;
    }
    // working rows: today's progression target replaces last time's numbers (warm-ups keep last time's)
    const p = (r.kind === 'working' ? targetById.get(rowId(r)) : undefined) ?? prevById.get(rowId(r));
    if (r.side === 'right') {
      const left = typed(byId.get(rowId({ ...r, side: 'left' })));
      if (left) return { loadKg: left.loadKg ?? p?.loadKg, reps: left.reps ?? p?.reps, rir: left.rir ?? p?.rir, rpe: left.rpe ?? p?.rpe };
    }
    if (r.setNo > 1) {
      const aboveRow: Row = { ...r, setNo: r.setNo - 1 };
      const above = typed(byId.get(rowId(aboveRow)));
      if (above && (!p || p.loadKg == null || (above.loadKg != null && heavier(above.loadKg, p.loadKg)))) {
        return { loadKg: above.loadKg ?? p?.loadKg, reps: above.reps ?? p?.reps }; // today's progress wins (effort not carried)
      }
      if (p) return p;
      const sAbove = above ?? suggestion(aboveRow);
      return sAbove && { loadKg: sAbove.loadKg, reps: sAbove.reps };
    }
    return p;
  };

  /** Writes one set row via sets.log (load type / bodyweight are snapshotted when the set is created or first checked off). done defaults to the row's current state. */
  type SetPatch = { loadKg?: number | null; reps?: number | null; rir?: number | null; rpe?: number | null; done?: boolean };
  const upsert = (r: Row, patch: SetPatch) => run(setsLog, {
    sessionId: session.id, itemKey: item.key, setNo: r.setNo, kind: r.kind, dropNo: r.dropNo, side: r.side,
    ...patch, done: patch.done ?? !!byId.get(rowId(r))?.doneAt,
  });

  // The first not-done row is highlighted as "next", but any set can be checked or un-checked.
  const flat = groups.flat();
  const activeIdx = flat.findIndex((r) => !byId.get(rowId(r))?.doneAt);
  const [shakeId, setShakeId] = useState<string>();
  const [repsFor, setRepsFor] = useState<Row | null>(null);

  /** Values a set would be saved with: what was typed, else the greyed suggestion. */
  const resolved = (r: Row) => {
    const cur = byId.get(rowId(r));
    const sug = suggestion(r);
    // the greyed effort is saved too (only when the effort column is shown), so e1RM isn't computed as RIR 0
    const effort = effortOn && cur?.rir == null && cur?.rpe == null && sug
      ? (settings.effortMode === 'rir' ? (sug.rir != null ? { rir: sug.rir } : {}) : (sug.rpe != null ? { rpe: sug.rpe } : {})) : {};
    return {
      loadKg: cur?.loadKg ?? sug?.loadKg ?? (ex.loadType === 'weighted' ? null : 0),
      reps: cur?.reps ?? sug?.reps ?? item.repsMax ?? item.repsMin ?? null,
      ...effort,
    };
  };

  const toggleDone = async (r: Row) => {
    const cur = byId.get(rowId(r));
    if (cur?.doneAt) {
      await upsert(r, { done: false });
      rest.stopIfFrom(session.id, `${item.key}|${rowId(r)}`); // un-checking the set that started the rest ends it
      return;
    }
    const v = resolved(r);
    if (v.loadKg == null || v.reps == null) { // no partial sets: open what's missing
      setShakeId(rowId(r)); setTimeout(() => setShakeId(undefined), 340);
      if (v.loadKg == null) setWeightFor(r); else setRepsFor(r);
      return;
    }
    await upsert(r, { ...v, done: true });
    onSetDone(r);
  };

  const effortVal = (l?: Partial<SetLog>) => (l == null ? null : settings.effortMode === 'rir' ? l.rir : l.rpe);

  let workNo = 0;
  return (
    <div style={{ paddingTop: 12 }}>
      {/* exercise header */}
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        {img ? (
          <button onClick={() => setImgIdx((imgIdx + 1) % Math.max(1, ex.images.length))} aria-label="Next image"
            style={{ border: 0, padding: 0, background: 'none', flex: 'none' }}>
            <img className="ex-hero" src={exerciseImage(ex, imgIdx)} alt="" style={{ width: 92, height: 92, borderRadius: 'var(--squircle)', objectFit: 'cover', background: 'var(--card-2)' }} />
          </button>
        ) : <ExerciseThumb ex={ex} size={96} />}
        <div className="grow" style={{ paddingTop: 2, minWidth: 0 }}>
          <h2 className="ex-title" title={ex.name} style={{ margin: 0, fontSize: '1.5rem', lineHeight: 1.12, letterSpacing: '-0.025em', fontWeight: 800, color: 'var(--accent)' }}>{ex.name}</h2>
          <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 3 }}>{equipmentTag(ex) && <>{equipmentTag(ex)} · </>}{titleCase(ex.muscles.join(', '))}</div>
          <div className="tags">
            {item.repsMin != null && <span className="tag"><Icon name="flag" size={12} stroke={2.2} />{item.repsMin}{item.repsMax && item.repsMax !== item.repsMin ? `–${item.repsMax}` : ''}</span>}
            {target?.decision && <TargetTag t={target} unit={unit} onClick={() => setWhyOpen(true)} />}
            {ex.unilateral && <span className="tag">L | R</span>}
            {item.supersetId && <span className="tag role"><Icon name="link" size={12} stroke={2.2} />SS</span>}
            {(item.drops ?? 0) > 0 && <span className="tag drop">↓ {item.drops}</span>}
            {ex.loadType !== 'weighted' && bw == null && <span className="tag warn"><Icon name="scale" size={12} stroke={2.2} />BW?</span>}
          </div>
        </div>
        <button className="icon-btn filled" aria-label="Exercise options" onClick={onMenu}><Icon name="more" /></button>
      </div>
      {replaced !== undefined && <p className="muted" style={{ margin: '10px 2px 0', fontSize: '0.875rem' }}>Replaced{replaced ? ` by ${exerciseLabel(replaced)}` : ''}. Its done sets stay here.</p>}
      <NoteLine value={item.notes} onSave={(notes) => run(itemsUpdate, { sessionId: session.id, itemKey: item.key, patch: { notes: notes ?? null } })} />

      {/* set table */}
      <div style={{ marginTop: 14 }}>
        <div className="set-grid set-head" data-effort={effortOn}>
          <span>#</span><span>{loadLabel}</span><span>reps</span>{effortOn && <span>{settings.effortMode}</span>}<span />
        </div>
        {groups.map((g) => {
          const head = g[0];
          if (head.kind === 'working') workNo++;
          const label = head.kind === 'warmup' ? 'W' : head.kind === 'drop' ? '↓' : String(workNo);
          return (
            <Fragment key={rowId(head)}>
              {g.map((r) => {
                const idx = flat.findIndex((x) => rowId(x) === rowId(r));
                const l = byId.get(rowId(r));
                const sug = suggestion(r);
                const done = !!l?.doneAt;
                const state = done ? 'done' : idx === activeIdx ? 'active' : 'future';
                const v = resolved(r);
                const ready = !done && v.loadKg != null && v.reps != null;
                const repsPh = sug?.reps != null ? String(sug.reps) : item.repsMin != null ? String(item.repsMax ?? item.repsMin) : '–';
                return (
                  <motion.div key={rowId(r)} layout="position" data-effort={effortOn}
                    className={`set-grid set-row ${state} ${r.kind}` + (shakeId === rowId(r) ? ' shake' : '')}>
                    <span className="set-no num">
                      {r.side === 'right' && g.length > 1 ? '' : label}
                      {r.side !== 'both' && <small>{r.side === 'left' ? 'L' : 'R'}</small>}
                    </span>
                    <button className="cell num" onClick={() => setWeightFor(r)} aria-label={`Weight, set ${label}`}>
                      {l?.loadKg != null ? fmtWeight(l.loadKg, unit, false) : <span className="ph">{sug?.loadKg != null ? fmtWeight(sug.loadKg, unit, false) : '–'}</span>}
                    </button>
                    <button className="cell num" onClick={() => setRepsFor(r)} aria-label={`Reps, set ${label}`}>
                      {l?.reps != null ? l.reps : <span className="ph">{repsPh}</span>}
                    </button>
                    {effortOn && (
                      <button className="cell num" onClick={() => setEffortFor(r)} aria-label={`Effort, set ${label}`}>
                        {effortVal(l) != null ? fmtNum(effortVal(l)!) : <span className="ph">{effortVal(sug) != null ? fmtNum(effortVal(sug)!) : '–'}</span>}
                      </button>
                    )}
                    {progress && <AnimatePresence initial={false}>
                      {done && badgeById.get(rowId(r)) && (
                        <motion.span key={badgeById.get(rowId(r))} className={'set-badge ' + badgeById.get(rowId(r))} role="img"
                          aria-label={badgeById.get(rowId(r)) === 'pr' ? 'Personal record' : 'Beat last time'}
                          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, filter: 'blur(0px)' }}
                          exit={{ opacity: 0, transition: { duration: 0.15 } }}
                          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}>
                          {badgeById.get(rowId(r)) === 'pr' ? 'PR' : '↑'}
                        </motion.span>
                      )}
                    </AnimatePresence>}
                    <button className={'check' + (done ? ' on' : state === 'active' && ready ? ' ready' : '') + (state === 'future' ? ' later' : '')}
                      onClick={() => toggleDone(r)} aria-pressed={done}
                      aria-label={done ? `Undo set ${label}` : `Complete set ${label}`}>
                      <Icon name="check" size={20} stroke={2.8} />
                    </button>
                  </motion.div>
                );
              })}
            </Fragment>
          );
        })}
        <div className="row" style={{ justifyContent: 'center', gap: 4, padding: '6px 0 2px' }}>
          <SetCountButtons item={item} session={session} sets={sets} />
        </div>
      </div>

      {/* history: same grid as the inputs, without the boxes */}
      <Link to={`/exercise/${ex.id}`} className="history-card pressable">
        <div className="row" style={{ padding: '0 6px 4px' }}>
          <Icon name="history" size={16} className="faint" />
          <span className="grow muted" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{prev?.session ? relDay(prev.session.startedAt) : 'No history yet'}</span>
          <Icon name="chart" size={16} className="faint" />
          <Icon name="chevronRight" size={16} className="chev" />
        </div>
        {prev?.sets.sort(setOrder).map((l) => {
          const e = settings.effortMode === 'rir' ? l.rir : l.rpe;
          return (
            <div key={l.id} className={'set-grid set-row ghost ' + l.kind} data-effort={effortOn}>
              <span className="set-no num">{l.kind === 'warmup' ? 'W' : l.kind === 'drop' ? '↓' : l.setNo}{l.side !== 'both' && <small>{l.side === 'left' ? 'L' : 'R'}</small>}</span>
              <span className="cell num">{l.loadKg != null ? fmtWeight(l.loadKg, unit, false) : '–'}</span>
              <span className="cell num">{l.reps ?? '–'}</span>
              {effortOn && <span className="cell num">{e != null ? fmtNum(e) : '–'}</span>}
              <span />
            </div>
          );
        })}
      </Link>

      <Sheet open={whyOpen} onClose={() => setWhyOpen(false)} title="Today's target">
        {target && <TargetWhy t={target} unit={unit} />}
      </Sheet>
      <WeightSheet open={!!weightFor} onClose={() => setWeightFor(null)} unit={unit} exercise={ex}
        label={ex.loadType === 'bodyweight' ? 'Added weight' : ex.loadType === 'assisted' ? 'Assistance' : 'Weight'}
        valueKg={weightFor ? byId.get(rowId(weightFor))?.loadKg ?? suggestion(weightFor)?.loadKg : null}
        onDone={(kg) => weightFor && upsert(weightFor, { loadKg: kg })} />
      {/* opens on the logged reps, else the suggestion (last time / plan target) */}
      <RepsSheet open={!!repsFor} onClose={() => setRepsFor(null)}
        value={repsFor ? byId.get(rowId(repsFor))?.reps ?? suggestion(repsFor)?.reps ?? item.repsMax ?? item.repsMin ?? 8 : null}
        onDone={(v) => repsFor && upsert(repsFor, { reps: v })} />
      <EffortSheet open={!!effortFor} onClose={() => setEffortFor(null)} mode={settings.effortMode}
        value={effortFor ? effortVal(byId.get(rowId(effortFor))) : null}
        onDone={(v, mode) => effortFor && upsert(effortFor, v == null ? { rir: null, rpe: null } : mode === 'rir' ? { rir: v } : { rpe: v })} />
    </div>
  );
}

/** Tiny hint on the exercise header: what the progression target changes vs last time. */
function targetHint(t: NextTarget, unit: Settings['unit']) {
  const w = (kg: number) => fmtWeight(Math.abs(kg), unit);
  switch (t.decision) {
    case 'increase': return { text: `↑ ${t.loadType === 'assisted' ? '−' : '+'}${w(t.loadDeltaKg)}`, tone: 'up' };
    case 'reduce': return { text: `↓ ${t.loadType === 'assisted' ? '+' : '−'}${w(t.loadDeltaKg)}`, tone: 'down' };
    case 'reps': return { text: '+1 rep', tone: 'up' };
    default: return { text: '= hold', tone: 'hold' };
  }
}
function TargetTag({ t, unit, onClick }: { t: NextTarget; unit: Settings['unit']; onClick: () => void }) {
  const h = targetHint(t, unit);
  return <button className={'tag prog ' + h.tone} onClick={onClick} aria-label={`Today's target: ${h.text}. Why?`}>{h.text}</button>;
}
function TargetWhy({ t, unit }: { t: NextTarget; unit: Settings['unit'] }) {
  const line = (load: number, reps: number) => `${t.loadType === 'bodyweight' ? (load ? `BW+${fmtWeight(load, unit, false)}` : 'BW') : fmtWeight(load, unit, false)} × ${reps}`;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p style={{ margin: 0, lineHeight: 1.45 }}>{t.reason}</p>
      <div className="list">
        {t.rows.map((r) => (
          <div key={`${r.setNo}:${r.side}`} className="list-item num" style={{ minHeight: 44 }}>
            <span className="faint" style={{ width: 36 }}>{r.setNo}{r.side !== 'both' && <small>{r.side === 'left' ? 'L' : 'R'}</small>}</span>
            <span className="grow muted">{line(r.lastLoadKg, r.lastReps)}</span>
            <span aria-hidden className="faint">→</span>
            <span style={{ fontWeight: 650, minWidth: 92, textAlign: 'right' }}>{line(r.loadKg, r.reps)}</span>
          </div>
        ))}
      </div>
      <p className="faint" style={{ margin: 0, fontSize: '0.8125rem', lineHeight: 1.45 }}>
        Rough guide: double progression, a common coaching rule, not a tested formula. {t.basis && `Last time: ${relDay(Date.parse(t.basis.date + 'T12:00')).toLowerCase()}. `}Tap any value to change it, or turn this off in Settings.
      </p>
    </div>
  );
}

const MAX_SETS = 20; // items.update limit

function SetCountButtons({ item, session, sets }: { item: WorkoutItem; session: Session; sets: SetLog[] }) {
  // "−" deletes the last set's rows (asks first if any of them were checked off)
  const change = (d: number) => updateItemChecked(session.id, item, { sets: Math.min(MAX_SETS, Math.max(1, item.sets + d)) }, sets);
  return (
    <>
      <button className="icon-btn filled" aria-label="Remove a set" onClick={() => change(-1)} disabled={item.sets <= 1}><Icon name="minus" size={18} /></button>
      <span className="faint num" style={{ fontSize: '0.8125rem', minWidth: 48, textAlign: 'center' }}>{item.sets} sets</span>
      <button className="icon-btn filled" aria-label="Add a set" onClick={() => change(1)} disabled={item.sets >= MAX_SETS} style={{ color: 'var(--accent)' }}><Icon name="plus" size={18} /></button>
    </>
  );
}

/** Saves a text draft while typing (debounced), and flushes it on unmount, when the app is hidden or the page is
 *  closed, so nothing typed is lost to navigation or iOS killing the app. Saving is skipped when nothing changed. */
function useAutosave(draft: string, saved: string | undefined, onSave: (v?: string) => void, delay = 600) {
  const latest = useRef({ draft, saved, onSave });
  latest.current = { draft, saved, onSave };
  const flush = useCallback(() => {
    const { draft: d, saved: sv, onSave: save } = latest.current;
    const v = d.trim() ? d.trim() : undefined;
    if ((v ?? '') !== (sv ?? '').trim()) { latest.current.saved = v; save(v); }
  }, []);
  useEffect(() => { const t = setTimeout(flush, delay); return () => clearTimeout(t); }, [draft, delay, flush]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', flush); flush(); };
  }, [flush]);
  return flush;
}

/** Exercise note, editable in place (pencil). Saved to the session copy as you type; finishing offers to keep it in the plan. */
function NoteLine({ value, onSave }: { value?: string; onSave: (v?: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <NoteEditor value={value} onSave={onSave} onDone={() => setEditing(false)} />;
  return (
    <button className="note-line pressable" onClick={() => setEditing(true)} aria-label={value ? `Edit note: ${value}` : 'Add note'}>
      <Icon name="pencil" size={16} />
      <span className={value ? '' : 'faint'}>{value || 'Note'}</span>
    </button>
  );
}
function NoteEditor({ value, onSave, onDone }: { value?: string; onSave: (v?: string) => void; onDone: () => void }) {
  const [draft, setDraft] = useState(value ?? '');
  const flush = useAutosave(draft, value, onSave);
  const commit = () => { flush(); onDone(); };
  return (
    <div className="note-line editing">
      <Icon name="pencil" size={16} />
      <textarea autoFocus rows={2} value={draft} placeholder="Seat 4, grip, cues…" aria-label="Exercise note"
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); } }} />
    </div>
  );
}


function RestBar() {
  const st = useRest();
  const now = useTick(!!st, 250);
  if (!st) return null;
  const shell = document.querySelector(".shell");
  const elapsed = (now - st.startedAt) / 1000;
  const countdown = st.targetSec != null;
  const left = countdown ? st.targetSec! - elapsed : 0;
  const over = countdown && left <= 0;
  const pct = countdown ? Math.min(1, elapsed / Math.max(1, st.targetSec!)) : 0;
  const bar = (
    <AnimatePresence>
      <motion.div className="restbar" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.35 }} role="timer" aria-live="off">
        <div className="restbar-fill" style={{ transform: `scaleX(${pct})`, background: over ? 'var(--good)' : 'var(--accent)' }} />
        <div className="row" style={{ position: 'relative' }}>
          <div className="grow">
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)' }}>{over ? 'Go' : 'Rest'}</div>
            <div className="num" style={{ fontSize: '1.5rem', fontWeight: 750, letterSpacing: '-0.02em', color: over ? 'var(--good)' : 'var(--text)' }}>
              {countdown ? (over ? '+' : '') + fmtDuration(Math.abs(left) * 1000) : fmtDuration(elapsed * 1000)}
            </div>
          </div>
          {countdown && <>
            <button className="btn" style={{ minHeight: 38 }} onClick={() => rest.adjust(-15)}>−15</button>
            <button className="btn" style={{ minHeight: 38 }} onClick={() => rest.adjust(15)}>+15</button>
          </>}
          <button className="btn" style={{ minHeight: 38 }} onClick={rest.stop}>Skip</button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
  return shell ? createPortal(bar, shell) : bar;
}

function FinishSheet({ open, onClose, session, doneCount, sets, onFinished }: {
  open: boolean; onClose: () => void; session: Session; doneCount: number; sets: SetLog[]; onFinished: () => void;
}) {
  const differs = useLiveQuery(() => (open ? sessionDiffersFromPlan(session) : Promise.resolve(false)), [open, session]);
  // sets with values typed in but never ticked: ask instead of silently dropping them
  const exIds = useMemo(() => [...new Set(sets.map((x) => x.exerciseId))], [sets]);
  const loadTypes = useLiveQuery(async () => Object.fromEntries((await db.exercises.bulkGet(exIds)).filter(Boolean).map((e) => [e!.id, e!.loadType])), [exIds.join()]) ?? {};
  const complete = (x: SetLog) => x.reps != null && (x.loadKg != null || (loadTypes[x.exerciseId] ?? x.loadType) !== 'weighted');
  const unticked = sets.filter((x) => !x.doneAt && complete(x));
  const partial = sets.filter((x) => !x.doneAt && !complete(x) && (x.loadKg != null || x.reps != null)).length;
  const [ack, setAck] = useState(false);
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) setAck(false); }
  const tickAll = async () => {
    for (const x of unticked) await run(setsUpdate, { id: x.id, done: true, ...(x.loadKg == null ? { loadKg: 0 } : {}) });
    setAck(true);
  };
  const go = async (updatePlan: boolean) => { await run(sessionsFinish, { id: session.id, updatePlan }); onClose(); onFinished(); };
  const asking = !ack && unticked.length > 0;
  return (
    <Sheet open={open} onClose={onClose} title="Finish workout?">
      <div className="stack" style={{ gap: 12 }}>
        <div className="row card" style={{ background: 'var(--card-2)' }}>
          <div className="grow"><div className="muted" style={{ fontSize: '0.8125rem' }}>Duration</div><div className="num" style={{ fontWeight: 700, fontSize: '1.25rem' }}>{fmtDuration(Date.now() - session.startedAt)}</div></div>
          <div className="grow"><div className="muted" style={{ fontSize: '0.8125rem' }}>Sets done</div><div className="num" style={{ fontWeight: 700, fontSize: '1.25rem' }}>{doneCount}</div></div>
        </div>
        {asking ? (
          <>
            <p className="muted" style={{ margin: '4px 2px' }}>{unticked.length} set{unticked.length === 1 ? '' : 's'} not ticked.</p>
            <button className="btn primary lg block" onClick={tickAll}><Icon name="check" size={18} /> Tick all</button>
            <button className="btn lg block" onClick={() => setAck(true)}>Drop</button>
          </>
        ) : differs ? (
          <>
            <p className="muted" style={{ margin: '4px 2px' }}>Workout changed. Save to plan?</p>
            <button className="btn primary lg block" onClick={() => go(true)}><Icon name="check" size={18} /> Save to plan</button>
            <button className="btn lg block" onClick={() => go(false)}>Just this time</button>
          </>
        ) : <button className="btn good lg block" onClick={() => go(false)}>Finish workout</button>}
        {!asking && <p className="faint" style={{ margin: 0, fontSize: '0.8125rem', textAlign: 'center' }}>
          {partial ? `${partial} half-filled set${partial === 1 ? '' : 's'} will be dropped.` : 'Unchecked sets are dropped.'}
        </p>}
      </div>
    </Sheet>
  );
}

/** Workout notes: saved as you type (debounced) and flushed when the sheet closes or the app is hidden. */
function NotesField({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  const flush = useAutosave(draft, value, onChange);
  return (
    <label className="field" style={{ margin: '8px 0' }}><span>Workout notes</span>
      <textarea className="input" rows={3} style={{ padding: 12, resize: 'vertical' }} value={draft}
        placeholder="How it felt, sleep, anything worth remembering" onChange={(e) => setDraft(e.target.value)} onBlur={flush} />
    </label>
  );
}

export function ExerciseInfo({ ex }: { ex: Exercise }) {
  return (
    <div className="stack" style={{ gap: 12 }}>
      {ex.images.length > 0 && (
        <div className="row" style={{ gap: 8 }}>
          {ex.images.slice(0, 2).map((_, i) => <img key={i} src={exerciseImage(ex, i)} alt="" style={{ flex: 1, minWidth: 0, borderRadius: 12, aspectRatio: '4/3', objectFit: 'cover' }} />)}
        </div>
      )}
      <div className="chips" style={{ flexWrap: 'wrap' }}>
        <span className="badge">{titleCase(ex.mechanic)}</span><span className="badge">{equipmentLabel(ex.equipment)}</span>
        {ex.muscles.map((m) => <span key={m} className="badge accent">{titleCase(m)}</span>)}
        {ex.secondary.map((m) => <span key={m} className="badge">{titleCase(m)}</span>)}
      </div>
      {ex.instructions?.length ? <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.55 }}>{ex.instructions.map((s, i) => <li key={i} style={{ marginBottom: 6 }}>{s}</li>)}</ol>
        : <p className="muted">No instructions for this exercise.</p>}
    </div>
  );
}

const toLocalInput = (ts: number) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Everything about a workout stays editable afterwards: name, start, duration. */
function DetailsSheet({ open, onClose, session, onSave }: { open: boolean; onClose: () => void; session: Session;
  onSave: (p: { name: string; startedAt: string; durationMin?: number }) => void }) {
  const [name, setName] = useState(session.name);
  const [start, setStart] = useState(toLocalInput(session.startedAt));
  const [mins, setMins] = useState('');
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setName(session.name); setStart(toLocalInput(session.startedAt));
      setMins(session.endedAt ? String(Math.round((session.endedAt - session.startedAt) / 60000)) : '');
    }
  }
  const submit = () => {
    const startedAt = new Date(start).getTime() || session.startedAt;
    const m = parseInt(mins, 10);
    onSave({ name: name.trim() || session.name, startedAt: new Date(startedAt).toISOString(), ...(session.endedAt && m > 0 ? { durationMin: m } : {}) });
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Details">
      <div className="stack" style={{ gap: 14 }}>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Start</span><input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        {session.endedAt && <label className="field"><span>Duration (min)</span><input className="input num" inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value)} /></label>}
        <button className="btn primary lg block" onClick={submit}><Icon name="check" size={20} stroke={2.6} /> Save</button>
      </div>
    </Sheet>
  );
}

/** Single-pointer alternative to drag reordering (WCAG 2.5.7). */
export function moveItem<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
