import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { NumberSheet, type NumberSpec } from '../components/NumberPicker';
import { alive, db } from '../db/db';
import { run } from '../api/registry';
import { recordsRestore, weightDelete, weightLog, weightUpdate } from '../api/body';
import { useSettings } from '../db/settings';
import type { BodyweightEntry } from '../db/types';
import { fmtDate, fmtNum, fmtWeight } from '../lib/format';
import { fromKg, toKg } from '../lib/science';

export function WeightPage() {
  const settings = useSettings();
  const entries = useLiveQuery(() => db.bodyweight.orderBy('at').reverse().filter(alive).toArray(), []) ?? [];
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<BodyweightEntry>();
  const nav = useNavigate();
  // a root tab when Supps is off (it takes that tab slot); otherwise a pushed screen with a back button
  const pushed = settings.features.supplements;
  const back = () => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav('/settings'));
  const add = <button className="icon-btn filled" aria-label="Log weight" onClick={() => { setEdit(undefined); setOpen(true); }}><Icon name="plus" /></button>;
  return (
    <div className="page" data-role="weight">
      {pushed ? (
        <header className="page-head">
          <button className="icon-btn" aria-label="Back" onClick={back}><Icon name="chevronLeft" /></button>
          <h1 className="small">Weight</h1>
          {add}
        </header>
      ) : (
        <header className="page-head"><h1>Weight</h1>{add}</header>
      )}
      {entries.length ? (
        <>
          <Sparkline entries={entries} unit={settings.unit} />
          <div className="list" style={{ marginTop: 12 }}>
            {entries.map((e, i) => {
              const prev = entries[i + 1];
              const d = prev ? fromKg(e.kg - prev.kg, settings.unit) : null;
              return (
                <button key={e.id} className="list-item pressable" onClick={() => { setEdit(e); setOpen(true); }}>
                  <span className="grow">
                    <span className="title num">{fmtWeight(e.kg, settings.unit)}</span>
                    <span className="sub" style={{ display: 'block' }}>{fmtDate(e.at)} · {new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                  </span>
                  {d != null && <span className="num t-15" style={{ color: 'var(--text-2)' }}>{d > 0 ? '+' : d < 0 ? '−' : '±'}{Math.abs(d).toFixed(1)} {settings.unit}</span>}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="empty"><Icon name="scale" size={40} /><h3>No weigh-ins yet</h3><p>Weigh in at the same time of day for the cleanest trend.</p>
          <button className="btn primary" onClick={() => { setEdit(undefined); setOpen(true); }}><Icon name="plus" size={18} /> Log weight</button></div>
      )}
      <WeighInSheet open={open} onClose={() => setOpen(false)} entry={edit} />
    </div>
  );
}

function Sparkline({ entries, unit }: { entries: BodyweightEntry[]; unit: 'kg' | 'lb' }) {
  const pts = entries.slice(0, 60).reverse();
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.kg);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const W = 300, H = 80;
  const t0 = pts[0].at, t1 = pts[pts.length - 1].at, tspan = t1 - t0 || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((p.at - t0) / tspan) * W},${H - 6 - ((p.kg - min) / span) * (H - 12)}`).join(' ');
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="grow muted" style={{ fontSize: '0.8125rem' }}>Last {pts.length} weigh-ins</span>
        <span className="num muted" style={{ fontSize: '0.8125rem' }}>{fmtWeight(min, unit)} – {fmtWeight(max, unit)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Weight over time">
        <path d={d} fill="none" stroke="var(--role, var(--c-weight))" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function WeighInSheet({ open, onClose, entry }: { open: boolean; onClose: () => void; entry?: BodyweightEntry }) {
  const settings = useSettings();
  const unit = settings.unit;
  const last = useLiveQuery(() => db.bodyweight.orderBy('at').reverse().filter(alive).first(), []);
  const spec = useMemo<NumberSpec>(() => (unit === 'kg'
    ? { min: 30, max: 250, step: 0.1, decimals: 1, unit, format: (v) => `${fmtNum(v)} kg` }
    : { min: 66, max: 550, step: 0.2, decimals: 1, unit, format: (v) => `${fmtNum(v)} lb` }), [unit]);
  const [when, setWhen] = useState('');
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) setWhen(toLocalInput(entry?.at ?? Date.now()));
  }
  const cur = Math.round(fromKg(entry?.kg ?? last?.kg ?? 80, unit) * 10) / 10;
  // tap a value = save it (with the time above) and close
  const save = async (v: number) => {
    const at = new Date(new Date(when).getTime() || Date.now()).toISOString();
    const kg = toKg(v, unit);
    if (entry) await run(weightUpdate, { id: entry.id, kg, at });
    else await run(weightLog, { kg, at });
  };
  return (
    <NumberSheet open={open} onClose={onClose} role="weight" title={entry ? 'Edit weigh-in' : 'Log weight'} value={cur} onPick={save} spec={spec}
      extra={
        <label className="field"><span>When</span>
          <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
      }
      footer={entry && (
        <div className="row">
          {/* a time-only change: keep the weight, save the new "When" */}
          <button className="btn grow" onClick={async () => { await run(weightUpdate, { id: entry.id, kg: entry.kg, at: new Date(new Date(when).getTime() || entry.at).toISOString() }); onClose(); }}>
            <Icon name="check" size={18} stroke={2.4} /> Save time
          </button>
          <button className="btn danger grow" onClick={async () => {
            await run(weightDelete, { id: entry.id }); onClose();
            toast('Weigh-in deleted', () => run(recordsRestore, { table: 'bodyweight', id: entry.id }));
          }}><Icon name="trash" size={16} /> Delete</button>
        </div>
      )}
    />
  );
}

function toLocalInput(ts: number) {
  const d = new Date(ts);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
