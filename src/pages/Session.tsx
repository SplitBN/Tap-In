import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion } from 'motion/react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ExercisePicker, ExerciseEditor, ExerciseThumb } from '../components/ExercisePicker';
import { Icon } from '../components/Icon';
import { ItemSettings, normalizeSupersets, toggleSupersetWithNext } from '../components/ItemSettings';
import { EffortSheet, WeightSheet, fmtNum } from '../components/SetInputs';
import { Sheet } from '../components/Sheet';
import { SortableItem, SortableList } from '../components/Sortable';
import { alive, db, newRecord, remove, save } from '../db/db';
import { finishSession, lastPerformance, latestBodyweightKg, newItem, sessionDiffersFromPlan, setOrder } from '../db/gym';
import { exerciseImage } from '../db/seed';
import { useSettings } from '../db/settings';
import type { Exercise, Session, SetKind, SetLog, Settings, Side, WorkoutItem } from '../db/types';
import { fmtDuration, fmtWeight, relDay, titleCase } from '../lib/format';
import { rest, useRest, useTick, useWakeLock } from '../lib/rest';
import { defaultRestSec, rirToRpe, rpeToRir, suggestDrop, defaultStepKg } from '../lib/science';
import { groupPos, useExerciseMap } from './WorkoutEditor';

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

  const [menu, setMenu] = useState<'item' | 'session' | 'finish' | 'info' | 'editEx' | null>(null);
  const [picking, setPicking] = useState<null | 'add' | 'replace'>(null);

  if (!session) return null;
  if (!alive(session)) return <div className="page"><p className="empty">This workout was deleted. <Link to="/">Home</Link></p></div>;

  const items = session.items;
  const current = items.find((i) => i.key === session.currentKey) ?? items[0];
  const curIdx = items.findIndex((i) => i.key === current?.key);
  const ex = current ? exMap[current.exerciseId] : undefined;
  const update = (patch: Partial<Session>) => save('sessions', { ...session, ...patch, items: normalizeSupersets(patch.items ?? session.items) });
  const setItems = (next: WorkoutItem[]) => update({ items: next, currentKey: next.some((i) => i.key === session.currentKey) ? session.currentKey : next[0]?.key });

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
          {live && <button className="btn good" style={{ minHeight: 36, padding: '0 14px' }} onClick={() => setMenu('finish')}>Finish</button>}
        </div>
        <ExerciseStrip items={items} exMap={exMap} currentKey={current?.key} isDone={isDone}
          onSelect={(k) => update({ currentKey: k })} onReorder={setItems} onAdd={() => setPicking('add')} />
      </header>

      {current && ex ? (
        <ExercisePanel key={current.key} session={session} item={current} ex={ex} sets={sets.filter((s) => s.itemKey === current.key)}
          settings={settings} onMenu={() => setMenu('item')}
          onSetDone={(row) => afterSetDone(row, current, curIdx, items, exMap, settings, live, update)} />
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
            <ItemSettings item={current} exercise={ex} settings={settings} onChange={(n) => setItems(items.map((i) => (i.key === n.key ? n : i)))} />
            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
              {curIdx < items.length - 1 && (() => {
                const linked = !!current.supersetId && current.supersetId === items[curIdx + 1]?.supersetId;
                return <button className="menu-item" onClick={() => setItems(toggleSupersetWithNext(items, curIdx))}>
                  <Icon name={linked ? 'unlink' : 'link'} />{linked ? 'Unlink from next exercise' : `Superset with ${exMap[items[curIdx + 1].exerciseId]?.name ?? 'next'}`}
                </button>;
              })()}
              <button className="menu-item" onClick={() => { setMenu(null); setPicking('replace'); }}><Icon name="swap" />Replace exercise</button>
              <button className="menu-item" onClick={() => setMenu('info')}><Icon name="info" />How to do it</button>
              <button className="menu-item" onClick={() => setMenu('editEx')}><Icon name="edit" />Edit exercise (type, one side…)</button>
              <button className="menu-item danger" onClick={async () => {
                for (const s of sets.filter((x) => x.itemKey === current.key)) await remove('sets', s.id);
                setItems(items.filter((i) => i.key !== current.key)); setMenu(null);
              }}><Icon name="trash" />Remove from workout</button>
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
        <NotesField value={session.notes} onChange={(notes) => update({ notes })} />
        {!live && <button className="menu-item" onClick={() => update({ endedAt: null })}><Icon name="play" />Resume this workout</button>}
        <button className="menu-item danger" onClick={async () => {
          if (!confirm(live ? 'Discard this workout? Logged sets will be deleted.' : 'Delete this workout from history?')) return;
          for (const s of sets) await remove('sets', s.id);
          await remove('sessions', session.id); rest.stop(); nav('/');
        }}><Icon name="trash" />{live ? 'Discard workout' : 'Delete workout'}</button>
      </Sheet>

      <FinishSheet open={menu === 'finish'} onClose={() => setMenu(null)} session={session} doneCount={doneCount}
        onFinished={() => { rest.stop(); nav(`/session/${session.id}`, { replace: true }); }} />

      <ExercisePicker open={!!picking} title={picking === 'replace' ? 'Replace exercise' : 'Add exercise'} onClose={() => setPicking(null)}
        onPick={async ([e]) => {
          if (picking === 'replace' && current) {
            for (const s of sets.filter((x) => x.itemKey === current.key && !x.doneAt)) await remove('sets', s.id);
            setItems(items.map((i) => (i.key === current.key ? { ...i, exerciseId: e.id, rest: { mode: i.rest.mode } } : i)));
          } else {
            const it = newItem(e);
            update({ items: [...items, it], currentKey: it.key });
          }
        }} />
    </div>
  );
}

/** After a set is checked: start rest and move through supersets. */
function afterSetDone(row: Row, it: WorkoutItem, idx: number, items: WorkoutItem[], exMap: Record<string, Exercise>, s: Settings, live: boolean,
  update: (p: Partial<Session>) => void) {
  if (!live) return;
  if (row.side === 'left') return; // right side follows straight away
  if (row.kind === 'working' && (it.drops ?? 0) > 0) return; // drops follow immediately, no rest
  if (row.kind === 'drop' && row.dropNo !== it.drops) return;
  // supersets: go to the next exercise in the group, rest only after the round
  if (it.supersetId) {
    const nextInGroup = items[idx + 1]?.supersetId === it.supersetId ? items[idx + 1] : undefined;
    if (nextInGroup) { update({ currentKey: nextInGroup.key }); return; }
    const first = items.findIndex((x) => x.supersetId === it.supersetId);
    update({ currentKey: items[first].key });
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
    <div ref={ref} className="chips" style={{ marginTop: 8, padding: '2px 8px', gap: 0 }}>
      <SortableList items={items} onReorder={onReorder} horizontal>
        {items.map((it, i) => {
          const g = groupPos(items, i);
          const cur = it.key === currentKey;
          const done = isDone(it);
          const name = exMap[it.exerciseId]?.name ?? '…';
          const tube = g !== 'solo';
          return (
            <SortableItem key={it.key} id={it.key} style={{
              flex: 'none',
              marginLeft: g === 'mid' || g === 'last' ? 0 : i ? 6 : 0,
              padding: tube ? '3px' : 0,
              paddingLeft: tube && g !== 'first' ? 1.5 : undefined, paddingRight: tube && g !== 'last' ? 1.5 : undefined,
              background: tube ? 'var(--accent-soft)' : undefined,
              borderRadius: tube ? (g === 'first' ? '999px 0 0 999px' : g === 'last' ? '0 999px 999px 0' : 0) : undefined,
            }}>
              <button data-current={cur} onClick={() => onSelect(it.key)} className="chip pressable"
                aria-current={cur ? 'step' : undefined}
                style={{
                  minHeight: 34, maxWidth: 170, color: cur ? 'var(--accent-text)' : done ? 'var(--text-2)' : 'var(--text)',
                  background: cur ? 'var(--accent)' : 'var(--card-2)', fontWeight: cur ? 650 : 560,
                }}>
                {done && <Icon name="check" size={15} stroke={2.6} className={cur ? undefined : 'done-check'} />}
                <span className="ellipsis">{shortName(name)}</span>
              </button>
            </SortableItem>
          );
        })}
      </SortableList>
      <button className="chip pressable" onClick={onAdd} aria-label="Add exercise" style={{ marginLeft: 6, minHeight: 34, color: 'var(--accent)' }}><Icon name="plus" size={16} /></button>
    </div>
  );
}
const shortName = (n: string) => n.replace(/\s*-\s*/g, ' ');

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

  const upsert = async (r: Row, patch: Partial<SetLog>) => {
    const existing = byId.get(rowId(r));
    const base = existing ?? newRecord({
      sessionId: session.id, itemKey: item.key, exerciseId: ex.id, setNo: r.setNo, kind: r.kind, dropNo: r.dropNo, side: r.side,
      loadType: ex.loadType, inputUnit: unit, loadKg: null, reps: null, doneAt: null,
    } as Omit<SetLog, 'id' | 'createdAt' | 'updatedAt'>);
    await save('sets', { ...base, ...patch, loadType: ex.loadType, bodyweightKg: ex.loadType === 'weighted' ? null : bw ?? null });
  };

  const toggleDone = async (r: Row) => {
    const cur = byId.get(rowId(r));
    if (cur?.doneAt) return upsert(r, { doneAt: null });
    const sug = suggestion(r);
    await upsert(r, {
      loadKg: cur?.loadKg ?? sug?.loadKg ?? (ex.loadType === 'weighted' ? null : 0),
      reps: cur?.reps ?? sug?.reps ?? item.repsMax ?? item.repsMin ?? null,
      doneAt: Date.now(), inputUnit: unit,
    });
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
            <img src={exerciseImage(ex, imgIdx)} alt="" style={{ width: 96, height: 96, borderRadius: 16, objectFit: 'cover', background: 'var(--card-2)' }} />
          </button>
        ) : <ExerciseThumb ex={ex} size={96} />}
        <div className="grow" style={{ paddingTop: 4 }}>
          <h2 style={{ margin: 0, fontSize: '1.375rem', lineHeight: 1.15, letterSpacing: '-0.015em' }}>{ex.name}</h2>
          <div className="muted" style={{ fontSize: '0.875rem', marginTop: 4 }}>
            {[titleCase(ex.muscles.join(', ')), item.repsMin != null && `target ${item.repsMin}${item.repsMax && item.repsMax !== item.repsMin ? `–${item.repsMax}` : ''} reps`, ex.unilateral && 'each side'].filter(Boolean).join(' · ')}
          </div>
          {item.supersetId && <span className="badge accent" style={{ marginTop: 6 }}>Superset</span>}
          {ex.loadType !== 'weighted' && bw == null && <div style={{ fontSize: '0.8125rem', color: 'var(--warn)', marginTop: 6 }}>Log your bodyweight to track total load.</div>}
        </div>
        <button className="icon-btn filled" aria-label="Exercise options" onClick={onMenu}><Icon name="more" /></button>
      </div>
      {item.notes && <p className="muted" style={{ margin: '10px 2px 0', fontSize: '0.875rem' }}>📝 {item.notes}</p>}

      {/* set table */}
      <div className="card" style={{ marginTop: 14, padding: '6px 8px' }}>
        <div className="set-grid set-head" data-effort={effortOn}>
          <span>Set</span><span>{loadLabel}</span><span>Reps</span>{effortOn && <span>{settings.effortMode.toUpperCase()}</span>}<span />
        </div>
        {groups.map((g) => {
          const head = g[0];
          if (head.kind === 'working') workNo++;
          const label = head.kind === 'warmup' ? `W${head.setNo}` : head.kind === 'drop' ? '↳' : String(workNo);
          return (
            <Fragment key={rowId(head)}>
              {g.map((r) => {
                const l = byId.get(rowId(r));
                const sug = suggestion(r);
                const done = !!l?.doneAt;
                const loadKg = l?.loadKg;
                return (
                  <motion.div key={rowId(r)} layout="position" className={'set-grid set-row' + (done ? ' done' : '') + (r.kind !== 'working' ? ' ' + r.kind : '')} data-effort={effortOn}>
                    <span className="set-no num">
                      {r.side === 'right' && g.length > 1 ? '' : label}
                      {r.side !== 'both' && <small>{r.side === 'left' ? 'L' : 'R'}</small>}
                    </span>
                    <button className="cell num" onClick={() => setWeightFor(r)} aria-label={`Weight, set ${label}`}>
                      {loadKg != null ? fmtWeight(loadKg, unit, false) : <span className="ph">{sug?.loadKg != null ? fmtWeight(sug.loadKg, unit, false) : '–'}</span>}
                    </button>
                    <input className="cell num" inputMode="numeric" enterKeyHint="done" aria-label={`Reps, set ${label}`}
                      value={l?.reps ?? ''} placeholder={sug?.reps != null ? String(sug.reps) : item.repsMin != null ? String(item.repsMax ?? item.repsMin) : '–'}
                      onChange={(e) => setReps(r, e.target.value)} onFocus={(e) => e.target.select()} />
                    {effortOn && (
                      <button className="cell num" onClick={() => setEffortFor(r)} aria-label={`Effort, set ${label}`}>
                        {effortVal(l) != null ? fmtNum(effortVal(l)!) : <span className="ph">{effortVal(sug) != null ? fmtNum(effortVal(sug)!) : '–'}</span>}
                      </button>
                    )}
                    <button className={'check' + (done ? ' on' : '')} onClick={() => toggleDone(r)} aria-label={done ? `Undo set ${label}` : `Complete set ${label}`} aria-pressed={done}>
                      <Icon name="check" size={20} stroke={2.6} />
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

      {/* history */}
      <div className="section-title">Last time</div>
      <Link to={`/exercise/${ex.id}`} className="card pressable" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
        {prev?.sets.length ? (
          <>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="grow muted" style={{ fontSize: '0.8125rem' }}>{prev.session ? relDay(prev.session.startedAt) : ''}</span>
              <span style={{ color: 'var(--accent)', fontSize: '0.8125rem', fontWeight: 600 }}>History</span>
              <Icon name="chevronRight" size={16} className="chev" />
            </div>
            <div className="chips" style={{ flexWrap: 'wrap' }}>
              {prev.sets.sort(setOrder).map((l) => (
                <span key={l.id} className="badge num" style={{ minHeight: 26, fontSize: '0.8125rem' }}>
                  {l.kind === 'warmup' ? 'W ' : l.kind === 'drop' ? '↳ ' : ''}{l.side !== 'both' ? l.side[0].toUpperCase() + ' ' : ''}
                  {setText(l, unit, settings.effortMode)}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="row"><span className="grow muted">First time doing this one.</span><Icon name="chevronRight" size={16} className="chev" /></div>
        )}
      </Link>

      <WeightSheet open={!!weightFor} onClose={() => setWeightFor(null)} unit={unit} exercise={ex}
        label={ex.loadType === 'bodyweight' ? 'Added weight' : ex.loadType === 'assisted' ? 'Assistance' : 'Weight'}
        valueKg={weightFor ? byId.get(rowId(weightFor))?.loadKg ?? suggestion(weightFor)?.loadKg : null}
        onDone={(kg) => weightFor && upsert(weightFor, { loadKg: kg, inputUnit: unit })} />
      <EffortSheet open={!!effortFor} onClose={() => setEffortFor(null)} mode={settings.effortMode}
        value={effortFor ? effortVal(byId.get(rowId(effortFor))) : null}
        onDone={(v, mode) => effortFor && upsert(effortFor, v == null
          ? { rir: null, rpe: null }
          : mode === 'rir' ? { rir: v, rpe: rirToRpe(v), effortInput: 'rir' } : { rpe: v, rir: rpeToRir(v), effortInput: 'rpe' })} />
    </div>
  );
}

function SetCountButtons({ item, session }: { item: WorkoutItem; session: Session }) {
  const change = (d: number) => save('sessions', { ...session, items: session.items.map((i) => (i.key === item.key ? { ...i, sets: Math.max(1, i.sets + d) } : i)) });
  return (
    <>
      <button className="btn ghost" onClick={() => change(1)}><Icon name="plus" size={16} /> Add set</button>
      {item.sets > 1 && <button className="btn ghost" style={{ color: 'var(--text-2)' }} onClick={() => change(-1)}><Icon name="minus" size={16} /> Remove</button>}
    </>
  );
}

export function setText(l: SetLog, unit: Settings['unit'], mode: Settings['effortMode']) {
  const load = l.loadType === 'weighted'
    ? fmtWeight(l.loadKg, unit)
    : l.loadType === 'bodyweight' ? (l.loadKg ? `BW+${fmtWeight(l.loadKg, unit)}` : 'BW') : `BW−${fmtWeight(l.loadKg, unit)}`;
  const eff = mode === 'rir' ? (l.rir != null ? ` @${fmtNum(l.rir)} RIR` : '') : (l.rpe != null ? ` @${fmtNum(l.rpe)}` : '');
  return `${load} × ${l.reps ?? '–'}${eff}`;
}

function RestBar() {
  const st = useRest();
  const now = useTick(!!st, 250);
  if (!st) return null;
  const elapsed = (now - st.startedAt) / 1000;
  const countdown = st.targetSec != null;
  const left = countdown ? st.targetSec! - elapsed : 0;
  const over = countdown && left <= 0;
  const pct = countdown ? Math.min(1, elapsed / Math.max(1, st.targetSec!)) : 0;
  return (
    <AnimatePresence>
      <motion.div className="restbar" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.35 }} role="timer" aria-live="off">
        <div className="restbar-fill" style={{ transform: `scaleX(${pct})`, background: over ? 'var(--good)' : 'var(--accent)' }} />
        <div className="row" style={{ position: 'relative' }}>
          <div className="grow">
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)' }}>{over ? 'Rest done — go' : 'Rest'}</div>
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
}

function FinishSheet({ open, onClose, session, doneCount, onFinished }: { open: boolean; onClose: () => void; session: Session; doneCount: number; onFinished: () => void }) {
  const differs = useLiveQuery(() => (open ? sessionDiffersFromPlan(session) : Promise.resolve(false)), [open, session]);
  const go = async (updatePlan: boolean) => { await finishSession(session, updatePlan); onClose(); onFinished(); };
  return (
    <Sheet open={open} onClose={onClose} title="Finish workout?">
      <div className="stack" style={{ gap: 12 }}>
        <div className="row card" style={{ background: 'var(--card-2)' }}>
          <div className="grow"><div className="muted" style={{ fontSize: '0.8125rem' }}>Duration</div><div className="num" style={{ fontWeight: 700, fontSize: '1.25rem' }}>{fmtDuration(Date.now() - session.startedAt)}</div></div>
          <div className="grow"><div className="muted" style={{ fontSize: '0.8125rem' }}>Sets done</div><div className="num" style={{ fontWeight: 700, fontSize: '1.25rem' }}>{doneCount}</div></div>
        </div>
        {differs ? (
          <>
            <p style={{ margin: '4px 2px' }}>You changed this workout (exercises, order, sets or rest). Save the changes to your plan?</p>
            <button className="btn primary lg block" onClick={() => go(true)}>Finish and update plan</button>
            <button className="btn lg block" onClick={() => go(false)}>Finish, keep plan as it was</button>
          </>
        ) : <button className="btn good lg block" onClick={() => go(false)}>Finish workout</button>}
        <p className="faint" style={{ margin: 0, fontSize: '0.8125rem', textAlign: 'center' }}>Unchecked sets are not saved.</p>
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
