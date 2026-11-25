import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog } from '../components/Dialog';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { createPortal } from 'react-dom';
import { ExercisePicker, ExerciseEditor } from '../components/ExercisePicker';
import { equipmentLabel, exerciseLabel } from '../lib/equipment';
import { Icon } from '../components/Icon';
import { ExerciseMenu, repsText } from '../components/ExerciseMenu';
import { VariantSheet } from '../components/VariantSheet';
import { ExThumb } from '../components/ExThumb';
import { MuscleMap } from '../components/MuscleMap';
import { EffortExplainer, EffortSheet, RepsSheet, WeightSheet } from '../components/SetInputs';
import { Sheet } from '../components/Sheet';
import { SurveyStep, WorkoutSummary } from '../components/WorkoutSummary';
import { SaveAsWorkoutSheet, useRepeatWorkout } from '../components/RepeatWorkout';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db } from '../db/db';
import { lastPerformance, latestBodyweightKg, sessionDiffersFromPlan, setOrder } from '../db/gym';
import { run } from '../api/registry';
import { exercisesNextTarget, itemsAdd, itemsRemove, itemsReorder, itemsReplace, itemsSuperset, itemsUpdate, sessionsDelete, sessionsFinish, sessionsLiveProgress, sessionsUpdate, setBeyond, setsLog, setsUpdate, type LiveProgress, type NextTarget, type SetBadge } from '../api/gym';
import { exerciseImage } from '../db/seed';
import { useSettings } from '../db/settings';
import type { Exercise, Session, SetKind, SetLog, Settings, Side, WorkoutItem } from '../db/types';
import { effortText, fmtDate, fmtDuration, fmtWeight, plural, relDay, titleCase } from '../lib/format';
import { rest, useRest, useTick, useWakeLock } from '../lib/rest';
import { defaultRestSec, suggestDrop, defaultStepKg, fromKg, rirOf, rirToRpe, setE1rm, snappedStepKg, type E1rm } from '../lib/science';
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
    if (!(await confirmDialog({ title: `Delete ${plural(lost.length, 'done set', 'done sets')}?`, message: `What you logged in ${lost.length === 1 ? 'it' : 'them'} is deleted. This can’t be undone.`, confirm: lost.length === 1 ? 'Delete set' : 'Delete sets', danger: true }))) return;
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

  const [menu, setMenu] = useState<'item' | 'session' | 'finish' | 'info' | 'editEx' | 'details' | 'variant' | null>(null);
  const [menuSub, setMenuSub] = useState<'reps' | undefined>(); // ⋯ sheet opened straight on the reps target
  const [picking, setPicking] = useState<null | 'add' | 'replace'>(null);
  // summary sheet: 'finish' right after finishing (Done goes Home), 'view' for a past session (Done just closes)
  const [summary, setSummary] = useState<null | 'finish' | 'view'>(null);
  // after Finish: the survey step first (if the survey is on), then the summary with its celebration
  const [surveyStep, setSurveyStep] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const repeat = useRepeatWorkout();

  // stop a rest timer left over from another workout (e.g. a new one was started)
  const restSt = useRest();
  const liveId = live ? session.id : undefined;
  useEffect(() => { if (liveId && restSt && restSt.sessionId !== liveId) rest.stop(); }, [liveId, restSt]);

  // back: return where the user came from when there is in-app history, else the obvious parent
  const back = () => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav(live ? '/' : '/history'));

  if (session === undefined) return null; // loading (a frame)
  if (!session || !alive(session)) {
    return (
      <div className="page no-tabs" data-role="gym">
        <header className="row" style={{ paddingTop: 'calc(var(--safe-t) + 6px)' }}>
          <button className="icon-btn" aria-label="Back" onClick={back}><Icon name="chevronLeft" /></button>
        </header>
        <div className="empty">
          <Icon name="dumbbell" size={40} />
          <h3>{session ? 'Workout deleted' : 'Workout not found'}</h3>
          <p>{session ? 'It’s no longer in your history.' : 'It may have been deleted on another device.'}</p>
          <Link className="btn primary" to="/history"><Icon name="history" size={18} /> Open history</Link>
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
  const replaceCurrent = async () => {
    if (!current) return;
    setMenu(null);
    const doneN = workingSetCount(sets.filter((x) => x.itemKey === current.key && x.doneAt));
    if (doneN && !(await confirmDialog({ title: `Replace ${exerciseLabel(ex, 'exercise')}?`,
      message: `${doneN === 1 ? 'Its done set stays' : `Its ${doneN} done sets stay`} in this workout as ${exerciseLabel(ex, 'this exercise')}. The new exercise starts fresh.`, confirm: 'Replace exercise' }))) return;
    setPicking('replace');
  };

  return (
    <div className="page no-tabs" data-role="gym" style={{ paddingTop: 0, paddingBottom: "calc(var(--safe-b) + 110px)" }}>
      {/* header */}
      <header style={{ position: 'sticky', top: 0, zIndex: 10, margin: '0 -16px', padding: 'calc(var(--safe-t) + 6px) 8px 8px',
        background: 'var(--chrome)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)' }}>
        <div className="row">
          <button className="icon-btn" aria-label="Back" onClick={back}><Icon name="chevronLeft" /></button>
          <div className="grow" style={{ textAlign: 'center' }}>
            <h1 className="ellipsis sess-title">{session.name}</h1>
            <div className="num muted live-stats" style={{ fontSize: '0.8125rem' }}>
              {live ? <>
                <span>{fmtDuration(now - session.startedAt)}</span>
                {progress && <>
                  <span><span aria-hidden>{progress.totals.workingSetsDone}/{progress.totals.workingSetsPlanned}</span><span className="sr-only">{progress.totals.workingSetsDone} of {plural(progress.totals.workingSetsPlanned, 'set', 'sets')} done</span></span>
                  <span><span className="sr-only">Volume </span>{Math.round(fromKg(progress.totals.volumeKg, settings.unit)).toLocaleString()} {settings.unit}</span>
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
          settings={settings} onMenu={(sub) => { setMenuSub(sub); setMenu('item'); }} progress={progress ?? undefined}
          onReplace={replaceCurrent} live={live}
          onSetDone={(row) => afterSetDone(row, current, session.id, items, exMap, settings, live, select)} />
      ) : items.length ? null /* exercises still loading: no "Empty workout" flash */ : (
        <div className="empty">
          <Icon name="dumbbell" size={40} />
          <h3>Empty workout</h3>
          <p>Add exercises as you go.</p>
          <button className="btn primary" onClick={() => setPicking('add')}><Icon name="plus" size={18} /> Add exercise</button>
        </div>
      )}

      {live && settings.features.restTimer && <RestBar onStart={() => {
        const sec = !current || current.rest.mode === 'countup' ? undefined : current.rest.sec ?? (ex ? defaultRestSec(ex.mechanic, settings.restCompoundSec, settings.restIsolationSec) : 120);
        rest.start(sec, ex && exerciseLabel(ex), { sessionId: session.id, setRef: 'manual' });
      }} />}

      {/* item menu: everything editable in a plan is editable here */}
      {current && (
        <ExerciseMenu open={menu === 'item'} initialSub={menuSub} onClose={() => setMenu(null)} item={current} ex={ex} settings={settings}
          nextEx={curIdx < items.length - 1 ? exMap[items[curIdx + 1].exerciseId] ?? null : undefined}
          linked={!!current.supersetId && current.supersetId === items[curIdx + 1]?.supersetId}
          canLeft={curIdx > 0} canRight={curIdx < items.length - 1}
          onChange={(n) => updateItemChecked(session.id, current, itemPatch(current, n), sets, () => setMenu(null))}
          onSuperset={() => run(itemsSuperset, { ...t, itemKey: current.key })}
          onMove={(d) => reorder(moveItem(items, curIdx, d))}
          onInfo={() => setMenu('info')}
          onEditEx={() => setMenu('editEx')}
          onAdd={() => { setMenu(null); setPicking('add'); }}
          onReplace={replaceCurrent}
          onVariant={() => setMenu('variant')}
          onRemove={async () => {
            const mine = sets.filter((x) => x.itemKey === current.key);
            const doneN = mine.filter((x) => x.doneAt).length;
            if (doneN) {
              setMenu(null);
              if (!(await confirmDialog({ title: `Remove ${exerciseLabel(ex, 'exercise')}?`, message: `Its ${plural(doneN, 'logged set', 'logged sets')} will be deleted. This can’t be undone.`, confirm: 'Remove exercise', danger: true }))) return;
            }
            await run(itemsRemove, { ...t, itemKey: current.key }); setMenu(null);
          }} />
      )}

      <VariantSheet open={menu === 'variant'} exercise={ex} confirm="Swap" title="Variant" onClose={() => setMenu(null)}
        onPick={async (e) => { if (current && e.id !== current.exerciseId) await run(itemsReplace, { ...t, itemKey: current.key, exerciseId: e.id }); }} />
      <Sheet open={menu === 'info'} onClose={() => setMenu(null)} title={ex && exerciseLabel(ex)}>
        {ex && <ExerciseInfo ex={ex} />}
      </Sheet>
      <ExerciseEditor open={menu === 'editEx'} exercise={ex} onClose={() => setMenu(null)} />

      <Sheet open={menu === 'session'} onClose={() => setMenu(null)} title="Workout">
        <button className="menu-item" onClick={() => { setMenu(null); setPicking('add'); }}><Icon name="plus" />Add exercise</button>
        {!live && <button className="menu-item" onClick={() => { setMenu(null); setSummary('view'); }}><Icon name="chart" />Summary</button>}
        {!live && <button className="menu-item" onClick={() => repeat(session.id, () => { setMenu(null); setSummary(null); })}><Icon name="play" />Repeat workout</button>}
        {!live && <button className="menu-item" onClick={() => { setMenu(null); setSavingAs(true); }}><Icon name="copy" />Save as workout</button>}
        <button className="menu-item" onClick={() => setMenu('details')}><Icon name="edit" />Name, date & time</button>
        <NotesField value={session.notes} onChange={(notes) => run(sessionsUpdate, { id: session.id, notes: notes ?? null })} />
        {!live && <button className="menu-item" onClick={() => run(sessionsUpdate, { id: session.id, resume: true })}><Icon name="play" />Resume this workout</button>}
        <button className="menu-item danger" onClick={async () => {
          setMenu(null);
          const logged = workingSetCount(sets.filter((x) => x.doneAt));
          if (!(await confirmDialog(live
            ? { title: 'Discard workout?', message: logged ? `Your ${plural(logged, 'logged set', 'logged sets')} will be deleted. This can’t be undone.` : 'Nothing is logged yet. This can’t be undone.', confirm: 'Discard workout', danger: true }
            : { title: `Delete “${session.name}”?`, message: `It’s removed from your history${logged ? `, with its ${plural(logged, 'set', 'sets')}` : ''}. This can’t be undone.`, confirm: 'Delete workout', danger: true }))) return;
          await run(sessionsDelete, { id: session.id }); rest.stop(); nav('/');
        }}><Icon name="trash" />{live ? 'Discard workout' : 'Delete workout'}</button>
      </Sheet>

      <DetailsSheet open={menu === 'details'} onClose={() => setMenu(null)} session={session} onSave={(p) => run(sessionsUpdate, { id: session.id, ...p })} />
      <FinishSheet open={menu === 'finish'} onClose={() => setMenu(null)} session={session} doneCount={doneCount} sets={sets}
        onFinished={() => { rest.stop(); nav(`/session/${session.id}`, { replace: true }); if (settings.features.survey) setSurveyStep(true); else setSummary('finish'); }} />
      <SurveyStep open={surveyStep} sessionId={session.id} onNext={() => { setSurveyStep(false); setSummary('finish'); }} />
      {!live && <SaveAsWorkoutSheet open={savingAs} sessionId={session.id} sessionName={session.name} onClose={() => setSavingAs(false)} />}
      <WorkoutSummary open={!!summary} sessionId={session.id} onClose={() => setSummary(null)} celebrate={summary === 'finish'}
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
              <button type="button" data-current={cur} onClick={() => onSelect(it.key)} aria-current={cur ? 'step' : undefined}
                aria-label={exerciseLabel(ex) + (isDone(it) ? ', done' : '')}
                className={'avatar pressable' + (cur ? ' current' : '') + (isDone(it) ? ' done' : '')}>
                <ExThumb ex={ex} size="lg" />
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

function ExercisePanel({ session, item, ex, sets, settings, onMenu, onSetDone, replaced, progress, onReplace, live }: {
  session: Session; item: WorkoutItem; ex: Exercise; sets: SetLog[]; settings: Settings; onMenu: (sub?: 'reps') => void; onSetDone: (r: Row) => void;
  onReplace: () => void; live: boolean;
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
  // reward pop: a row whose badge (↑ / PR) just appeared after a tick gets one soft pulse. Badges present on mount don't.
  const [won, setWon] = useState<{ id: string; kind: Exclude<SetBadge, null> } | null>(null);
  const prevBadges = useRef<Map<string, SetBadge> | null>(null);
  useEffect(() => {
    if (!progress) return;
    const prevB = prevBadges.current;
    if (prevB) for (const [id, b] of badgeById) if (b && prevB.get(id) !== b) { setWon({ id, kind: b }); break; }
    prevBadges.current = badgeById;
  }, [badgeById, progress]);
  useEffect(() => { if (!won) return; const t = setTimeout(() => setWon(null), 950); return () => clearTimeout(t); }, [won]);
  const [effortInfo, setEffortInfo] = useState(false);
  const [scoreInfo, setScoreInfo] = useState(false);
  const reduceMotion = useReducedMotion();
  const unit = settings.unit;
  const loadLabel = ex.loadType === 'bodyweight' ? `+${unit}` : ex.loadType === 'assisted' ? `assist` : unit;
  const effortOn = settings.features.effort;
  const scoreOn = settings.features.score !== false;
  const priorBest = progress?.priorBestE1rm?.[ex.id] ?? null;
  // warm-up rows fold behind a chip once they're done (or the working sets have started)
  const warmN = groups.filter((g) => g[0].kind === 'warmup').length;
  const [showWarm, setShowWarm] = useState(() => warmN > 0
    && !sets.some((l) => l.kind === 'working' && l.doneAt) && !groups.filter((g) => g[0].kind === 'warmup').flat().every((r) => sets.some((l) => logId(l) === rowId(r) && l.doneAt)));
  const shown = useMemo(() => (showWarm ? groups : groups.filter((g) => g[0].kind !== 'warmup')), [groups, showWarm]);
  const warmDone = groups.filter((g) => g[0].kind === 'warmup').filter((g) => g.every((r) => byId.get(rowId(r))?.doneAt)).length;

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
  const flat = shown.flat();
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
  /** Effort shown in the cell: the chosen scale, or what was entered on the other scale where they don't map one-to-one. */
  const effortShown = (l?: Partial<SetLog>) => (l == null ? null : effortText(l, settings.effortMode));
  /** Score column: e1RM of what the row would be saved with (typed values, else the greyed suggestion), live as
   *  weight / reps / RIR change. Working sets only (warm-ups aren't near failure, drop steps are pre-fatigued).
   *  Bodyweight / assisted rows need a known bodyweight (the set's snapshot, else the latest weigh-in), else hidden. */
  const scoreOf = (r: Row): { est: E1rm; typed: boolean; best: boolean } | null => {
    if (!scoreOn || r.kind !== 'working') return null;
    const l = byId.get(rowId(r));
    const v = resolved(r);
    const est = setE1rm({ loadType: ex.loadType, loadKg: v.loadKg, bodyweightKg: l?.bodyweightKg ?? bw ?? null, reps: v.reps, rir: rirOf(l) ?? rirOf(v) });
    if (!est) return null;
    const typed = !!l?.doneAt || (l?.loadKg != null && l?.reps != null);
    // beats every earlier session's best reliable e1RM by the PR margin (same rule as the PR badge); only for real numbers
    const best = typed && est.reliable && !!priorBest && est.kg > priorBest.kg + priorBest.marginKg;
    return { est, typed, best };
  };
  const scoreNum = (e: E1rm) => (e.rtf <= 1 ? fmtWeight(e.kg, unit, false) : String(Math.round(fromKg(e.kg, unit))));
  const scoreText = (e: E1rm) => (e.lowerBound ? '≥' : e.reliable ? '' : '≈') + scoreNum(e);
  const scoreSpoken = (e: E1rm) => `${scoreNum(e)} ${unit}${e.lowerBound ? ', at least (no RIR logged)' : e.reliable ? '' : ', rough (over 12 reps to failure)'}`;

  let workNo = 0;
  return (
    <div style={{ paddingTop: 14 }}>
      {/* exercise header: big name + ⋯, then equipment / rep target / note lines (reference: alpha-live-exercise) */}
      <div className="title-more ex-head">
        <h2 className="ex-title ex-name" title={ex.name}>{ex.name}</h2>
        <button className="more-pill" aria-label="Exercise options" onClick={() => onMenu()}><Icon name="more" size={22} stroke={3} /></button>
      </div>
      <div className="ex-meta">
        {live && !replaced ? (
          <button className="ex-meta-btn" onClick={onReplace} aria-label={`${equipmentLabel(ex.equipment)}: replace exercise`}>
            {equipmentLabel(ex.equipment)}<Icon name="swap" size={16} />
          </button>
        ) : <span className="ex-meta-btn">{equipmentLabel(ex.equipment)}</span>}
        <button className="ex-meta-btn" onClick={() => onMenu('reps')} aria-label={repsText(item) ? `Target ${repsText(item)} reps: change` : 'Set a rep target'}>
          {repsText(item) ? `${repsText(item)} reps` : 'Reps'}<Icon name="pencil" size={15} />
        </button>
        {target?.decision && <TargetTag t={target} unit={unit} onClick={() => setWhyOpen(true)} />}
        {ex.unilateral && <span className="tag" title="Each side logged separately"><span aria-hidden>L | R</span><span className="sr-only">Each side logged separately</span></span>}
        {item.supersetId && <span className="tag role" title="Superset"><Icon name="link" size={12} stroke={2.2} /><span aria-hidden>SS</span><span className="sr-only">Superset</span></span>}
        {(item.drops ?? 0) > 0 && <span className="tag drop" title={plural(item.drops!, 'drop set', 'drop sets')}><span aria-hidden>↓ {item.drops}</span><span className="sr-only">{plural(item.drops!, 'drop set', 'drop sets')}</span></span>}
        {ex.loadType !== 'weighted' && bw == null && <span className="tag warn" title="No bodyweight logged: log a weigh-in for accurate volume"><Icon name="scale" size={12} stroke={2.2} /><span aria-hidden>BW?</span><span className="sr-only">No bodyweight logged</span></span>}
      </div>
      {replaced !== undefined && <p className="muted" style={{ margin: '10px 2px 0', fontSize: '0.875rem' }}>Replaced{replaced ? ` by ${exerciseLabel(replaced)}` : ''}. Its done sets stay here.</p>}
      <NoteLine value={item.notes} onSave={(notes) => run(itemsUpdate, { sessionId: session.id, itemKey: item.key, patch: { notes: notes ?? null } })} />
      {warmN > 0 && (
        <button className="chip warm-chip" aria-expanded={showWarm} onClick={() => setShowWarm(!showWarm)}>
          <span className="num">{plural(warmN, 'warm-up set', 'warm-up sets')}</span>
          {warmDone === warmN ? <Icon name="check" size={15} stroke={2.6} /> : <Icon name={showWarm ? 'chevronUp' : 'chevronDown'} size={15} stroke={2.4} />}
          {warmDone === warmN && <span className="sr-only">, done</span>}
        </button>
      )}

      {/* set table */}
      <div style={{ marginTop: 16 }}>
        <div className="set-grid set-head" data-effort={effortOn} data-score={scoreOn}>
          <span aria-hidden>#</span><span>{loadLabel}</span><span>reps</span>{effortOn && <button type="button" className="set-head-btn" onClick={() => setEffortInfo(true)} aria-label={`${settings.effortMode === 'rir' ? 'Reps in reserve' : 'RPE'}: what is this?`}>{settings.effortMode.toUpperCase()}<Icon name="info" size={12} stroke={2.2} /></button>}{scoreOn && <button type="button" className="set-head-btn score-head" onClick={() => setScoreInfo(true)} aria-label="Estimated 1-rep max: what is this?">e1RM</button>}<span />
        </div>
        {shown.map((g) => {
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
                // spoken names carry the value or suggestion: "Weight, set 1: 60 kg (target)", "Complete warm-up 1"
                const name = (r.kind === 'warmup' ? `warm-up ${r.setNo}` : r.kind === 'drop' ? `drop set ${r.dropNo} of set ${r.setNo}` : `set ${r.setNo}`)
                  + (r.side === 'both' ? '' : `, ${r.side}`);
                const hint = r.kind === 'working' && targetById.has(rowId(r)) ? 'target' : 'suggested';
                const wSpoken = l?.loadKg != null ? fmtWeight(l.loadKg, unit) : sug?.loadKg != null ? `${fmtWeight(sug.loadKg, unit)} (${hint})` : 'empty';
                const rSpoken = l?.reps != null ? String(l.reps) : repsPh !== '–' ? `${repsPh} (${hint})` : 'empty';
                const eSpoken = effortShown(l) != null ? effortShown(l)! : effortShown(sug) != null ? `${effortShown(sug)} (${hint})` : 'empty';
                const sc = scoreOf(r);
                return (
                  <motion.div key={rowId(r)} layout="position" data-effort={effortOn} data-score={scoreOn}
                    className={`set-grid set-row ${state} ${r.kind}` + (shakeId === rowId(r) ? ' shake' : '') + (won?.id === rowId(r) ? ` won ${won.kind}` : '')}>
                    <span className="set-no num">
                      {r.side === 'right' && g.length > 1 ? '' : label}
                      {r.side !== 'both' && <small>{r.side === 'left' ? 'L' : 'R'}</small>}
                    </span>
                    <button className="cell num" onClick={() => setWeightFor(r)} aria-label={`${loadLabel === unit ? 'Weight' : ex.loadType === 'assisted' ? 'Assistance' : 'Added weight'}, ${name}: ${wSpoken}`}>
                      {l?.loadKg != null ? fmtWeight(l.loadKg, unit, false) : <span className="ph">{sug?.loadKg != null ? fmtWeight(sug.loadKg, unit, false) : '–'}</span>}
                    </button>
                    <button className="cell num" onClick={() => setRepsFor(r)} aria-label={`Reps, ${name}: ${rSpoken}`}>
                      {l?.reps != null ? l.reps : <span className="ph">{repsPh}</span>}
                    </button>
                    {effortOn && (
                      <button className="cell num" onClick={() => setEffortFor(r)} aria-label={`${settings.effortMode.toUpperCase()}, ${name}: ${eSpoken}`}>
                        {effortShown(l) != null ? <EffortCell text={effortShown(l)!} /> : <span className="ph">{effortShown(sug) != null ? <EffortCell text={effortShown(sug)!} /> : '–'}</span>}
                      </button>
                    )}
                    {scoreOn && (sc
                      ? <span className={'score num' + (sc.typed ? '' : ' ph') + (sc.est.reliable && !sc.est.lowerBound ? '' : ' rough') + (sc.best ? ' best' : '')}
                          role="img" aria-label={`Estimated 1RM, ${name}: ${scoreSpoken(sc.est)}${sc.typed ? '' : ` (${hint})`}${sc.best ? ', above your previous best' : ''}`}>{scoreText(sc.est)}</span>
                      : <span className="score" aria-hidden />)}
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
                      aria-label={done ? `Undo ${name}` : `Complete ${name}`}>
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
        <div className="row hc-head">
          <span className="grow ellipsis">{prev?.session ? `${fmtDate(prev.session.startedAt)} · ${prev.session.name}` : 'No history yet'}</span>
          <Icon name="chart" size={16} />
          <Icon name="chevronRight" size={16} />
        </div>
        {!!prev?.sets.length && (
          <div className="set-grid set-row ghost hc-cols" data-effort={effortOn} data-score={scoreOn} aria-hidden>
            <span className="set-no">#</span><span className="cell">{loadLabel}</span><span className="cell">reps</span>{effortOn && <span className="cell">{settings.effortMode}</span>}{scoreOn && <span className="cell" style={{ textTransform: 'none' }}>e1RM</span>}<span />
          </div>
        )}
        {prev?.sets.sort(setOrder).map((l) => {
          const e = effortText(l, settings.effortMode);
          const ps = scoreOn && l.kind === 'working' ? setE1rm(l) : null;
          return (
            <div key={l.id} className={'set-grid set-row ghost ' + l.kind} data-effort={effortOn} data-score={scoreOn}>
              <span className="set-no num">{l.kind === 'warmup' ? 'W' : l.kind === 'drop' ? '↓' : l.setNo}{l.side !== 'both' && <small>{l.side === 'left' ? 'L' : 'R'}</small>}</span>
              <span className="cell num">{l.loadKg != null ? fmtWeight(l.loadKg, unit, false) : '–'}</span>
              <span className="cell num">{l.reps ?? '–'}</span>
              {effortOn && <span className="cell num">{e != null ? <EffortCell text={e} /> : '–'}</span>}
              {scoreOn && <span className={'cell num' + (ps && (!ps.reliable || ps.lowerBound) ? ' rough' : '')}>{ps ? scoreText(ps) : ''}</span>}
              <span />
            </div>
          );
        })}
      </Link>

      <Sheet open={effortInfo} onClose={() => setEffortInfo(false)} title={settings.effortMode === 'rir' ? 'Reps in reserve (RIR)' : 'Rate of perceived exertion (RPE)'}>
        <EffortExplainer mode={settings.effortMode} />
      </Sheet>
      <Sheet open={scoreInfo} onClose={() => setScoreInfo(false)} title="Estimated 1-rep max">
        <ScoreExplainer />
      </Sheet>
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

/** Effort value; an entry on the other scale ("4 RIR" in RPE mode) shows its scale in small type so the cell stays compact. */
function EffortCell({ text }: { text: string }) {
  const m = /^(RPE) (.+)$|^(.+) (RIR)$/.exec(text);
  if (!m) return <>{text}</>;
  return m[1] ? <><small className="eff-scale">{m[1]}</small>{m[2]}</> : <>{m[3]}<small className="eff-scale">{m[4]}</small></>;
}

/** What the e1RM column means (header tap). */
function ScoreExplainer() {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="muted t-15" style={{ margin: 0, lineHeight: 1.45 }}>The heaviest single you could lift today, estimated from the set: the reps you did plus reps in reserve, through the Wathen equation. One number to compare sets of different weights and reps.</p>
      <p className="muted t-15" style={{ margin: 0, lineHeight: 1.45 }}><b>≥</b> no RIR logged: from reps alone, so the real value is at least this. <b>≈</b> more than 12 reps to failure: rough. <span className="score best inline">Green</span> beats your best so far.</p>
      <p className="faint t-13" style={{ margin: 0 }}>Wathen 1994 · LeSuer et al. 1997 · Reynolds et al. 2006 · RIR: Zourdos et al. 2016</p>
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
      <button className="icon-btn filled" aria-label="Remove set" onClick={() => change(-1)} disabled={item.sets <= 1}><Icon name="minus" size={18} /></button>
      <span className="faint num t-13" style={{ minWidth: 56, textAlign: 'center' }} aria-live="polite">{plural(item.sets, 'set', 'sets')}</span>
      <button className="icon-btn filled" aria-label="Add set" onClick={() => change(1)} disabled={item.sets >= MAX_SETS}><Icon name="plus" size={18} /></button>
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
      <span className={'grow' + (value ? '' : ' faint')}>{value || 'Note'}</span>
      <Icon name="note" size={20} />
    </button>
  );
}
function NoteEditor({ value, onSave, onDone }: { value?: string; onSave: (v?: string) => void; onDone: () => void }) {
  const [draft, setDraft] = useState(value ?? '');
  const flush = useAutosave(draft, value, onSave);
  const commit = () => { flush(); onDone(); };
  // Return = new line (a note can have several); ✓ (or tapping away) closes it. Saved as you type either way.
  const grow = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 220)}px`; } };
  return (
    <div className="note-line editing">
      <textarea ref={grow} autoFocus rows={2} value={draft} placeholder="Seat 4, grip, cues…" aria-label="Exercise note"
        onChange={(e) => { setDraft(e.target.value); grow(e.target); }} onBlur={commit} />
      {/* pointerdown keeps focus in the textarea, so the blur doesn't unmount the editor under the tap */}
      <button className="note-done pressable" aria-label="Done" onPointerDown={(e) => e.preventDefault()} onClick={commit}><Icon name="check" size={18} stroke={2.8} /></button>
    </div>
  );
}


/** Floating rest timer: a round button when idle (tap = start a rest now), the full bar while resting. */
function RestBar({ onStart }: { onStart: () => void }) {
  const st = useRest();
  const now = useTick(!!st, 250);
  const shell = document.querySelector(".shell");
  if (!st) {
    const fab = <button className="rest-fab pressable" onClick={onStart} aria-label="Start rest timer"><Icon name="timer" size={28} stroke={2} /></button>;
    return shell ? createPortal(fab, shell) : fab;
  }
  const elapsed = (now - st.startedAt) / 1000;
  const countdown = st.targetSec != null;
  const left = countdown ? st.targetSec! - elapsed : 0;
  const over = countdown && left <= 0;
  const pct = countdown ? Math.min(1, elapsed / Math.max(1, st.targetSec!)) : 0;
  const ann = <div className="sr-only" role="status">{over ? 'Rest over' : ''}</div>; // announced once, when it flips
  const bar = (
    <AnimatePresence>
      <motion.div className="restbar" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.35 }} role="timer" aria-live="off">
        {ann}
        <div className={'restbar-fill' + (over ? ' over' : '')} style={{ transform: `scaleX(${pct})` }} aria-hidden />
        <div className="row" style={{ position: 'relative' }}>
          <div className="grow">
            <div className="w-6" style={{ fontSize: '0.75rem', color: 'var(--text-2)' }}>{over ? 'Go' : 'Rest'}</div>
            <div className="num" style={{ fontSize: '1.5rem', fontWeight: 750, letterSpacing: '-0.02em', color: over ? 'var(--good)' : 'var(--text)' }}>
              {countdown ? (over ? '+' : '') + fmtDuration(Math.abs(left) * 1000) : fmtDuration(elapsed * 1000)}
            </div>
          </div>
          {countdown && <>
            <button className="btn" onClick={() => rest.adjust(-15)} aria-label="15 seconds less">−15</button>
            <button className="btn" onClick={() => rest.adjust(15)} aria-label="15 seconds more">+15</button>
          </>}
          <button className="btn" onClick={rest.stop} aria-label="Skip rest">Skip</button>
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
            <p className="muted" style={{ margin: '4px 2px' }}>{plural(unticked.length, 'set has', 'sets have')} values but {unticked.length === 1 ? 'isn’t' : 'aren’t'} ticked.</p>
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
          {partial ? `${plural(partial, 'half-filled set', 'half-filled sets')} will be dropped.` : 'Unchecked sets are dropped.'}
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
      </div>
      {/* main vs assisting muscles in words, next to the body map (secondary = lighter) */}
      <div className="ex-muscles">
        {ex.muscles.length > 0 && <MuscleMap primary={ex.muscles} secondary={ex.secondary} height={96} label={`Main: ${ex.muscles.join(', ')}`} />}
        <dl className="ex-muscle-list">
          <dt>Main</dt><dd>{ex.muscles.length ? ex.muscles.map(titleCase).join(', ') : '–'}</dd>
          <dt>Assists</dt><dd className="muted">{ex.secondary.length ? ex.secondary.map(titleCase).join(', ') : 'None'}</dd>
        </dl>
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
