import { fromKg } from './science';
import type { SetLog, Settings, Unit } from '../db/types';

export function fmtWeight(kg: number | null | undefined, unit: Unit, withUnit = true) {
  if (kg == null) return '–';
  const v = fromKg(kg, unit);
  const r = Math.round(v * 100) / 100;
  const s = Number.isInteger(r) ? String(r) : r.toFixed(r * 10 === Math.round(r * 10) ? 1 : 2);
  return withUnit ? `${s} ${unit}` : s;
}

export function fmtDuration(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(ts: number, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(ts).toLocaleDateString(undefined, opts);
}

export function relDay(ts: number) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const diff = Math.round((d0.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff} days ago`;
  return fmtDate(ts);
}

export const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

export function setText(l: SetLog, unit: Settings['unit'], mode: Settings['effortMode']) {
  const load = l.loadType === 'weighted'
    ? fmtWeight(l.loadKg, unit)
    : l.loadType === 'bodyweight' ? (l.loadKg ? `BW+${fmtWeight(l.loadKg, unit)}` : 'BW') : `BW−${fmtWeight(l.loadKg, unit)}`;
  const eff = mode === 'rir' ? (l.rir != null ? ` @${fmtNum(l.rir)} RIR` : '') : (l.rpe != null ? ` @${fmtNum(l.rpe)}` : '');
  return `${load} × ${l.reps ?? '–'}${eff}`;
}
