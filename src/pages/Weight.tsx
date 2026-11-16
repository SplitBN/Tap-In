import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { NumberSheet, type NumberSpec } from '../components/NumberPicker';
import { alive, db } from '../db/db';
import { run } from '../api/registry';
import { recordsRestore, weightDelete, weightLog, weightUpdate } from '../api/body';
import { useSettings } from '../db/settings';
import type { BodyweightEntry } from '../db/types';
import { fmtDate, fmtNum, fmtWeight, plural, relDay } from '../lib/format';
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
  const log = () => { setEdit(undefined); setOpen(true); };
  const last = entries[0];
  const week = last ? entries.find((e) => e.at <= last.at - 6 * 86400000) : undefined; // about a week before the latest
  const delta = last && week ? fromKg(last.kg - week.kg, settings.unit) : null;
  const due = !last || Date.now() - last.at > settings.weighInEveryDays * 86400000;
  return (
    <div className="page" data-role="weight">
      <div className="gym-top">
        {pushed && <button className="icon-btn" aria-label="Back" onClick={back} style={{ marginRight: 'auto' }}><Icon name="chevronLeft" /></button>}
        <button className="icon-btn filled" aria-label="Log weight" onClick={log}><Icon name="plus" /></button>
      </div>
      <header className="title-more lt" style={{ marginTop: 0 }}><h1>Weight</h1></header>

      {last ? (
        <>
          <div className="wt-hero">
            <span className="num wt-value">{fmtWeight(last.kg, settings.unit, false)}</span>
            <span className="wt-unit">{settings.unit}</span>
            {delta != null && Math.abs(delta) >= 0.05 && (
              <span className="num wt-delta"><span aria-hidden>{delta > 0 ? '▲' : '▼'}</span><span className="sr-only">{delta > 0 ? 'up' : 'down'} </span>{Math.abs(delta).toFixed(1)} {settings.unit} <span className="faint">in a week</span></span>
            )}
          </div>
          <div className={'plan-meta' + (due ? ' due' : '')} style={{ marginTop: 0 }}>
            {due ? <button className="meta-btn role-text" onClick={log}><Icon name="plus" size={16} /> Weigh-in due</button> : <span>{relDay(last.at)}</span>}
          </div>
          <Sparkline entries={entries} unit={settings.unit} />
          <h2 className="section-title">{plural(entries.length, 'weigh-in', 'weigh-ins')}</h2>
          <div className="group">
            {entries.map((e, i) => {
              const prev = entries[i + 1];
              const d = prev ? fromKg(e.kg - prev.kg, settings.unit) : null;
              return (
                <button key={e.id} className="fd-row pressable" onClick={() => { setEdit(e); setOpen(true); }}>
                  <span className="tile-ic date-tile" aria-hidden><b className="num">{new Date(e.at).getDate()}</b><small>{new Date(e.at).toLocaleDateString(undefined, { month: 'short' })}</small></span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="fd-name num">{fmtWeight(e.kg, settings.unit)}</span>
                    <span className="fd-sub">{fmtDate(e.at)} · {new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                  </span>
                  {d != null && <span className="num muted t-15" aria-label={`${d > 0 ? 'up' : d < 0 ? 'down' : 'no change'} ${Math.abs(d).toFixed(1)} ${settings.unit}`}>{d > 0 ? '+' : d < 0 ? '−' : '±'}{Math.abs(d).toFixed(1)}</span>}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="empty"><Icon name="scale" size={40} /><h3>No weigh-ins yet</h3><p>Weigh in at the same time of day for the cleanest trend.</p>
          <button className="btn primary" onClick={log}><Icon name="plus" size={18} /> Log weight</button></div>
      )}
      <nav className="text-links" aria-label="Weight">
        {entries.length > 0 && <button className="text-link" onClick={log}>Log weight</button>}
        <Link className="text-link" to="/settings">Reminder · every {plural(settings.weighInEveryDays, 'day', 'days')}</Link>
      </nav>
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
    <div className="group" style={{ padding: '12px 16px', marginTop: 4 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="grow muted t-13">Last {pts.length}</span>
        <span className="num muted t-13">{fmtWeight(min, unit)} – {fmtWeight(max, unit)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={`Weight over the last ${pts.length} weigh-ins, from ${fmtWeight(min, unit)} to ${fmtWeight(max, unit)}`}>
        <defs><linearGradient id="wtfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--role)" stopOpacity="0.3" /><stop offset="1" stopColor="var(--role)" stopOpacity="0" /></linearGradient></defs>
        <path d={d + ` L${W},${H} L0,${H} Z`} fill="url(#wtfill)" stroke="none" />
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
        <div className="group">
          {/* a time-only change: keep the weight, save the new "When" */}
          <button className="am-row pressable" onClick={async () => { await run(weightUpdate, { id: entry.id, kg: entry.kg, at: new Date(new Date(when).getTime() || entry.at).toISOString() }); onClose(); }}>
            <Icon name="check" /><span className="grow">Save time only</span>
          </button>
          <button className="am-row pressable danger" onClick={async () => {
            await run(weightDelete, { id: entry.id }); onClose();
            toast('Weigh-in deleted', () => run(recordsRestore, { table: 'bodyweight', id: entry.id }));
          }}><Icon name="trash" /><span className="grow">Delete</span></button>
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
