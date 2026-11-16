import { useState, type ReactNode } from 'react';
import type { maintenanceEstimate } from '../api/maintenance';
import { keyToDate } from '../lib/nutrition';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

export type MaintEstimate = Awaited<ReturnType<typeof maintenanceEstimate.run>>;

const k = (v: number) => Math.round(v).toLocaleString();
const day = (key: string) => keyToDate(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const signed = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;

/** Where the maintenance number comes from, in a few words. */
export function maintLabel(est: MaintEstimate | null, override: number | null) {
  if (override) return 'Set by you';
  if (!est || est.source === 'formula') return 'Formula estimate';
  return est.source === 'adaptive' ? `From your logs · ${est.intakeDays} days` : `Logs + formula · ${est.intakeDays} days`;
}

/** Goals page maintenance card: value, source, and a "how" sheet showing the data behind it. */
export function MaintenanceCard({ value, override, est, formula, edit }: { value: number; override: number | null; est: MaintEstimate | null; formula: number; edit: ReactNode }) {
  const [open, setOpen] = useState(false);
  const src = override ? 'manual' : est?.source ?? 'formula';
  return (
    <>
      <div className="card maint-card">
        <div className="row">
          <div className="grow">
            <div className="big-value num">{k(value)}<span className="muted" style={{ fontSize: '0.875rem', fontWeight: 600 }}> kcal</span></div>
            <div className="maint-src"><i className={'maint-dot ' + src} aria-hidden="true" />{maintLabel(est, override)}</div>
          </div>
          {edit}
        </div>
        {est && (
          <button type="button" className="maint-how pressable" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <Icon name="info" size={16} />
            <span className="grow">{est.enabled ? (est.enoughData ? 'How it’s worked out' : 'Refines from your logs') : 'Formula only (Settings)'}</span>
            {est.plusMinusKcal != null && !override && <span className="num">±{k(est.plusMinusKcal)}</span>}
            <span className="maint-tag">Rough guide</span>
            <Icon name="chevronRight" size={16} className="chev" />
          </button>
        )}
      </div>
      {est && <MaintSheet open={open} onClose={() => setOpen(false)} est={est} override={override} formula={formula} />}
    </>
  );
}

function MaintSheet({ open, onClose, est, override, formula }: { open: boolean; onClose: () => void; est: MaintEstimate; override: number | null; formula: number }) {
  const e = est;
  return (
    <Sheet open={open} onClose={onClose} title="Maintenance" role="food">
      <div className="maint-sheet">
        <div className="maint-head">
          <div className="big-value num">{k(override ?? e.kcal)}<span className="muted" style={{ fontSize: '0.875rem', fontWeight: 600 }}> kcal</span></div>
          <div className="muted t-13">{maintLabel(e, override)}{!override && e.confidence !== 'none' ? ` · ${e.confidence} confidence` : ''}</div>
          {override != null && e.source !== 'formula' && <div className="muted t-13">Your logs say {k(e.kcal)} kcal. Your number wins until you clear it.</div>}
        </div>

        {!e.enabled ? <p className="muted">Adaptive maintenance is off in Settings, so this is the formula estimate (Mifflin-St Jeor × activity).</p>
          : !e.enoughData ? <>
            <p className="muted">{e.source === 'formula' ? `Using the formula estimate (${k(formula)} kcal) until there’s enough data.` : `Not enough recent data, so this eases back to the formula estimate (${k(formula)} kcal) by up to 75 kcal a day.`} Still needed:</p>
            <ul className="maint-list">{e.needs.map((n) => <li key={n}>{n}</li>)}</ul>
            <p className="faint t-13">Mark a day “fully logged” on the Food page when every meal is in. Unmarked days are skipped, never counted as zero.</p>
          </> : <>
            <WeightChart est={e} />
            <div className="maint-math">
              <Row l={`Average intake · ${e.intakeDays} fully logged days`} r={`${k(e.meanIntakeKcal!)} kcal`} />
              <Row l={`Weight trend · ${e.trendStartKg!.toFixed(1)} → ${e.trendEndKg!.toFixed(1)} kg`} r={`${signed(e.trendKgPerWeek!)} kg/wk`} />
              <Row l="Energy in that change (× 7,700 kcal/kg)" r={`${signed(-e.trendKgPerWeek! * 7700 / 7, 0)} kcal/day`} />
              <Row l="From your data" r={`${k(e.dataKcal!)} kcal`} strong />
              <Row l={`Blended with formula ${k(e.formulaKcal)} · data counts ${Math.round(e.dataWeight! * 100)}%`} r={`${k(e.kcal)} kcal`} strong />
            </div>
            <p className="faint t-13">Moves at most 75 kcal a day, so one odd week can’t swing it. Window {day(e.window.from)} – {day(e.window.to)}.</p>
          </>}

        {e.excludedDays.length > 0 && <>
          <div className="section-title">Days left out</div>
          <div className="list">
            {e.excludedDays.map((x) => (
              <div key={x.date} className="list-item"><span className="grow"><span className="title">{day(x.date)}</span><span className="sub">{x.reason}</span></span>
                <span className="num muted">{x.kcal == null ? '—' : `${k(x.kcal)} kcal`}</span></div>
            ))}
          </div>
        </>}
        {e.ignoredWeighIns.length > 0 && <>
          <div className="section-title">Weigh-ins ignored</div>
          <div className="list">
            {e.ignoredWeighIns.map((x) => (
              <div key={x.date} className="list-item"><span className="grow"><span className="title">{day(x.date)}</span><span className="sub">{x.reason}, likely a typo</span></span>
                <span className="num muted">{x.kg} kg</span></div>
            ))}
          </div>
        </>}

        <p className="faint t-13 maint-foot">A rough guide, not a measurement. Energy balance: intake minus the energy in your weight change, at 7,700 kcal per kg (Hall 2008). That figure overstates it for leaner people, and early in a diet water and glycogen loss make the estimate read high. Water swings are smoothed with a robust trend line.</p>
      </div>
    </Sheet>
  );
}

function Row({ l, r, strong }: { l: string; r: string; strong?: boolean }) {
  return <div className={'maint-row' + (strong ? ' strong' : '')}><span>{l}</span><span className="num">{r}</span></div>;
}

/** Weigh-ins (dots; ignored ones as red rings, pinned to the edge when off the scale) and the trend line the estimate uses.
 *  The EWMA series stays in maintenance.estimate for the agent; drawn here it lags in a steady trend and reads as wrong. */
function WeightChart({ est }: { est: MaintEstimate }) {
  const rows = est.series;
  const W = 320, H = 120, P = 8;
  const vals = rows.flatMap((r) => [r.weighInExcluded ? null : r.weighInKg, r.trendKg]).filter((v): v is number => v != null);
  if (!vals.length) return null;
  const lo = Math.min(...vals) - 0.3, hi = Math.max(...vals) + 0.3;
  const X = (i: number) => P + (i / Math.max(1, rows.length - 1)) * (W - 2 * P);
  const Y = (v: number) => P + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - 2 * P);
  const path = (key: 'trendKg') => rows.map((r, i) => (r[key] == null ? '' : `${X(i).toFixed(1)},${Y(r[key]!).toFixed(1)}`)).filter(Boolean).map((p, i) => (i ? 'L' : 'M') + p).join('');
  return (
    <figure className="maint-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weight trend ${est.trendStartKg} to ${est.trendEndKg} kg over the window`}>
        <path d={path('trendKg')} className="maint-trend" />
        {rows.map((r, i) => r.weighInKg == null ? null : r.weighInExcluded
          ? <circle key={i} cx={X(i)} cy={r.weighInKg < lo || r.weighInKg > hi ? (r.weighInKg < lo ? H - P : P) : Y(r.weighInKg)} r={3.5} className="maint-pt off" />
          : <circle key={i} cx={X(i)} cy={Y(r.weighInKg)} r={2.5} className="maint-pt" />)}
      </svg>
      <figcaption className="faint t-13"><span className="maint-key trend" /> trend (smoothed) <span className="maint-key pt" /> weigh-ins{est.ignoredWeighIns.length > 0 && <><span className="maint-key off" /> ignored</>}</figcaption>
    </figure>
  );
}
