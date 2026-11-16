// "Repeat workout" and "Save as workout" for a finished session (History row menu, session ⋯ sheet).
// Both go through commands (sessions.repeat, workouts.createFromSession) so the agent can do the same.
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { run } from '../api/registry';
import { plansCreate, sessionsRepeat, workoutsCreateFromSession } from '../api/gym';
import { alive, db } from '../db/db';
import { useSettings } from '../db/settings';
import { plural } from '../lib/format';
import { confirmDialog } from './Dialog';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { toast } from './Toast';

/** Start a new live session copying a finished one. A live workout blocks it: offer to resume that instead. */
export function useRepeatWorkout() {
  const nav = useNavigate();
  return async (sessionId: string, before?: () => void) => {
    try {
      const r = await run(sessionsRepeat, { id: sessionId });
      before?.();
      if (r.alreadyRunning) {
        if (await confirmDialog({ title: 'A workout is in progress', message: `Finish or discard “${r.session.name}” before starting another.`, confirm: 'Resume it', cancel: 'Not now' }))
          nav(`/session/${r.session.id}`);
        return;
      }
      nav(`/session/${r.session.id}`);
      if (r.skipped.length) toast(`Left out ${plural(r.skipped.length, 'deleted exercise', 'deleted exercises')}`);
    } catch (e) {
      before?.();
      toast((e as Error).message);
    }
  };
}

/** Pick a plan (or make one) and a name; the session's structure becomes a new workout in it. */
export function SaveAsWorkoutSheet({ open, sessionId, sessionName, onClose }: { open: boolean; sessionId: string; sessionName: string; onClose: () => void }) {
  const settings = useSettings();
  const nav = useNavigate();
  const plans = useLiveQuery(() => db.plans.filter(alive).sortBy('name'), []) ?? [];
  const [name, setName] = useState('');
  const [planId, setPlanId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [was, setWas] = useState(false);
  const nameId = useId();
  if (open !== was) { setWas(open); if (open) { setName(sessionName); setPlanId(undefined); setBusy(false); } }
  const chosen = planId ?? (plans.some((p) => p.id === settings.activePlanId) ? settings.activePlanId : plans[0]?.id);

  const go = async () => {
    setBusy(true);
    try {
      const pid = chosen ?? (await run(plansCreate, { name: 'My plan' })).id;
      const { workout, skipped } = await run(workoutsCreateFromSession, { sessionId, planId: pid, name: name.trim() || undefined });
      onClose();
      toast(`Saved “${workout.name}”${skipped.length ? ` · left out ${plural(skipped.length, 'deleted exercise', 'deleted exercises')}` : ''}`);
      nav(`/workouts/${workout.id}`);
    } catch (e) { setBusy(false); toast((e as Error).message); }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Save as workout" role="gym">
      <div className="stack" style={{ gap: 14 }}>
        <label className="field"><span>Name</span>
          <input id={nameId} className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder={sessionName} />
        </label>
        <div className="field"><span>Add to plan</span>
          {plans.length ? (
            <div className="group" role="radiogroup" aria-label="Plan">
              {plans.map((p) => {
                const on = p.id === chosen;
                return (
                  <button key={p.id} className="list-item pressable" role="radio" aria-checked={on} onClick={() => setPlanId(p.id)}>
                    <span className="grow title bidi-start" dir="auto">{p.name}</span>
                    {p.id === settings.activePlanId && <span className="badge accent">active</span>}
                    <span className={'sel-circle' + (on ? ' on' : '')} aria-hidden>{on && <Icon name="check" size={16} stroke={3} />}</span>
                  </button>
                );
              })}
            </div>
          ) : <p className="muted" style={{ margin: 0 }}>No plans yet. A new plan “My plan” is created for it.</p>}
        </div>
        <p className="faint" style={{ margin: 0, fontSize: '0.8125rem' }}>Copies exercises, sets, rep targets, supersets, warm-ups and drop sets. Not the weights.</p>
        <button className="btn primary lg block" disabled={busy} onClick={go}><Icon name="check" size={20} stroke={2.6} /> Save</button>
      </div>
    </Sheet>
  );
}

/** Menu rows for a finished session: Repeat + Save as workout. */
export function RepeatRows({ onRepeat, onSaveAs }: { onRepeat: () => void; onSaveAs: () => void }) {
  return (
    <>
      <button className="am-row pressable" onClick={onRepeat}><Icon name="play" /><span className="grow">Repeat workout<span className="am-sub">Same exercises and sets, new targets</span></span></button>
      <button className="am-row pressable" onClick={onSaveAs}><Icon name="copy" /><span className="grow">Save as workout<span className="am-sub">Add it to a plan</span></span></button>
    </>
  );
}
