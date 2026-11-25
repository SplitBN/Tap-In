// Exercise action sheet (⋯ on the live workout), modelled on docs/design-refs/alpha-exercise-menu.png:
// name · equipment + info, paired big tiles (sets / reps), grouped icon rows, plain text links at the bottom.
// Everything a plan slot can change is here (spec: anything editable in a plan is editable mid-workout).
import { useId, useState } from 'react';
import type { Exercise, Settings, WorkoutItem } from '../db/types';
import { exerciseLabel } from '../lib/equipment';
import { groupOf, variantLabel } from '../lib/variants';
import { fmtDuration, plural } from '../lib/format';
import { defaultRestSec } from '../lib/science';
import { Icon } from './Icon';
import { Stepper } from './ItemSettings';
import { NumberField, type NumberSpec } from './NumberPicker';
import { Sheet } from './Sheet';

const REPS: NumberSpec = { min: 1, max: 50, step: 1, decimals: 0, keyMax: 999 };
type Sub = 'sets' | 'reps' | 'rest' | 'note' | null;

export function repsText(it: Pick<WorkoutItem, 'repsMin' | 'repsMax'>) {
  if (it.repsMin == null) return null;
  return it.repsMax != null && it.repsMax !== it.repsMin ? `${it.repsMin}–${it.repsMax}` : String(it.repsMin);
}

export function ExerciseMenu({ open, onClose, item, ex, settings, nextEx, linked, canLeft, canRight,
  onChange, onSuperset, onReplace, onVariant, onRemove, onInfo, onEditEx, onMove, onAdd, initialSub }: {
  open: boolean; onClose: () => void; item: WorkoutItem; ex?: Exercise; settings: Settings;
  /** the exercise after this one (superset partner), undefined when this is the last */
  nextEx?: Exercise | null; linked: boolean; canLeft: boolean; canRight: boolean;
  onChange: (next: WorkoutItem) => void; onSuperset: () => void; onReplace: () => void; onRemove: () => void;
  /** grip / width / handle variants of this exercise (shown only when it has some) */
  onVariant?: () => void;
  onInfo: () => void; onEditEx: () => void; onMove: (d: -1 | 1) => void; onAdd: () => void;
  /** open straight on a sub-sheet (e.g. the reps target from the exercise header) */
  initialSub?: Sub;
}) {
  const headId = useId();
  const [sub, setSub] = useState<Sub>(null);
  // decided at render (not in an effect) so a sub-sheet left from last time never flashes up for a frame
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) { setWasOpen(open); setSub(open ? initialSub ?? null : null); }
  const def = ex ? defaultRestSec(ex.mechanic, settings.restCompoundSec, settings.restIsolationSec) : 120;
  const restSec = item.rest.sec ?? def;
  const reps = repsText(item);
  const restText = item.rest.mode === 'countup' ? 'Count up' : fmtDuration(restSec * 1000);

  return (
    <>
      <Sheet open={open && !initialSub} onClose={onClose} labelledBy={headId}>
        <div className="am">
          <div className="am-top">
            <h2 id={headId} className="am-title">
              <button className="am-head" onClick={onInfo} aria-label={`${exerciseLabel(ex)}: how-to`}>
                <span className="ellipsis">{exerciseLabel(ex)}</span><Icon name="info" size={20} stroke={2} />
              </button>
            </h2>
            <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
          </div>

          <div className="tile-pair">
            <button className="tile pressable" onClick={() => setSub('sets')} aria-haspopup="dialog">
              <Icon name="history" size={22} /><span className="num">{plural(item.sets, 'set', 'sets')}</span>
            </button>
            <button className="tile pressable" onClick={() => setSub('reps')} aria-haspopup="dialog">
              <Icon name="swap" size={22} /><span className="num">{reps ? `${reps} reps` : 'Reps'}</span>
            </button>
          </div>

          <div className="group">
            <div className="am-row">
              <Icon name="drop" />
              <span className="grow">Drop sets<span className="am-sub">−20% weight each</span></span>
              <Stepper label="Drop sets" less="Remove drop set" more="Add drop set" value={item.drops ?? 0} max={4} onChange={(drops) => onChange({ ...item, drops })} />
            </div>
            {nextEx !== undefined && (
              <button className="am-row pressable" onClick={onSuperset}>
                <Icon name={linked ? 'unlink' : 'link'} />
                <span className="grow ellipsis">{linked ? 'Unlink superset' : <>Superset<span className="am-sub ellipsis">with {exerciseLabel(nextEx ?? undefined, 'next')}</span></>}</span>
              </button>
            )}
          </div>

          <div className="group">
            <button className="am-row pressable" onClick={() => setSub('note')} aria-haspopup="dialog">
              <Icon name="note" />
              <span className="grow ellipsis">{item.notes ? <>Note<span className="am-sub ellipsis">{item.notes}</span></> : 'Add note'}</span>
            </button>
            {settings.features.restTimer && (
              <button className="am-row pressable" onClick={() => setSub('rest')} aria-haspopup="dialog">
                <Icon name="timer" />
                <span className="grow">Rest</span>
                <span className="am-val num">{restText}</span>
              </button>
            )}
          </div>

          <div className="group">
            {onVariant && groupOf(ex) && (
              <button className="am-row pressable" onClick={onVariant} aria-haspopup="dialog">
                <Icon name="layers" /><span className="grow">Variant</span>
                <span className="am-val ellipsis" style={{ maxWidth: '45%' }}>{variantLabel(groupOf(ex)!, ex!.variant, ex!.family) || 'Standard'}</span>
              </button>
            )}
            <button className="am-row pressable" onClick={onReplace}><Icon name="swap" /><span className="grow">Replace</span></button>
            <button className="am-row pressable danger" onClick={onRemove}><Icon name="trash" /><span className="grow">Remove</span></button>
          </div>

          <nav className="text-links" aria-label="More">
            <button className="text-link" onClick={onAdd}>Add exercise</button>
            <button className="text-link" onClick={onEditEx}>Edit exercise</button>
            {canLeft && <button className="text-link" onClick={() => onMove(-1)}>Move earlier</button>}
            {canRight && <button className="text-link" onClick={() => onMove(1)}>Move later</button>}
          </nav>
        </div>
      </Sheet>

      <Sheet open={open && sub === 'sets'} onClose={() => (initialSub ? onClose() : setSub(null))} title="Sets">
        <div className="group">
          <div className="am-row"><span className="grow">Sets</span>
            <Stepper label="Sets" less="Remove set" more="Add set" value={item.sets} min={1} max={20} onChange={(sets) => onChange({ ...item, sets })} /></div>
          {settings.features.warmups && (
            <div className="am-row"><span className="grow">Warm-up sets</span>
              <Stepper label="Warm-up sets" less="Remove warm-up set" more="Add warm-up set" value={item.warmups ?? 0} max={6} onChange={(warmups) => onChange({ ...item, warmups })} /></div>
          )}
        </div>
      </Sheet>

      <Sheet open={open && sub === 'reps'} onClose={() => (initialSub ? onClose() : setSub(null))} title="Target reps">
        {item.repsMin != null ? (
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              <NumberField label="From" spec={REPS} value={item.repsMin} style={{ flex: 1 }}
                onChange={(v) => onChange({ ...item, repsMin: v, repsMax: item.repsMax != null && item.repsMax < v ? v : item.repsMax })} />
              <NumberField label="To" spec={REPS} value={item.repsMax} style={{ flex: 1 }}
                onChange={(v) => onChange({ ...item, repsMax: v, repsMin: item.repsMin != null && item.repsMin > v ? v : item.repsMin })} />
            </div>
            <button className="text-link" style={{ color: 'var(--danger)' }} onClick={() => onChange({ ...item, repsMin: undefined, repsMax: undefined })}>No target</button>
          </div>
        ) : <button className="btn primary lg block" onClick={() => onChange({ ...item, repsMin: 8, repsMax: 12 })}><Icon name="plus" size={18} /> 8–12 reps</button>}
      </Sheet>

      <Sheet open={open && sub === 'rest'} onClose={() => (initialSub ? onClose() : setSub(null))} title="Rest">
        <div className="stack" style={{ gap: 12 }}>
          <div className="seg" role="group" aria-label="Rest">
            <button aria-pressed={item.rest.mode === 'timer'} onClick={() => onChange({ ...item, rest: { ...item.rest, mode: 'timer' } })}>Timer</button>
            <button aria-pressed={item.rest.mode === 'countup'} onClick={() => onChange({ ...item, rest: { ...item.rest, mode: 'countup' } })}>Count up</button>
          </div>
          {item.rest.mode === 'timer' && (
            <div className="group">
              <div className="am-row"><span className="grow">Time{item.rest.sec == null && <span className="am-sub">Default</span>}</span>
                <Stepper label="Rest time" value={restSec} min={15} max={600} step={15} format={(v) => fmtDuration(v * 1000)} onChange={(sec) => onChange({ ...item, rest: { ...item.rest, sec } })} /></div>
            </div>
          )}
        </div>
      </Sheet>

      <NoteSheet open={open && sub === 'note'} onClose={() => (initialSub ? onClose() : setSub(null))} value={item.notes}
        onSave={(notes) => onChange({ ...item, notes })} />
    </>
  );
}

/** Note editor; saved when the sheet closes (Done, swipe, Escape). */
function NoteSheet({ open, onClose, value, onSave }: { open: boolean; onClose: () => void; value?: string; onSave: (v?: string) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) setDraft(value ?? ''); }
  const close = () => { const v = draft.trim() || undefined; if ((v ?? '') !== (value ?? '')) onSave(v); onClose(); };
  return (
    <Sheet open={open} onClose={close} title="Note">
      <div className="stack" style={{ gap: 12 }}>
        <textarea className="input" rows={3} autoFocus aria-label="Exercise note" placeholder="Seat 4, grip, cues…" value={draft}
          style={{ padding: 12, resize: 'vertical' }} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn primary lg block" onClick={close}>Done</button>
      </div>
    </Sheet>
  );
}
