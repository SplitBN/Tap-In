import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog } from '../components/Dialog';
import { AnimatePresence, motion } from 'motion/react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { createPortal } from 'react-dom';
import { ExercisePicker, ExerciseEditor, ExerciseThumb } from '../components/ExercisePicker';
import { Icon } from '../components/Icon';
import { ItemSettings } from '../components/ItemSettings';
import { EffortSheet, WeightSheet } from '../components/SetInputs';
import { Sheet } from '../components/Sheet';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db } from '../db/db';
import { lastPerformance, latestBodyweightKg, sessionDiffersFromPlan, setOrder } from '../db/gym';
import { run } from '../api/registry';
import { itemsAdd, itemsRemove, itemsReorder, itemsReplace, itemsSuperset, itemsUpdate, sessionsDelete, sessionsFinish, sessionsUpdate, setsLog } from '../api/gym';
import { exerciseImage } from '../db/seed';
import { useSettings } from '../db/settings';
import type { Exercise, Session, SetKind, SetLog, Settings, Side, WorkoutItem } from '../db/types';
import { fmtDuration, fmtNum, fmtWeight, relDay, titleCase } from '../lib/format';
import { rest, useRest, useTick, useWakeLock } from '../lib/rest';
import { defaultRestSec, suggestDrop, defaultStepKg } from '../lib/science';
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

export function SessionPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const settings = useSettings();
  const session = useLiveQuery(() => db.sessions.get(id!), [id]);
  const sets = useLiveQuery(() => db.sets.where('sessionId').equals(id!).filter(alive).toArray(), [id]) ?? [];
  const exMap = useExerciseMap(session?.items);
  const live = !!session && !session.endedAt;
  useWakeLock(live);
  const now = useTick(live, 1000);

  const [menu, setMenu] = useState<'item' | 'session' | 'finish' | 'info' | 'editEx' | 'details' | null>(null);
  const [picking, setPicking] = useState<null | 'add' | 'replace'>(null);

  if (!session) return null;
  if (!alive(session)) return <div className="page"><p className="empty">This workout was deleted. <Link to="/">Home</Link></p></div>;

  const items = session.items;
  const current = items.find((i) => i.key === session.currentKey) ?? items[0];
  const curIdx = items.findIndex((i) => i.key === current?.key);
  const ex = current ? exMap[current.exerciseId] : undefined;
  const t = { sessionId: session.id };
  const select = (key: string) => run(sessionsUpdate, { id: session.id, currentItemKey: key });
  const reorder = (next: WorkoutItem[]) => run(itemsReorder, { ...t, itemKeys: next.map((i) => i.key) });

  const isDone = (it: WorkoutItem) => {
    const e = exMap[it.exerciseId];
    const need = rowsFor(it, e, settings).flat().filter((r) => r.kind === 'working');
    return need.length > 0 && need.every((r) => sets.some((l) => l.itemKey === it.key && logId(l) === rowId(r) && l.doneAt));
  };
  const doneCount = sets.filter((s) => s.doneAt && s.kind !== 'warmup').length;

  return (
    <div className="page no-tabs" style={{ paddingTop: 0, paddingBottom: "calc(var(--safe-b) + 110px)" }}>
      {/* header */}
      <header style={{ position: 'sticky', top: 0, zIndex: 10, margin: '0 -16px', padding: 'calc(var(--safe-t) + 6px) 8px 8px',
        background: 'var(--chrome)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)' }}>
        <div className="row">
          <button className="icon-btn" aria-label="Back" onClick={() => nav(live ? '/' : '/history')}><Icon name="chevronLeft" /></button>
          <div className="grow" style={{ textAlign: 'center' }}>
            <div className="ellipsis" style={{ fontWeight: 650 }}>{session.name}</div>
            <div className="num muted" style={{ fontSize: '0.8125rem' }}>
              {live ? fmtDuration(now - session.startedAt) : `${relDay(session.startedAt)} · ${fmtDuration((session.endedAt ?? now) - session.startedAt)}`}
            </div>
          </div>
          <button className="icon-btn" aria-label="Workout options" onClick={() => setMenu('session')}><Icon name="more" /></button>
          {live && <button className="round-btn finish" aria-label="Finish workout" onClick={() => setMenu('finish')}><Icon name="flag" size={18} stroke={2.2} /></button>}
        </div>
        <ExerciseStrip items={items} exMap={exMap} currentKey={current?.key} isDone={isDone}
          onSelect={select} onReorder={reorder} onAdd={() => setPicking('add')} />
      </header>

      {current && ex ? (
        <ExercisePanel key={current.key} session={session} item={current} ex={ex} sets={sets.filter((s) => s.itemKey === current.key)}
          settings={settings} onMenu={() => setMenu('item')}
          onSetDone={(row) => afterSetDone(row, current, curIdx, items, exMap, settings, live, select)} />
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
      <Sheet open={menu === 'item' && !!current} onClose={() => setMenu(null)} title={ex?.name}>
        {current && (
          <>
            <ItemSettings item={current} exercise={ex} settings={settings} onChange={(n) => run(itemsUpdate, { ...t, itemKey: n.key, patch: itemPatch(current, n) })} />
            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
              {curIdx < items.length - 1 && (() => {
                const linked = !!current.supersetId && current.supersetId === items[curIdx + 1]?.supersetId;
                return <button className="menu-item" onClick={() => run(itemsSuperset, { ...t, itemKey: current.key })}>
                  <Icon name={linked ? 'unlink' : 'link'} /><span className="grow ellipsis">{linked ? 'Unlink superset' : `Superset + ${exMap[items[curIdx + 1].exerciseId]?.name ?? 'next'}`}</span>
                </button>;
              })()}
              <button className="menu-item" onClick={() => { setMenu(null); setPicking('replace'); }}><Icon name="swap" />Replace</button>
              <button className="menu-item" onClick={() => setMenu('info')}><Icon name="info" />How-to</button>
              <button className="menu-item" onClick={() => setMenu('editEx')}><Icon name="edit" />Edit exercise</button>
              {curIdx > 0 && <button className="menu-item" onClick={() => reorder(moveItem(items, curIdx, -1))}><Icon name="chevronLeft" />Move left</button>}
              {curIdx < items.length - 1 && <button className="menu-item" onClick={() => reorder(moveItem(items, curIdx, 1))}><Icon name="chevronRight" />Move right</button>}
              <button className="menu-item danger" onClick={async () => {
                const mine = sets.filter((x) => x.itemKey === current.key);
                const doneN = mine.filter((x) => x.doneAt).length;
                if (doneN) {
                  setMenu(null);
                  if (!(await confirmDialog({ title: `Remove ${ex?.name ?? 'exercise'}?`, message: `Its ${doneN} logged set${doneN === 1 ? '' : 's'} will be deleted.`, confirm: 'Remove exercise', danger: true }))) return;
                }
                await run(itemsRemove, { ...t, itemKey: current.key }); setMenu(null);
              }}><Icon name="trash" />Remove</button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet open={menu === 'info'} onClose={() => setMenu(null)} title={ex?.name}>
        {ex && <ExerciseInfo ex={ex} />}
      </Sheet>
      <ExerciseEditor open={menu === 'editEx'} exercise={ex} onClose={() => setMenu(null)} />

      <Sheet open={menu === 'session'} onClose={() => setMenu(null)} title="Workout">
        <button className="menu-item" onClick={() => { setMenu(null); setPicking('add'); }}><Icon name="plus" />Add exercise</button>
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
      <FinishSheet open={menu === 'finish'} onClose={() => setMenu(null)} session={session} doneCount={doneCount}
        onFinished={() => { rest.stop(); nav(`/session/${session.id}`, { replace: true }); }} />

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

/** After a set is checked: start rest and move through supersets. */
function afterSetDone(row: Row, it: WorkoutItem, idx: number, items: WorkoutItem[], exMap: Record<string, Exercise>, s: Settings, live: boolean,
  select: (key: string) => void) {
  if (!live) return;
  if (row.side === 'left') return; // right side follows straight away
  if (row.kind === 'working' && (it.drops ?? 0) > 0) return; // drops follow immediately, no rest
  if (row.kind === 'drop' && row.dropNo !== it.drops) return;
  // supersets: go to the next exercise in the group, rest only after the round
  if (it.supersetId) {
    const nextInGroup = items[idx + 1]?.supersetId === it.supersetId ? items[idx + 1] : undefined;
    if (nextInGroup) { select(nextInGroup.key); return; }
    const first = items.findIndex((x) => x.supersetId === it.supersetId);
    select(items[first].key);
  }
  if (!s.features.restTimer) return;
  const ex = exMap[it.exerciseId];
  const sec = it.rest.mode === 'countup' ? undefined : it.rest.sec ?? (ex ? defaultRestSec(ex.mechanic, s.restCompoundSec, s.restIsolationSec) : 120);
  rest.start(sec, ex?.name);
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
                aria-label={(ex?.name ?? 'Exercise') + (isDone(it) ? ', done' : '')}
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

function ExercisePanel({ session, item, ex, sets, settings, onMenu, onSetDone }: {
  session: Session; item: WorkoutItem; ex: Exercise; sets: SetLog[]; settings: Settings; onMenu: () => void; onSetDone: (r: Row) => void;
}) {
  const prev = useLiveQuery(() => lastPerformance(ex.id, session.id), [ex.id, session.id]);
  const bw = useLiveQuery(() => latestBodyweightKg(), []);
  const [weightFor, setWeightFor] = useState<Row | null>(null);
  const [effortFor, setEffortFor] = useState<Row | null>(null);
  const groups = useMemo(() => rowsFor(item, ex, settings), [item, ex, settings]);
  const byId = useMemo(() => new Map(sets.map((l) => [logId(l), l])), [sets]);
  const prevById = useMemo(() => new Map((prev?.sets ?? []).map((l) => [logId(l), l])), [prev]);
  const unit = settings.unit;
  const loadLabel = ex.loadType === 'bodyweight' ? `+${unit}` : ex.loadType === 'assisted' ? `assist` : unit;
  const effortOn = settings.features.effort;
  const img = exerciseImage(ex);
  const [imgIdx, setImgIdx] = useState(0);

  /** Value shown greyed when nothing is entered yet: previous session's same row, or a drop suggestion. */
  const suggestion = (r: Row): Partial<SetLog> | undefined => {
    if (r.kind === 'drop') {
      const parentRow: Row = r.dropNo === 1 ? { ...r, kind: 'working', dropNo: undefined } : { ...r, dropNo: r.dropNo! - 1 };
      const parentLoad = byId.get(rowId(parentRow))?.loadKg ?? suggestion(parentRow)?.loadKg;
      const p = prevById.get(rowId(r));
      if (parentLoad != null) return { loadKg: suggestDrop(parentLoad, ex.stepKg ?? defaultStepKg(ex.equipment, unit)), reps: p?.reps };
      return p;
    }
    const p = prevById.get(rowId(r));
    if (p) return p;
    // same row of the previous set in this session (carry weight forward)
    if (r.setNo > 1) {
      const above = byId.get(rowId({ ...r, setNo: r.setNo - 1 }));
      if (above) return { loadKg: above.loadKg, reps: above.reps };
    }
    return undefined;
  };

  /** Writes one set row via sets.log (which also snapshots load type, bodyweight and input unit). done defaults to the row's current state. */
  type SetPatch = { loadKg?: number | null; reps?: number | null; rir?: number | null; rpe?: number | null; done?: boolean };
  const upsert = (r: Row, patch: SetPatch) => run(setsLog, {
    sessionId: session.id, itemKey: item.key, setNo: r.setNo, kind: r.kind, dropNo: r.dropNo, side: r.side,
    ...patch, done: patch.done ?? !!byId.get(rowId(r))?.doneAt,
  });

  // Sets complete strictly in order: the first not-done row is the only live one.
  const flat = groups.flat();
  const activeIdx = flat.findIndex((r) => !byId.get(rowId(r))?.doneAt);
  const lastDoneIdx = activeIdx === -1 ? flat.length - 1 : activeIdx - 1;
  const [shakeId, setShakeId] = useState<string>();

  /** Values a set would be saved with: what was typed, else the greyed suggestion. */
  const resolved = (r: Row) => {
    const cur = byId.get(rowId(r));
    const sug = suggestion(r);
    return {
      loadKg: cur?.loadKg ?? sug?.loadKg ?? (ex.loadType === 'weighted' ? null : 0),
      reps: cur?.reps ?? sug?.reps ?? item.repsMax ?? item.repsMin ?? null,
    };
  };

  const toggleDone = async (r: Row, idx: number) => {
    const cur = byId.get(rowId(r));
    if (cur?.doneAt) {
      if (idx === lastDoneIdx) await upsert(r, { done: false }); // only the latest set can be un-done
      return;
    }
    if (idx !== activeIdx) return;
    const v = resolved(r);
    if (v.loadKg == null || v.reps == null) { // no partial sets
      setShakeId(rowId(r)); setTimeout(() => setShakeId(undefined), 340);
      if (v.loadKg == null) setWeightFor(r);
      return;
    }
    await upsert(r, { ...v, done: true });
    onSetDone(r);
  };

  const setReps = (r: Row, v: string) => upsert(r, { reps: v === '' ? null : Math.max(0, parseInt(v, 10) || 0) });
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
          <h2 style={{ margin: 0, fontSize: '1.5rem', lineHeight: 1.12, letterSpacing: '-0.025em', fontWeight: 800, color: 'var(--accent)' }}>{ex.name}</h2>
          <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 3 }}>{titleCase(ex.muscles.join(', '))}</div>
          <div className="tags">
            {item.repsMin != null && <span className="tag"><Icon name="flag" size={12} stroke={2.2} />{item.repsMin}{item.repsMax && item.repsMax !== item.repsMin ? `–${item.repsMax}` : ''}</span>}
            {ex.unilateral && <span className="tag">L | R</span>}
            {item.supersetId && <span className="tag role"><Icon name="link" size={12} stroke={2.2} />SS</span>}
            {(item.drops ?? 0) > 0 && <span className="tag drop">↓ {item.drops}</span>}
            {ex.loadType !== 'weighted' && bw == null && <span className="tag warn"><Icon name="scale" size={12} stroke={2.2} />BW?</span>}
          </div>
        </div>
        <button className="icon-btn filled" aria-label="Exercise options" onClick={onMenu}><Icon name="more" /></button>
      </div>
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
                const ready = state === 'active' && v.loadKg != null && v.reps != null;
                const repsPh = sug?.reps != null ? String(sug.reps) : item.repsMin != null ? String(item.repsMax ?? item.repsMin) : '–';
                return (
                  <motion.div key={rowId(r)} layout="position" data-effort={effortOn}
                    className={`set-grid set-row ${state} ${r.kind}` + (shakeId === rowId(r) ? ' shake' : '')}>
                    <span className="set-no num">
                      {r.side === 'right' && g.length > 1 ? '' : label}
                      {r.side !== 'both' && <small>{r.side === 'left' ? 'L' : 'R'}</small>}
                    </span>
                    <button className="cell num" onClick={() => setWeightFor(r)} aria-label={`Weight, set ${label}`} tabIndex={state === 'future' ? -1 : 0}>
                      {l?.loadKg != null ? fmtWeight(l.loadKg, unit, false) : <span className="ph">{sug?.loadKg != null ? fmtWeight(sug.loadKg, unit, false) : '–'}</span>}
                    </button>
                    {state === 'future'
                      ? <span className="cell num" style={{ display: 'grid', placeItems: 'center' }}>{repsPh}</span>
                      : <input className="cell num" inputMode="numeric" enterKeyHint="done" aria-label={`Reps, set ${label}`}
                          value={l?.reps ?? ''} placeholder={repsPh}
                          onChange={(e) => setReps(r, e.target.value)} onFocus={(e) => e.target.select()} />}
                    {effortOn && (
                      <button className="cell num" onClick={() => setEffortFor(r)} aria-label={`Effort, set ${label}`} tabIndex={state === 'future' ? -1 : 0}>
                        {effortVal(l) != null ? fmtNum(effortVal(l)!) : <span className="ph">{effortVal(sug) != null ? fmtNum(effortVal(sug)!) : '–'}</span>}
                      </button>
                    )}
                    <button className={'check' + (done ? ' on' : ready ? ' ready' : '') + (state === 'future' ? ' locked' : '')}
                      onClick={() => toggleDone(r, idx)} aria-pressed={done} disabled={state === 'future'}
                      aria-label={done ? (idx === lastDoneIdx ? `Undo set ${label}` : `Set ${label} done`) : `Complete set ${label}`}>
                      <Icon name="check" size={20} stroke={2.8} />
                    </button>
                  </motion.div>
                );
              })}
            </Fragment>
          );
        })}
        <div className="row" style={{ justifyContent: 'center', gap: 4, padding: '6px 0 2px' }}>
          <SetCountButtons item={item} session={session} />
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

      <WeightSheet open={!!weightFor} onClose={() => setWeightFor(null)} unit={unit} exercise={ex}
        label={ex.loadType === 'bodyweight' ? 'Added weight' : ex.loadType === 'assisted' ? 'Assistance' : 'Weight'}
        valueKg={weightFor ? byId.get(rowId(weightFor))?.loadKg ?? suggestion(weightFor)?.loadKg : null}
        onDone={(kg) => weightFor && upsert(weightFor, { loadKg: kg })} />
      <EffortSheet open={!!effortFor} onClose={() => setEffortFor(null)} mode={settings.effortMode}
        value={effortFor ? effortVal(byId.get(rowId(effortFor))) : null}
        onDone={(v, mode) => effortFor && upsert(effortFor, v == null ? { rir: null, rpe: null } : mode === 'rir' ? { rir: v } : { rpe: v })} />
    </div>
  );
}

const MAX_SETS = 20; // items.update limit

function SetCountButtons({ item, session }: { item: WorkoutItem; session: Session }) {
  const change = (d: number) => run(itemsUpdate, { sessionId: session.id, itemKey: item.key, patch: { sets: Math.min(MAX_SETS, Math.max(1, item.sets + d)) } });
  return (
    <>
      <button className="icon-btn filled" aria-label="Remove a set" onClick={() => change(-1)} disabled={item.sets <= 1}><Icon name="minus" size={18} /></button>
      <span className="faint num" style={{ fontSize: '0.8125rem', minWidth: 48, textAlign: 'center' }}>{item.sets} sets</span>
      <button className="icon-btn filled" aria-label="Add a set" onClick={() => change(1)} disabled={item.sets >= MAX_SETS} style={{ color: 'var(--accent)' }}><Icon name="plus" size={18} /></button>
    </>
  );
}

/** Exercise note, editable in place (pencil). Saved to the session copy; finishing offers to keep it in the plan. */
function NoteLine({ value, onSave }: { value?: string; onSave: (v?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const commit = () => { setEditing(false); const v = draft.trim() || undefined; if (v !== value) onSave(v); };
  if (editing) {
    return (
      <div className="note-line editing">
        <Icon name="pencil" size={16} />
        <textarea autoFocus rows={2} value={draft} placeholder="Seat 4, grip, cues…" aria-label="Exercise note"
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); } }} />
      </div>
    );
  }
  return (
    <button className="note-line pressable" onClick={() => { setDraft(value ?? ''); setEditing(true); }} aria-label={value ? `Edit note: ${value}` : 'Add note'}>
      <Icon name="pencil" size={16} />
      <span className={value ? '' : 'faint'}>{value || 'Note'}</span>
    </button>
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

function FinishSheet({ open, onClose, session, doneCount, onFinished }: { open: boolean; onClose: () => void; session: Session; doneCount: number; onFinished: () => void }) {
  const differs = useLiveQuery(() => (open ? sessionDiffersFromPlan(session) : Promise.resolve(false)), [open, session]);
  const go = async (updatePlan: boolean) => { await run(sessionsFinish, { id: session.id, updatePlan }); onClose(); onFinished(); };
  return (
    <Sheet open={open} onClose={onClose} title="Finish workout?">
      <div className="stack" style={{ gap: 12 }}>
        <div className="row card" style={{ background: 'var(--card-2)' }}>
          <div className="grow"><div className="muted" style={{ fontSize: '0.8125rem' }}>Duration</div><div className="num" style={{ fontWeight: 700, fontSize: '1.25rem' }}>{fmtDuration(Date.now() - session.startedAt)}</div></div>
          <div className="grow"><div className="muted" style={{ fontSize: '0.8125rem' }}>Sets done</div><div className="num" style={{ fontWeight: 700, fontSize: '1.25rem' }}>{doneCount}</div></div>
        </div>
        {differs ? (
          <>
            <p className="muted" style={{ margin: '4px 2px' }}>Workout changed. Save to plan?</p>
            <button className="btn primary lg block" onClick={() => go(true)}><Icon name="check" size={18} /> Save to plan</button>
            <button className="btn lg block" onClick={() => go(false)}>Just this time</button>
          </>
        ) : <button className="btn good lg block" onClick={() => go(false)}>Finish workout</button>}
        <p className="faint" style={{ margin: 0, fontSize: '0.8125rem', textAlign: 'center' }}>Unchecked sets are dropped.</p>
      </div>
    </Sheet>
  );
}

function NotesField({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  return (
    <label className="field" style={{ margin: '8px 0' }}><span>Workout notes</span>
      <textarea className="input" rows={3} style={{ padding: 12, resize: 'vertical' }} defaultValue={value ?? ''}
        placeholder="How it felt, sleep, anything worth remembering" onBlur={(e) => onChange(e.target.value || undefined)} />
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
        <span className="badge">{titleCase(ex.mechanic)}</span><span className="badge">{titleCase(ex.equipment)}</span>
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
