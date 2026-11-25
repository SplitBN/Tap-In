import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useMemo, useState } from 'react';
import { alive, db } from '../db/db';
import { run } from '../api/registry';
import { exercisesCreate, exercisesDelete, exercisesDuplicate, exercisesUpdate, exercisesVariant } from '../api/gym';
import { confirmDialog, notice } from './Dialog';
import { exerciseImage } from '../db/seed';
import type { Exercise, LoadType, Mechanic } from '../db/types';
import { titleCase } from '../lib/format';
import { EQUIPMENT, equipmentLabel, equipmentTag } from '../lib/equipment';
import { plural } from '../lib/format';
import { usageBoost } from '../lib/search';
import { searchExercises } from '../db/exerciseSearch';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { VariantSheet } from './VariantSheet';
import { composeName, fitVariant, groupKey, groupOf, variantFromQuery, variantKey, type Variant } from '../lib/variants';



type Row = { ex: Exercise; variants?: number; virtual?: Variant; name?: string };

const MUSCLES = ['chest', 'lats', 'middle back', 'shoulders', 'biceps', 'triceps', 'quadriceps', 'hamstrings', 'glutes', 'calves', 'abdominals', 'forearms', 'traps', 'lower back'];

export function ExercisePicker({ open, onClose, onPick, multi, title = 'Add exercise' }: {
  open: boolean; onClose: () => void; onPick: (ex: Exercise[]) => void; multi?: boolean; title?: string;
}) {
  const all = useLiveQuery(() => db.exercises.toArray(), []) ?? [];
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [muscle, setMuscle] = useState<string>();
  const [sel, setSel] = useState<Exercise[]>([]);
  const [creating, setCreating] = useState(false);
  const [variantFor, setVariantFor] = useState<Exercise>();

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

  // one row per variant group (family + equipment: the base exercise) without a query; every match with one, plus a
  // not-yet-created variant when the query names one ("rope pushdown" → Triceps Pushdown · Rope)
  const list = useMemo((): Row[] => {
    const pool = all.filter((e) => alive(e) && (!muscle || e.muscles.includes(muscle)));
    if (!dq.trim()) {
      const groups = new Map<string, Exercise[]>();
      for (const e of pool) groups.set(groupKey(e), [...(groups.get(groupKey(e)) ?? []), e]);
      const rows = [...groups.values()].map((members) => {
        const ex = members.find((m) => !m.variant) ?? members[0];
        const used = members.map((m) => usage.get(m.id)).filter(Boolean) as { n: number; last: number }[];
        const u = used.length ? { n: used.reduce((a, x) => a + x.n, 0), last: Math.max(...used.map((x) => x.last)) } : undefined;
        return { ex, u, variants: members.filter((m) => m.variant && usage.has(m.id)).length };
      });
      // most-used first, then your custom ones, then A–Z
      return rows.sort((a, b) => usageBoost(b.u) - usageBoost(a.u) || Number(!!b.ex.custom) - Number(!!a.ex.custom) || a.ex.name.localeCompare(b.ex.name))
        .slice(0, 150).map(({ ex, variants }) => ({ ex, variants }));
    }
    const rows: Row[] = searchExercises(pool, dq, usage).map((ex) => ({ ex }));
    const want = variantFromQuery(dq);
    if (!Object.keys(want).length) return rows;
    // only for the best-matching family (the first base with variants that can take the named grip / width / handle)
    for (let i = 0; i < rows.length; i++) {
      const base = rows[i].ex; const g = groupOf(base);
      if (!g || base.variant) continue;
      const v = fitVariant(g, want);
      if (!v) continue;
      const exists = variantKey(g, v) === variantKey(g, undefined)
        || all.some((m) => alive(m) && m.family === base.family && m.equipment === base.equipment && variantKey(g, m.variant) === variantKey(g, v));
      if (!exists) rows.splice(i, 0, { ex: base, virtual: v, name: composeName(base.name, base.family!, g, v) });
      break;
    }
    return rows;
  }, [all, dq, muscle, usage]);

  const close = () => { setSel([]); setQ(''); onClose(); };
  const done = (picked: Exercise[]) => { onPick(picked); close(); };
  /** single: add it now; multi: toggle it in the selection */
  const take = (ex: Exercise) => {
    if (!multi) return done([ex]);
    setSel((cur) => (cur.some((x) => x.id === ex.id) ? cur.filter((x) => x.id !== ex.id) : [...cur, ex]));
  };
  const tap = async (r: Row) => {
    if (r.virtual) return take(await run(exercisesVariant, { exerciseId: r.ex.id, ...r.virtual }));
    if (groupOf(r.ex) && !r.ex.variant) {
      const picked = multi && sel.filter((x) => x.family === r.ex.family && x.equipment === r.ex.equipment);
      if (picked && picked.length) return setSel((cur) => cur.filter((x) => !picked.includes(x))); // ticked family: untick
      return setVariantFor(r.ex); // a family: choose grip / width / handle
    }
    take(r.ex);
  };

  const createRow = (
    <button className="list-item pressable" onClick={() => setCreating(true)} style={{ paddingLeft: 4 }}>
      <span className="thumb" style={{ display: 'grid', placeItems: 'center', color: 'var(--role, var(--accent))' }}><Icon name="plus" /></span>
      <span className="title role-text">{q.trim() ? `Create “${q.trim()}”` : 'Create custom exercise'}</span>
    </button>
  );

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
      {!q.trim() && createRow}
      <div>
        {list.map((r) => {
          const e = r.ex;
          const fam = !!groupOf(e) && !e.variant && !r.virtual;
          // a family row is ticked when any of its variants is selected
          const on = !r.virtual && sel.some((x) => (fam ? x.family === e.family && x.equipment === e.equipment : x.id === e.id));
          return (
            <button key={r.virtual ? `${e.id}:${r.name}` : e.id} className="list-item pressable" style={{ paddingLeft: 4, paddingRight: 4 }}
              aria-haspopup={fam ? 'dialog' : undefined} onClick={() => tap(r)}>
              <ExerciseThumb ex={e} />
              <span className="grow">
                <span className="title" style={{ display: 'block' }}>{r.virtual ? <>{r.name}{equipmentTag(e) && <span className="eq"> · {equipmentTag(e)}</span>}</> : <ExName ex={e} />}</span>
                <span className="sub">{r.virtual ? <span className="role-text">New variant</span> : <>{titleCase(e.muscles.join(', '))}{e.secondary?.length ? <span className="faint"> + {titleCase(e.secondary.join(', '))}</span> : null}{e.unilateral ? ' · one side' : ''}{e.custom ? ' · custom' : ''}</>}</span>
              </span>
              {fam && (r.variants
                ? <span className="badge num" title={plural(r.variants, 'variant used', 'variants used')}><Icon name="layers" size={12} stroke={2.2} />{r.variants}<span className="sr-only"> {plural(r.variants, 'variant', 'variants')} used</span></span>
                : <Icon name="layers" size={16} className="faint" aria-label="Has variants" />)}
              {multi && (
                <span aria-hidden style={{ width: 24, height: 24, borderRadius: 12, display: 'grid', placeItems: 'center', flex: 'none',
                  background: on ? 'var(--role-solid, var(--accent-solid))' : 'transparent', border: on ? 0 : '2px solid var(--line)', color: 'var(--on-role, #fff)' }}>
                  {on && <Icon name="check" size={16} stroke={2.6} />}
                </span>
              )}
            </button>
          );
        })}
        {!list.length && <p className="empty">No exercises match.</p>}
        {!!q.trim() && createRow /* real matches first, create at the end */}
      </div>
      <ExerciseEditor open={creating} initialName={q} onClose={() => setCreating(false)}
        onSaved={take} />
      <VariantSheet open={!!variantFor} exercise={variantFor} onClose={() => setVariantFor(undefined)} confirm={multi ? 'Select' : title.startsWith('Replace') ? 'Swap' : 'Add'}
        onPick={(ex) => { if (multi) setSel((cur) => (cur.some((x) => x.id === ex.id) ? cur : [...cur, ex])); else done([ex]); }} />
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

  // custom exercises only; refused (with the reason) while a plan or the workout in progress still uses it
  const del = async () => {
    if (!exercise) return;
    onClose(); // one sheet at a time: the confirm replaces the editor
    if (!(await confirmDialog({ title: `Delete ${exercise.name}?`, message: 'It leaves search and the picker. Past workouts keep their sets.', confirm: 'Delete exercise', danger: true }))) return;
    try { await run(exercisesDelete, { id: exercise.id }); }
    catch (e) { await notice("Can't delete", (e as Error).message); }
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
            {exercise.custom && <button className="btn block" onClick={del} style={{ color: 'var(--danger)' }}><Icon name="trash" size={18} />Delete</button>}
          </div>
        )}
      </div>
    </Sheet>
  );
}

