// Local-first sync with the Tap In backend (server/). The phone is the working copy; the server is the
// durable copy. Writes go to IndexedDB + outbox instantly (db.save); this module flushes the outbox in the
// background and pulls changes made elsewhere. Last-write-wins per record by client updatedAt.
import { useSyncExternalStore } from 'react';
import { db, onLocalChange } from '../db/db';

/** Production API. Set after `wrangler deploy` (also overridable in Settings → Account for dev). */
export const DEFAULT_API = 'https://tap-in.tap-in-server.workers.dev';
const TABLES = ['settings', 'exercises', 'plans', 'workouts', 'sessions', 'sets', 'bodyweight', 'foods', 'entries', 'days', 'goals', 'supplements', 'stacks', 'supplogs', 'notes'] as const;

interface Account { api: string; token: string; user: { id: string; name: string } }
export interface SyncState { account: Account | null; status: 'off' | 'idle' | 'syncing' | 'offline' | 'error'; pending: number; lastSync: number | null; error?: string }

let state: SyncState = { account: null, status: 'off', pending: 0, lastSync: null };
const subs = new Set<() => void>();
const set = (p: Partial<SyncState>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export const useSync = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state);

const meta = async <T>(key: string) => (await db.meta.get(key))?.value as T | undefined;
const setMeta = (key: string, value: unknown) => db.meta.put({ key, value });

async function api<T>(path: string, init: RequestInit & { token?: string; keepalive?: boolean } = {}, base = state.account?.api): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.token ?? state.account?.token ? { Authorization: `Bearer ${init.token ?? state.account!.token}` } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
}

// ---------------- account ----------------
async function link(acc: Account) {
  await setMeta('account', acc);
  await setMeta('syncCursor', 0);
  set({ account: acc, status: 'idle' }); // signed in from here on, even if queueing the first upload fails
  // first link: upload everything that exists locally (the outbox only holds changes since install)
  for (const t of TABLES) {
    const ids = (await db.table(t).toCollection().primaryKeys()) as string[];
    const rows = t === 'exercises' ? (await db.exercises.toArray()).filter((e) => e.custom || e.updatedAt > 0).map((e) => e.id) : ids;
    await db.outbox.bulkAdd(rows.map((id) => ({ table: t, recordId: id, at: Date.now() })));
  }
  void syncNow();
}

export async function signUp(apiBase: string, invite: string, name: string) {
  const r = await api<{ token: string; recoveryKey: string; user: Account['user'] }>('/auth/register', { method: 'POST', body: JSON.stringify({ invite: invite.trim(), name }) }, apiBase);
  // The account now exists and its invite is spent: never let a failed first upload swallow the recovery key.
  try { await link({ api: apiBase, token: r.token, user: r.user }); }
  catch (e) { console.warn('first upload failed; sync will retry', e); }
  return r.recoveryKey; // shown once — the user must save it
}
export async function signInWithRecovery(apiBase: string, recoveryKey: string) {
  const r = await api<{ token: string; user: Account['user'] }>('/auth/recover', { method: 'POST', body: JSON.stringify({ recoveryKey }) }, apiBase);
  await link({ api: apiBase, token: r.token, user: r.user });
}
export async function signInWithPairCode(apiBase: string, code: string) {
  const r = await api<{ token: string; user: Account['user'] }>('/auth/pair/claim', { method: 'POST', body: JSON.stringify({ code }) }, apiBase);
  await link({ api: apiBase, token: r.token, user: r.user });
}
export const createPairCode = () => api<{ code: string; expiresAt: number }>('/auth/pair', { method: 'POST' });
export const createInvite = () => api<{ code: string }>('/invites', { method: 'POST' });
export async function signOut() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* offline: forget locally anyway */ }
  await db.meta.delete('account');
  set({ account: null, status: 'off' });
}

// ---------------- push reminders ----------------
const b64uToBytes = (s: string) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

/** Ask permission (must run from a tap; iOS needs the app on the Home Screen) and register this device. */
export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Notifications need the app installed on the Home Screen (Share → Add to Home Screen), iOS 16.4+.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in iOS Settings → Notifications → Tap In.');
  const { publicKey } = await api<{ publicKey: string | null }>('/push/key');
  if (!publicKey) throw new Error('The server has no push key configured yet.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
  await setMeta('push', true);
}
export async function disablePush() {
  const reg = await navigator.serviceWorker?.ready;
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { try { await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch { /* offline */ } await sub.unsubscribe(); }
  await setMeta('push', false);
}
export const pushEnabled = async () => !!(await meta<boolean>('push')) && Notification?.permission === 'granted';
export const testPush = () => api<{ sent: number }>('/push/test', { method: 'POST' });

// ---------------- sync ----------------
let running: Promise<void> | null = null;

export function syncNow(opts: { keepalive?: boolean } = {}) {
  if (!state.account) return Promise.resolve();
  running ??= (async () => {
    try {
      if (!navigator.onLine) { set({ status: 'offline' }); return; }
      set({ status: 'syncing', error: undefined });
      await push(opts.keepalive);
      await pull();
      set({ status: 'idle', lastSync: Date.now(), pending: await db.outbox.count() });
      await setMeta('lastSync', Date.now());
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 401) { await db.meta.delete('account'); set({ account: null, status: 'off', error: 'Signed out — sign in again' }); }
      else set({ status: navigator.onLine ? 'error' : 'offline', error: err.message, pending: await db.outbox.count() });
    } finally { running = null; }
  })();
  return running;
}

async function push(keepalive?: boolean) {
  for (;;) {
    const batch = await db.outbox.orderBy('seq').limit(400).toArray();
    if (!batch.length) return;
    const maxSeq = batch[batch.length - 1].seq!;
    const seen = new Set<string>(); const changes: { tbl: string; id: string; data: unknown; updatedAt: number }[] = [];
    for (const o of [...batch].reverse()) { // newest first, one change per record
      const k = `${o.table}:${o.recordId}`; if (seen.has(k)) continue; seen.add(k);
      const rec = await db.table(o.table).get(o.recordId);
      if (rec) changes.push({ tbl: o.table, id: o.recordId, data: rec, updatedAt: rec.updatedAt ?? o.at });
    }
    if (changes.length) await api('/sync/push', { method: 'POST', body: JSON.stringify({ changes }), keepalive });
    await db.outbox.where('seq').belowOrEqual(maxSeq).delete();
    set({ pending: await db.outbox.count() });
  }
}

async function pull() {
  let cursor = (await meta<number>('syncCursor')) ?? 0;
  for (;;) {
    const r = await api<{ changes: { tbl: string; id: string; data: Record<string, unknown>; updatedAt: number }[]; cursor: number; more: boolean }>(`/sync/pull?since=${cursor}&limit=500`);
    if (r.changes.length) {
      await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
        for (const c of r.changes) {
          if (!(TABLES as readonly string[]).includes(c.tbl)) continue;
          const local = await db.table(c.tbl).get(c.id);
          if (!local || (local.updatedAt ?? 0) < c.updatedAt) await db.table(c.tbl).put(c.data); // LWW, no outbox (came from server)
        }
      });
    }
    cursor = r.cursor; await setMeta('syncCursor', cursor);
    if (!r.more) return;
  }
}

/** Start background sync: on open, after local writes (debounced), every 30 s, when back online, and on close. */
export async function startSync() {
  const acc = await meta<Account>('account');
  set({ account: acc ?? null, status: acc ? 'idle' : 'off', pending: await db.outbox.count(), lastSync: (await meta<number>('lastSync')) ?? null });
  let t = 0;
  onLocalChange(() => { void db.outbox.count().then((pending) => set({ pending })); clearTimeout(t); t = window.setTimeout(() => void syncNow(), 1500); });
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void syncNow({ keepalive: true }); // flush right before the app is closed
    else void syncNow();
  });
  setInterval(() => { if (document.visibilityState === 'visible') void syncNow(); }, 30_000);
  void syncNow();
}
