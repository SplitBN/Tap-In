// Push reminders: iOS can't schedule local notifications for web apps, so the server sends them.
// A cron trigger runs every minute; for each subscribed device it looks at the user's synced
// supplements (records table) in the device's timezone and sends a push for doses that are due now
// and not logged yet. Weigh-in reminders go out once in the morning when one is due. Low-stock
// reminders go out once (around 18:00 local) when a supplement's stock drops to its threshold.
import { buildPushPayload, type PushSubscription, type VapidKeys } from '@block65/webcrypto-web-push';
import type { Env } from './index';

// ---- schedule logic (mirror of app/src/db/supps.ts isDue/doseOn — keep in sync) ----
interface Schedule { kind: 'daily' | 'weekdays' | 'interval' | 'weekly' | 'asNeeded'; days?: number[]; every?: number; times: string[]; startDate: string; cycle?: { onDays: number; offDays: number } | null }
interface LowStock { kind: 'days' | 'amount'; value: number }
interface Supplement { id: string; name: string; unit: string; doses: { from: string; amount: number }[]; schedule: Schedule; archived?: boolean; deletedAt?: number | null;
  stock?: number | null; lowStock?: LowStock | null }
interface SuppLog { supplementId: string; date: string; slot: string | null; deletedAt?: number | null }

const dayNum = (key: string) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
function isDue(s: Schedule, date: string) {
  if (s.kind === 'asNeeded' || date < s.startDate) return false;
  const diff = dayNum(date) - dayNum(s.startDate);
  if (s.cycle && s.cycle.onDays > 0) { const len = s.cycle.onDays + s.cycle.offDays; if (len > 0 && diff % len >= s.cycle.onDays) return false; }
  switch (s.kind) {
    case 'daily': return true;
    case 'weekdays': return (s.days ?? []).includes(new Date(dayNum(date) * 86400000).getUTCDay());
    case 'interval': return diff % Math.max(1, s.every ?? 1) === 0;
    case 'weekly': return diff % 7 === 0;
  }
  return false;
}
const doseOn = (s: Supplement, date: string) => [...s.doses].sort((a, b) => b.from.localeCompare(a.from)).find((d) => d.from <= date)?.amount ?? s.doses[0]?.amount ?? 0;

// ---- stock forecast (mirror of app/src/db/supps.ts stockForecast — keep in sync) ----
// Stock is in dose units. Walk forward from today consuming doseOn × number of daily times on each due day;
// today's slots that already have a log are not counted again. daysLeft = days until the first due day the
// stock can't cover (0 = today); null for as-needed. Threshold undefined = 7 days, null = no alert.
const DEFAULT_LOW_STOCK: LowStock = { kind: 'days', value: 7 };
const STOCK_HORIZON = 400;
const addDays = (key: string, n: number) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export function stockForecast(s: Supplement, today: string, logs: { supplementId: string; date: string; slot: string | null; deletedAt?: number | null }[]) {
  if (s.stock == null || s.archived || s.deletedAt) return null;
  const threshold = s.lowStock === undefined ? DEFAULT_LOW_STOCK : s.lowStock; // null = alerts off
  let daysLeft: number | null = null;
  let runsOutOn: string | null = null;
  if (s.schedule.kind !== 'asNeeded') {
    const mine = logs.filter((l) => !l.deletedAt && l.supplementId === s.id && l.date === today);
    const times = s.schedule.times;
    const slots = Math.max(1, times.length);
    const logged = times.length ? times.filter((t) => mine.some((l) => l.slot === t)).length : Math.min(1, mine.filter((l) => l.slot == null).length);
    let left = s.stock;
    daysLeft = STOCK_HORIZON;
    for (let i = 0; i < STOCK_HORIZON; i++) {
      const d = addDays(today, i);
      if (!isDue(s.schedule, d)) continue;
      const need = (i === 0 ? slots - logged : slots) * doseOn(s, d);
      if (need > left + 1e-9) { daysLeft = i; runsOutOn = d; break; }
      left -= need;
    }
  }
  const low = !threshold ? false : threshold.kind === 'amount' ? s.stock <= threshold.value : daysLeft != null && daysLeft <= threshold.value;
  return { stock: s.stock, daysLeft, runsOutOn, threshold, low };
}
/** Same wording as the app (stockText in app/src/db/supps.ts). */
function stockText(f: NonNullable<ReturnType<typeof stockForecast>>, unit: string) {
  if (f.stock <= 0) return 'Out of stock';
  if (f.threshold?.kind === 'amount' || f.daysLeft == null || f.daysLeft >= STOCK_HORIZON) return `${+f.stock.toFixed(2)} ${unit} left`;
  if (f.daysLeft === 0) return 'Runs out today';
  return `~${f.daysLeft} ${f.daysLeft === 1 ? 'day' : 'days'} left`;
}

/** Local date "YYYY-MM-DD" and time "HH:MM" in an IANA zone. */
function localNow(tz: string, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const minutes = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

async function records<T>(env: Env, userId: string, tbl: string): Promise<T[]> {
  const rows = await env.DB.prepare('SELECT data FROM records WHERE user_id = ? AND tbl = ?').bind(userId, tbl).all<{ data: string }>();
  return rows.results.map((r) => JSON.parse(r.data) as T).filter((r) => !(r as { deletedAt?: number | null }).deletedAt);
}

export async function sendPush(env: Env, sub: { endpoint: string; p256dh: string; auth: string }, body: { title: string; body: string; url?: string; tag?: string },
  opts: { ttl?: number; urgency?: 'low' | 'normal' | 'high' } = {}) {
  const vapid: VapidKeys = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY! };
  const subscription: PushSubscription = { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } };
  const payload = await buildPushPayload({ data: JSON.stringify(body), options: { ttl: opts.ttl ?? 3600, urgency: opts.urgency ?? 'normal', topic: body.tag?.slice(0, 32) } }, subscription, vapid);
  const res = await fetch(sub.endpoint, payload);
  if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run(); // subscription gone
  return res.status;
}

async function once(env: Env, userId: string, key: string) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO sent_reminders (user_id, key, sent_at) VALUES (?, ?, ?)').bind(userId, key, Date.now()).run();
  return (r.meta.changes ?? 0) > 0; // true only the first time this reminder is claimed
}

/** Cron: every minute. */
export async function runReminders(env: Env) {
  if (!env.VAPID_PRIVATE_KEY) return;
  const subs = await env.DB.prepare('SELECT endpoint, user_id, p256dh, auth, tz FROM push_subs').all<{ endpoint: string; user_id: string; p256dh: string; auth: string; tz: string }>();
  const byUser = new Map<string, typeof subs.results>();
  subs.results.forEach((s) => byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]));

  let sent = 0; const dbg: string[] = [];
  // One pass per (user, timezone): each device is reminded at its own local time (a phone abroad, a stale sub).
  const groups: [string, typeof subs.results][] = [];
  for (const [userId, all] of byUser) {
    const byTz = new Map<string, typeof subs.results>();
    all.forEach((d) => byTz.set(d.tz || 'UTC', [...(byTz.get(d.tz || 'UTC') ?? []), d]));
    byTz.forEach((devs) => groups.push([userId, devs]));
  }
  for (const [userId, devices] of groups) {
    const tz = devices[0].tz || 'UTC';
    const now = localNow(tz);
    const due: { key: string; title: string; body: string }[] = [];

    const sups = await records<Supplement>(env, userId, 'supplements');
    const logs = (await records<SuppLog>(env, userId, 'supplogs')).filter((l) => l.date === now.date);
    for (const s of sups) {
      if (s.archived || !isDue(s.schedule, now.date)) continue;
      for (const slot of s.schedule.times) {
        const late = minutes(now.time) - minutes(slot);
        if (late < 0 || late > 10) continue; // fire within 10 minutes of the scheduled time (cron jitter, offline phone)
        if (logs.some((l) => l.supplementId === s.id && l.slot === slot)) continue; // already taken/skipped
        due.push({ key: `supp:${s.id}:${now.date}:${slot}`, title: `${s.name} · ${doseOn(s, now.date)} ${s.unit}`, body: `Due at ${slot}. Tap to log it.` });
      }
    }

    // low stock: checked 18:00–18:10 local. One push per low spell: the claim "stock:<id>@<tz>" stays while the
    // supplement is low and is released once it isn't (restock, threshold change, stopped, deleted), so the next drop
    // below the threshold reminds again. Missed doses or day changes don't re-send (the key has no date).
    const nowMin = minutes(now.time);
    if (nowMin >= minutes('18:00') && nowMin < minutes('18:10')) {
      const allSups = await env.DB.prepare('SELECT id, data FROM records WHERE user_id = ? AND tbl = ?').bind(userId, 'supplements').all<{ id: string; data: string }>();
      for (const row of allSups.results) {
        const s = JSON.parse(row.data) as Supplement;
        const f = stockForecast(s, now.date, logs);
        if (f?.low) {
          due.push({ key: `stock:${s.id}`, title: `${s.name} · ${stockText(f, s.unit)}`, body: f.stock <= 0 ? 'Time to restock. Tap to update the stock.' : 'Running low. Restock soon, then tap to add it.' });
        } else {
          await env.DB.prepare('DELETE FROM sent_reminders WHERE user_id = ? AND key = ?').bind(userId, `stock:${s.id}@${tz}`).run(); // not low (or deleted): re-arm
        }
      }
    }

    // weigh-in: once at 08:00 local when the last one is older than the interval
    if (now.time === '08:00') {
      const settings = (await records<{ weighInEveryDays?: number }>(env, userId, 'settings'))[0];
      const every = settings?.weighInEveryDays ?? 7;
      const last = Math.max(0, ...(await records<{ at: number }>(env, userId, 'bodyweight')).map((b) => b.at));
      if (Date.now() - last > every * 86400000) due.push({ key: `weigh:${now.date}`, title: 'Weigh-in day', body: 'Step on the scale before breakfast.' });
    }

    dbg.push(`${tz} ${now.date} ${now.time}: ${sups.length} supps, ${due.length} due`);
    for (const d of due) {
      if (!(await once(env, userId, `${d.key}@${tz}`))) continue; // per timezone group; the notification tag stays shared
      const group = d.key.startsWith('supp:') || d.key.startsWith('stock:') ? 'supps' : 'weight';
      for (const dev of devices) {
        try { await sendPush(env, dev, { title: d.title, body: d.body, url: `./#/${group}`, tag: d.key }); sent++; }
        catch (e) { console.error('push failed', dev.endpoint.slice(0, 40), (e as Error).message); }
      }
    }
  }
  console.log(`reminders: ${byUser.size} users, ${sent} pushes · ${dbg.join(' | ')}`);
  // keep the de-dup table small. Stock claims live as long as the supplement stays low (released above when it isn't);
  // a 180-day backstop covers supplements deleted while low.
  await env.DB.prepare("DELETE FROM sent_reminders WHERE (sent_at < ? AND key NOT LIKE 'stock:%') OR sent_at < ?")
    .bind(Date.now() - 3 * 86400000, Date.now() - 180 * 86400000).run();
}
