// Display tools (show_chart / show_table / show_stats): validated and resolved on the client. A chart series can name
// a `source` — a query command the client runs itself, so big data never goes through the model. Read-only.
import { z } from 'zod';
import type { Command } from '../../api/registry';
import type { ChartBand, ChartMarker, ChartPoint, ChartSeries, Display } from './types';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_POINTS = 365;

type Find = (name: string) => Command | undefined;
type Blocked = (name: string) => boolean;

/** Dotted path into an object ("totals.kcal", "best.e1rm"). */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
const toX = (v: unknown): string | null => {
  if (typeof v === 'number' && v > 1e11) { const d = new Date(v); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  if (typeof v === 'string' && v) return DATE.test(v.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v) ? v.slice(0, 10) : v.slice(0, 40);
  if (typeof v === 'number') return String(v);
  return null;
};

/** Even downsample to `max` points, always keeping the first and last. */
export function downsample<T>(pts: T[], max = MAX_POINTS): T[] {
  if (pts.length <= max) return pts;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (max - 1))]);
  return out;
}

async function resolveSeries(raw: unknown, find: Find, blocked: Blocked): Promise<ChartSeries | string> {
  const s = raw as { name?: unknown; points?: unknown; source?: { command?: unknown; input?: unknown; x?: unknown; y?: unknown; path?: unknown } };
  const name = typeof s?.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : 'Series';
  let pts: ChartPoint[] = [];
  if (s?.source) {
    const { command, input, x, y, path } = s.source;
    const c = typeof command === 'string' ? find(command) : undefined;
    if (!c) return `series "${name}": unknown command "${String(command)}"`;
    if (blocked(c.name)) return `series "${name}": ${c.name} is not available`;
    if (c.kind !== 'query') return `series "${name}": ${c.name} is not a query`;
    if (typeof x !== 'string' || typeof y !== 'string') return `series "${name}": source needs x and y field paths`;
    const p = c.input.safeParse(input ?? {});
    if (!p.success) return `series "${name}": invalid input for ${c.name}: ${z.prettifyError(p.error)}`;
    let out: unknown;
    try { out = await c.run(p.data); } catch (e) { return `series "${name}": ${(e as Error).message}`; }
    const rows = typeof path === 'string' && path ? getPath(out, path) : out;
    if (!Array.isArray(rows)) return `series "${name}": the result${path ? ` at "${path}"` : ''} is not a list of rows (set path to the array)`;
    pts = rows.map((r) => ({ x: toX(getPath(r, x)), y: Number(getPath(r, y)) })).filter((q): q is ChartPoint => q.x !== null && Number.isFinite(q.y));
    if (!pts.length && rows.length) return `series "${name}": no numeric "${y}" / "${x}" found in the rows (first row keys: ${Object.keys(rows[0] ?? {}).join(', ')})`;
  } else if (Array.isArray(s?.points)) {
    pts = (s.points as { x?: unknown; y?: unknown }[]).map((q) => ({ x: toX(q?.x), y: Number(q?.y) })).filter((q): q is ChartPoint => q.x !== null && Number.isFinite(q.y));
  } else return `series "${name}": give points or a source`;
  if (pts.every((q) => DATE.test(q.x))) pts.sort((a, b) => a.x.localeCompare(b.x));
  return { name, points: downsample(pts) };
}

const str = (v: unknown, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Validate + resolve show_chart. `journal(from, to)` returns journal entries for the overlay. */
export async function resolveChart(a: Record<string, unknown>, find: Find, blocked: Blocked,
  journal: (from: string, to: string) => Promise<{ date: string; endDate?: string; ongoing?: boolean; title: string; tag?: string }[]>): Promise<Display | string> {
  const kind = (['line', 'bar', 'area', 'scatter'] as const).find((k) => k === a.kind) ?? 'line';
  const list = Array.isArray(a.series) ? a.series.slice(0, 4) : [];
  if (!list.length) return 'series must be a non-empty array (1–4)';
  const series: ChartSeries[] = [];
  for (const raw of list) { const r = await resolveSeries(raw, find, blocked); if (typeof r === 'string') return r; series.push(r); }
  const markers: ChartMarker[] = (Array.isArray(a.markers) ? a.markers : []).slice(0, 30).map((m) => ({ x: toX((m as { x?: unknown }).x) ?? '', label: str((m as { label?: unknown }).label, 30) ?? '' })).filter((m) => m.x && m.label);
  const bands: ChartBand[] = (Array.isArray(a.bands) ? a.bands : []).slice(0, 20).map((b0) => {
    const b = b0 as { from?: unknown; to?: unknown; label?: unknown; tone?: unknown };
    return { from: toX(b.from) ?? '', to: b.to == null ? null : toX(b.to), label: str(b.label, 30) ?? '', tone: (['good', 'bad', 'neutral'] as const).find((t) => t === b.tone) ?? 'neutral' };
  }).filter((b) => DATE.test(b.from) && b.label);
  const xs = series.flatMap((s) => s.points.map((p) => p.x)).filter((x) => DATE.test(x)).sort();
  if (a.journal === true && xs.length) {
    for (const j of await journal(xs[0], xs[xs.length - 1])) {
      if (j.endDate || j.ongoing) bands.push({ from: j.date, to: j.endDate ?? null, label: j.title.slice(0, 30), tone: 'neutral' });
      else markers.push({ x: j.date, label: j.title.slice(0, 30) });
    }
  }
  return { type: 'chart', title: str(a.title, 80) ?? 'Chart', kind, ...(str(a.y_label, 30) ? { yLabel: str(a.y_label, 30) } : {}), ...(str(a.unit, 12) ? { unit: str(a.unit, 12) } : {}), series, markers, bands };
}

export function resolveTable(a: Record<string, unknown>): Display | string {
  const columns = (Array.isArray(a.columns) ? a.columns : []).slice(0, 12).map((c) => String(c ?? '').slice(0, 40));
  if (!columns.length) return 'columns must be a non-empty array';
  const rows = (Array.isArray(a.rows) ? a.rows : []).slice(0, 50).map((r) => columns.map((_, i) => {
    const v = Array.isArray(r) ? r[i] : null;
    return typeof v === 'number' && Number.isFinite(v) ? v : v == null ? null : String(v).slice(0, 80);
  }));
  return { type: 'table', ...(str(a.title, 80) ? { title: str(a.title, 80) } : {}), columns, rows };
}

export function resolveStats(a: Record<string, unknown>): Display | string {
  const items = (Array.isArray(a.items) ? a.items : []).slice(0, 8).map((i0) => {
    const i = i0 as { label?: unknown; value?: unknown; unit?: unknown; delta?: unknown; good?: unknown };
    const value = typeof i.value === 'number' && Number.isFinite(i.value) ? i.value : String(i.value ?? '').slice(0, 20);
    return { label: str(i.label, 30) ?? '', value, ...(str(i.unit, 10) ? { unit: str(i.unit, 10) } : {}),
      ...(typeof i.delta === 'number' && Number.isFinite(i.delta) ? { delta: i.delta } : {}), ...(i.good === 'up' || i.good === 'down' ? { good: i.good as 'up' | 'down' } : {}) };
  }).filter((i) => i.label && i.value !== '');
  if (!items.length) return 'items must be a non-empty array of { label, value }';
  return { type: 'stats', items };
}
