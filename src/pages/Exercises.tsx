import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ExName, ExerciseThumb } from '../components/ExercisePicker';
import { Icon } from '../components/Icon';
import type { Exercise } from '../db/types';
import { titleCase, plural } from '../lib/format';
import { keyToDate } from '../lib/nutrition';
import { run } from '../api/registry';
import { progressExercises } from '../api/progress';

const MUSCLES = ['chest', 'lats', 'middle back', 'shoulders', 'biceps', 'triceps', 'quadriceps', 'hamstrings', 'glutes', 'calves', 'abdominals', 'forearms', 'traps', 'lower back'];

/** Exercise library: browse or search every exercise and open its progress page, no workout needed. */
export function ExercisesPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [muscle, setMuscle] = useState<string>();
  const [scope, setScopeRaw] = useState<'done' | 'all'>('done');
  const [touched, setTouched] = useState(false);
  const setScope = (v: 'done' | 'all') => { setScopeRaw(v); setTouched(true); };
  const list = useLiveQuery(() => run(progressExercises, { query: dq, muscle, onlyDone: scope === 'done' && !dq.trim(), limit: 200 }), [dq, muscle, scope]);
  const searching = !!dq.trim();
  // nothing logged yet: open on the full library instead of an empty "Done" list
  const anyDone = useLiveQuery(async () => (await run(progressExercises, { onlyDone: true, limit: 1 })).length > 0, []);
  if (anyDone === false && scope === 'done' && !touched) setScope('all');
  return (
    <div className="page" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" /></button>
        <h1 className="small">Exercises</h1>
        <span style={{ width: 44 }} />
      </header>
      <div className="stack" style={{ marginBottom: 12 }}>
        <label className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Search exercises" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" autoCorrect="off" aria-label="Search exercises" />
        </label>
        {!searching && (
          <div className="seg" role="group" aria-label="Which exercises">
            <button aria-pressed={scope === 'done'} onClick={() => setScope('done')}>Done</button>
            <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All</button>
          </div>
        )}
        <div className="chips">
          {MUSCLES.map((m) => <button key={m} className="chip" aria-pressed={muscle === m} onClick={() => setMuscle(muscle === m ? undefined : m)}>{titleCase(m)}</button>)}
        </div>
      </div>
      {list && (list.length ? (
        <div className="list">
          {list.map((e) => {
            const ex = e as unknown as Exercise; // name, equipment and images are all ExName / ExerciseThumb read
            return (
              <Link key={e.id} to={`/exercise/${e.id}`} className="list-item pressable">
                <ExerciseThumb ex={ex} />
                <span className="grow">
                  <span className="title" style={{ display: 'block' }}><ExName ex={ex} /></span>
                  <span className="sub num">
                    {e.sessions ? `${plural(e.sessions, 'session', 'sessions')} · last ${keyToDate(e.lastDate!).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: e.lastDate!.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' })}` : titleCase(e.muscles.join(', ')) || 'Not done yet'}
                  </span>
                </span>
                <Icon name="chevronRight" className="chev" size={18} />
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <Icon name="dumbbell" size={40} />
          <h3>{searching ? 'No exercises match' : scope === 'done' ? 'Nothing logged yet' : 'No exercises'}</h3>
          {!searching && scope === 'done' && <p>Exercises you've done show up here. <button className="link" onClick={() => setScope('all')}>Browse all</button></p>}
        </div>
      ))}
    </div>
  );
}
