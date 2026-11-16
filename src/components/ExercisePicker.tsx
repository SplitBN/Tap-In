import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useMemo, useState } from 'react';
import { alive, db } from '../db/db';
import { run } from '../api/registry';
import { exercisesCreate, exercisesDuplicate, exercisesUpdate } from '../api/gym';
import { exerciseImage } from '../db/seed';
import type { Exercise, LoadType, Mechanic } from '../db/types';
import { titleCase } from '../lib/format';
import { EQUIPMENT, equipmentLabel, equipmentTag } from '../lib/equipment';
import { usageBoost } from '../lib/search';
import { searchExercises } from '../db/exerciseSearch';
import { Icon } from './Icon';
import { Sheet } from './Sheet';



const MUSCLES = ['chest', 'lats', 'middle back', 'shoulders', 'biceps', 'triceps', 'quadriceps', 'hamstrings', 'glutes', 'calves', 'abdominals', 'forearms', 'traps', 'lower back'];

export function ExercisePicker({ open, onClose, onPick, multi, title = 'Add exercise' }: {
  open: boolean; onClose: () => void; onPick: (ex: Exercise[]) => void; multi?: boolean; title?: string;
}) {
  const all = useLiveQuery(() => db.exercises.toArray(), []) ?? [];
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [muscle, setMuscle] = useState<string>();
  const [sel, setSel] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // How often each exercise has been done (completed sets per session) — your staples float up.
  const usage = useLiveQuery(async () => {
    const m = new Map<string, { n: number; last: number; sessions: Set<string> }>();
    await db.sets.each((s) => {
      if (!s.doneAt || s.deletedAt) return;
      const u = m.get(s.exerciseId) ?? { n: 0, last: 0, sessions: new Set<string>() };
      if (!u.sessions.has(s.sessionId)) { u.sessions.add(s.sessionId); u.n++; }
      u.last = Math.max(u.last, s.doneAt); m.set(s.exerciseId, u);
    });
    return m;
  }, [open]) ?? new Map();

  const list = useMemo(() => {
    const pool = all.filter((e) => alive(e) && (!muscle || e.muscles.includes(muscle)));
    if (!dq.trim()) {
      // no query: most-used first, then your custom ones, then A–Z
      return pool.sort((a, b) => usageBoost(usage.get(b.id)) - usageBoost(usage.get(a.id))
        || Number(!!b.custom) - Number(!!a.custom) || a.name.localeCompare(b.name)).slice(0, 150);
    }
    return searchExercises(pool, dq, usage);
  }, [all, dq, muscle, usage]);

  const close = () => { setSel([]); setQ(''); onClose(); };
  const done = (ids: string[]) => {
    const picked = ids.map((id) => all.find((e) => e.id === id)).filter(Boolean) as Exercise[];
    onPick(picked);
    close();
  };

  return (
    <Sheet open={open} onClose={close} title={title} full
      actions={multi && sel.length ? <button className="btn primary" onClick={() => done(sel)}>Add {sel.length}</button> : undefined}>
      <div style={{ position: 'sticky', top: -4, background: 'var(--bg-raised)', paddingBottom: 8, zIndex: 1 }} className="stack">
        <label className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Search exercises" value={q} onChange={(e) => setQ(e.target.value)}
            enterKeyHint="search" autoCorrect="off" aria-label="Search exercises" />
        </label>
        <div className="chips">
          {MUSCLES.map((m) => (
            <button key={m} className="chip" aria-pressed={muscle === m} onClick={() => setMuscle(muscle === m ? undefined : m)}>{titleCase(m)}</button>
          ))}
        </div>
      </div>
      <button className="list-item pressable" onClick={() => setCreating(true)} style={{ paddingLeft: 4 }}>
        <span className="thumb" style={{ display: 'grid', placeItems: 'center', color: 'var(--accent)' }}><Icon name="plus" /></span>
        <span className="title" style={{ color: 'var(--accent)' }}>{q ? `Create “${q}”` : 'Create custom exercise'}</span>
      </button>
      <div>
        {list.map((e) => {
          const on = sel.includes(e.id);
          return (
            <button key={e.id} className="list-item pressable" style={{ paddingLeft: 4, paddingRight: 4 }}
              onClick={() => (multi ? setSel(on ? sel.filter((x) => x !== e.id) : [...sel, e.id]) : done([e.id]))}>
              <ExerciseThumb ex={e} />
              <span className="grow">
                <span className="title" style={{ display: 'block' }}><ExName ex={e} /></span>
                <span className="sub">{titleCase(e.muscles.join(', '))}{e.unilateral ? ' · one side' : ''}{e.custom ? ' · custom' : ''}</span>
              </span>
              {multi && (
                <span aria-hidden style={{ width: 24, height: 24, borderRadius: 12, display: 'grid', placeItems: 'center', flex: 'none',
                  background: on ? 'var(--accent)' : 'transparent', border: on ? 0 : '2px solid var(--line)', color: '#fff' }}>
                  {on && <Icon name="check" size={16} stroke={2.6} />}
                </span>
              )}
            </button>
          );
        })}
        {!list.length && <p className="empty">No exercises match.</p>}
      </div>
      <ExerciseEditor open={creating} initialName={q} onClose={() => setCreating(false)}
        onSaved={(ex) => (multi ? setSel([...sel, ex.id]) : done([ex.id]))} />
    </Sheet>
  );
}

export function ExerciseThumb({ ex, size = 44 }: { ex?: Exercise; size?: number }) {
  const src = exerciseImage(ex);
  return src
    ? <img className="thumb" src={src} alt="" loading="lazy" style={{ width: size, height: size }} />
    : <span className="thumb" style={{ width: size, height: size, display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}><Icon name="dumbbell" /></span>;
}

/** Exercise name with a muted equipment tag ("Bench Press · Dumbbell"), so same-named variants can be told apart. */
export function ExName({ ex, fallback = '…' }: { ex?: Exercise; fallback?: string }) {
  if (!ex) return <>{fallback}</>;
  const tag = equipmentTag(ex);
  return <>{ex.name}{tag && <span className="eq"> · {tag}</span>}</>;
}

export function ExerciseEditor({ open, onClose, onSaved, onDuplicated, initialName = '', exercise }: {
  open: boolean; onClose: () => void; onSaved?: (ex: Exercise) => void; onDuplicated?: (copy: Exercise) => void; initialName?: string; exercise?: Exercise;
}) {
  const [name, setName] = useState(exercise?.name ?? initialName);
  const [mechanic, setMechanic] = useState<Mechanic>(exercise?.mechanic ?? 'compound');
  const [loadType, setLoadType] = useState<LoadType>(exercise?.loadType ?? 'weighted');
  const [equipment, setEquipment] = useState(exercise?.equipment ?? 'barbell');
  const [unilateral, setUnilateral] = useState(exercise?.unilateral ?? false);
  const [muscle, setMuscle] = useState(exercise?.muscles[0] ?? 'chest');
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) { // reset fields each time it opens
    setLastOpen(open);
    if (open) {
      setName(exercise?.name ?? initialName); setMechanic(exercise?.mechanic ?? 'compound');
      setLoadType(exercise?.loadType ?? 'weighted'); setEquipment(exercise?.equipment ?? 'barbell');
      setUnilateral(exercise?.unilateral ?? false); setMuscle(exercise?.muscles[0] ?? 'chest');
    }
  }

  const submit = async () => {
    if (!name.trim()) return;
    const fields = { name: name.trim(), mechanic, equipment, loadType, unilateral, muscles: [muscle, ...(exercise?.muscles ?? []).filter((m) => m !== muscle)] };
    const ex = exercise ? await run(exercisesUpdate, { id: exercise.id, ...fields }) : await run(exercisesCreate, fields);
    onSaved?.(ex);
    onClose();
  };

  // a copy with its own history (e.g. a second chest press machine); a name typed here names the copy, the original is unchanged
  const duplicate = async () => {
    if (!exercise) return;
    const typed = name.trim();
    const copy = await run(exercisesDuplicate, { id: exercise.id, name: typed && typed !== exercise.name ? typed : undefined });
    onDuplicated?.(copy);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={exercise ? 'Edit exercise' : 'New exercise'}>
      <div className="stack" style={{ gap: 16 }}>
        <label className="field"><span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!exercise} />
        </label>
        <div className="field"><span>Type</span>
          <div className="seg">
            {(['compound', 'isolation'] as const).map((m) => <button key={m} aria-pressed={mechanic === m} onClick={() => setMechanic(m)}>{titleCase(m)}</button>)}
          </div>
        </div>
        <div className="field"><span>Load</span>
          <div className="seg">
            {([['weighted', 'Weight'], ['bodyweight', 'Bodyweight +'], ['assisted', 'Assisted']] as const).map(([v, l]) =>
              <button key={v} aria-pressed={loadType === v} onClick={() => setLoadType(v)}>{l}</button>)}
          </div>
        </div>
        <label className="field"><span>Equipment</span>
          <select className="input" value={equipment} onChange={(e) => setEquipment(e.target.value)}>
            {EQUIPMENT.map((x) => <option key={x} value={x}>{equipmentLabel(x)}</option>)}
          </select>
        </label>
        <label className="field"><span>Main muscle</span>
          <select className="input" value={muscle} onChange={(e) => setMuscle(e.target.value)}>
            {MUSCLES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
          </select>
        </label>
        <label className="row card" style={{ padding: '10px 14px' }}>
          <span className="grow"><b style={{ fontWeight: 560 }}>One side at a time</b><br /><span className="muted" style={{ fontSize: '0.8125rem' }}>Log left and right separately</span></span>
          <span className="switch"><input type="checkbox" checked={unilateral} onChange={(e) => setUnilateral(e.target.checked)} /><span /></span>
        </label>
        <button className="btn primary lg block" onClick={submit} disabled={!name.trim()}>Save</button>
        {exercise && (
          <div className="stack" style={{ gap: 6 }}>
            <button className="btn block" onClick={duplicate}><Icon name="copy" size={18} />Duplicate</button>
            <span className="faint" style={{ fontSize: '0.8125rem', textAlign: 'center' }}>Separate copy with its own history, e.g. another machine. A name typed above names the copy.</span>
          </div>
        )}
      </div>
    </Sheet>
  );
}

