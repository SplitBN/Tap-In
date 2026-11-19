// Inferred "was the day fully logged?" (lib/dayStatus.ts): a small chip for the selected day and a morning check card
// for yesterday. Answers are the user's override (days.setComplete); "Back to auto" removes it (days.clearOverride).
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { run } from '../api/registry';
import { daysClearOverride, daysComplete, daysStatus } from '../api/food';
import type { InferredDay } from '../lib/dayStatus';
import { shiftDate } from '../lib/nutrition';
import { useToday } from '../lib/today';

export const useDayStatus = (date: string) => useLiveQuery(async () => (await run(daysStatus, { from: date, to: date }))[0], [date]);

const CHIP: Record<string, { icon?: string; text: string; cls: string }> = {
  complete: { icon: 'check', text: 'Looks complete', cls: 'good' }, partial: { text: 'Partial?', cls: 'warn' },
  unsure: { text: 'Unsure', cls: 'muted' }, open: { text: 'Open', cls: 'muted' }, empty: { text: 'Nothing logged', cls: 'muted' },
};
function chipOf(d: InferredDay) {
  if (d.source === 'you') return d.status === 'complete' ? { icon: 'check', text: 'Confirmed', cls: 'good' } : { text: 'Missed some', cls: 'warn' };
  return CHIP[d.status];
}

/** The selected day's status; tap to confirm or go back to automatic. */
export function DayStatusChip({ date }: { date: string }) {
  const d = useDayStatus(date);
  const [open, setOpen] = useState(false);
  if (!d || d.status === 'empty') return null;
  const c = chipOf(d);
  return (
    <>
      <button className={'day-chip ' + c.cls} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`Day status: ${c.text}. ${d.reason}. Change`}>
        {c.icon && <Icon name={c.icon} size={14} stroke={3} />}{c.text}
      </button>
      <DayStatusSheet d={open ? d : null} onClose={() => setOpen(false)} />
    </>
  );
}

function DayStatusSheet({ d, onClose }: { d: InferredDay | null; onClose: () => void }) {
  const set = async (complete: boolean | null) => {
    if (!d) return;
    if (complete === null) await run(daysClearOverride, { date: d.date });
    else await run(daysComplete, { date: d.date, complete });
    onClose();
  };
  return (
    <Sheet open={!!d} onClose={onClose} title="Was that everything?">
      {d && (
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted t-15" style={{ margin: 0 }}>
            <span className="num">{d.kcal.toLocaleString()} kcal</span>{d.baseline ? <> · usually <span className="num">{d.baseline.toLocaleString()}</span></> : null} · {d.reason}.
            {' '}Only complete days count toward your maintenance estimate.
          </p>
          <button className="btn lg block good" onClick={() => set(true)}><Icon name="check" size={18} stroke={2.6} />That’s all</button>
          <button className="btn lg block" onClick={() => set(false)}>Missed some</button>
          {d.source === 'you' && <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={() => set(null)}>Back to auto</button>}
        </div>
      )}
    </Sheet>
  );
}

const dismissKey = (date: string) => `tapin:dayCheck:${date}`;
const dismissed = (date: string) => { try { return !!localStorage.getItem(dismissKey(date)); } catch { return false; } };

/** Morning check for yesterday when it looks partial or unsure and the user hasn't said: one tap to answer. */
export function MorningCheck() {
  const today = useToday();
  const y = shiftDate(today, -1);
  const d = useDayStatus(y);
  const nav = useNavigate();
  const [hidden, setHidden] = useState(() => dismissed(y));
  if (!d || hidden || d.source === 'you' || (d.status !== 'partial' && d.status !== 'unsure')) return null;
  const answer = (complete: boolean) => run(daysComplete, { date: y, complete });
  const close = () => { try { localStorage.setItem(dismissKey(y), '1'); } catch { /* private mode */ } setHidden(true); };
  return (
    <section className="day-check" data-role="food" aria-label="Yesterday's food log">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="role-chip" aria-hidden><Icon name="food" size={16} stroke={2} /></span>
        <p className="grow day-check-text">
          <b>Yesterday · <span className="num">{d.kcal.toLocaleString()} kcal</span></b>
          <span>{d.reason.replace(/^./, (c) => c.toLowerCase())}. Was that everything?</span>
        </p>
        <button className="icon-btn sm" aria-label="Dismiss" onClick={close}><Icon name="close" size={16} /></button>
      </div>
      <div className="day-check-actions">
        <button className="btn good" onClick={() => answer(true)}><Icon name="check" size={16} stroke={2.6} />That’s all</button>
        <button className="btn" onClick={() => answer(false)}>Missed some</button>
        <button className="text-link" onClick={() => nav(`/food?d=${y}`)}><Icon name="plus" size={14} stroke={2.4} />Add food</button>
      </div>
    </section>
  );
}
