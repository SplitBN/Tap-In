// Tap In backend — Cloudflare Worker + D1.
import { runReminders, sendPush } from './reminders';
// Routes:
//   POST /auth/register   {invite, name}            → {token, recoveryKey, user}
//   POST /auth/recover    {recoveryKey}             → {token, user}
//   POST /auth/pair       (auth)                    → {code, expiresAt}     one-time code for another device
//   POST /auth/pair/claim {code}                    → {token, user}
//   POST /auth/logout     (auth)
//   GET  /me              (auth)                    → {user}
//   POST /invites         (auth)                    → {code}               invite a friend
//   POST /sync/push       (auth) {changes:[{tbl,id,data,updatedAt}]} → {accepted, cursor}
//   GET  /sync/pull?since=N&limit=500 (auth)        → {changes:[{tbl,id,data,updatedAt}], cursor, more}
//   GET  /push/key · POST /push/subscribe {subscription, tz} · /push/unsubscribe {endpoint} · /push/test  (auth except key)
// Secrets: BOOTSTRAP_INVITE (first sign-up), VAPID_PRIVATE_KEY. Vars: ALLOWED_ORIGINS, VAPID_SUBJECT, VAPID_PUBLIC_KEY.
// Cron: every minute → reminders (src/reminders.ts).

export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  BOOTSTRAP_INVITE?: string;
  VAPID_SUBJECT: string; // mailto: or https: contact for push services (var)
  VAPID_PUBLIC_KEY: string; // public by design (var)
  VAPID_PRIVATE_KEY?: string; // secret
}

type User = { id: string; name: string };

const SYNC_TABLES = new Set(['exercises', 'plans', 'workouts', 'sessions', 'sets', 'bodyweight', 'foods', 'entries', 'days', 'goals', 'supplements', 'stacks', 'supplogs', 'notes', 'settings']);
const MAX_BATCH = 500;
const MAX_RECORD_BYTES = 64 * 1024;

export default {
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(runReminders(env)); },
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin') ?? '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    const cors: Record<string, string> = allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
      : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(req, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : 'Server error';
      if (status === 500) console.error(e);
      return json({ error: message }, status, cors);
    }
  },
};

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  const body = async <T>() => { try { return (await req.json()) as T; } catch { throw new HttpError(400, 'Invalid JSON'); } };

  if (req.method === 'GET' && p === '/health') return json({ ok: true });
  if (req.method === 'GET' && p === '/push/key') return json({ publicKey: env.VAPID_PUBLIC_KEY || null });

  if (req.method === 'POST' && p === '/auth/register') {
    const { invite, name } = await body<{ invite?: string; name?: string }>();
    if (!invite || !name?.trim()) throw new HttpError(400, 'invite and name are required');
    const bootstrap = env.BOOTSTRAP_INVITE && timingSafeEqual(normKey(invite).toUpperCase(), normKey(env.BOOTSTRAP_INVITE).toUpperCase()) && !(await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first());
    const user: User = { id: crypto.randomUUID(), name: name.trim().slice(0, 40) };
    if (!bootstrap) {
      // Codes are shown grouped (ABCDE-FGHIJ-KLM): ignore dashes, spaces and case. Claim atomically so a code works once.
      const claim = await env.DB.prepare('UPDATE invites SET used_by = ? WHERE code = ? AND used_by IS NULL').bind(user.id, normKey(invite).toUpperCase()).run();
      if (!claim.meta.changes) throw new HttpError(403, 'Invite code is invalid or already used');
    }
    const recoveryKey = randomKey(24);
    await env.DB.prepare('INSERT INTO users (id, name, recovery_hash, created_at) VALUES (?, ?, ?, ?)').bind(user.id, user.name, await sha256(recoveryKey), Date.now()).run();
    return json({ token: await newSession(env, user.id, req), recoveryKey, user });
  }

  if (req.method === 'POST' && p === '/auth/recover') {
    const { recoveryKey } = await body<{ recoveryKey?: string }>();
    if (!recoveryKey) throw new HttpError(400, 'recoveryKey is required');
    const u = await env.DB.prepare('SELECT id, name FROM users WHERE recovery_hash = ?').bind(await sha256(normKey(recoveryKey).toLowerCase())).first<User>();
    if (!u) throw new HttpError(403, 'Recovery key not recognised');
    return json({ token: await newSession(env, u.id, req), user: u });
  }

  if (req.method === 'POST' && p === '/auth/pair/claim') {
    const { code } = await body<{ code?: string }>();
    if (!code) throw new HttpError(400, 'code is required');
    const h = await sha256(normKey(code).toUpperCase());
    const row = await env.DB.prepare('SELECT user_id, expires_at FROM pair_codes WHERE code_hash = ?').bind(h).first<{ user_id: string; expires_at: number }>();
    await env.DB.prepare('DELETE FROM pair_codes WHERE code_hash = ? OR expires_at < ?').bind(h, Date.now()).run(); // one-time
    if (!row || row.expires_at < Date.now()) throw new HttpError(403, 'Code is invalid or expired');
    const u = await env.DB.prepare('SELECT id, name FROM users WHERE id = ?').bind(row.user_id).first<User>();
    return json({ token: await newSession(env, row.user_id, req), user: u });
  }

  // ---- everything below needs a signed-in device ----
  const user = await authenticate(req, env);

  if (req.method === 'GET' && p === '/me') return json({ user });
  if (req.method === 'POST' && p === '/auth/logout') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(bearer(req)!)).run();
    return json({ ok: true });
  }
  if (req.method === 'POST' && p === '/auth/pair') {
    const code = randomKey(10).toUpperCase();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    await env.DB.prepare('INSERT INTO pair_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(code), user.id, expiresAt).run();
    return json({ code, expiresAt });
  }
  if (req.method === 'POST' && p === '/invites') {
    const code = randomKey(8).toUpperCase();
    await env.DB.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)').bind(code, user.id, Date.now()).run();
    return json({ code });
  }

  if (req.method === 'POST' && p === '/push/subscribe') {
    const { subscription, tz } = await body<{ subscription?: { endpoint: string; keys: { p256dh: string; auth: string } }; tz?: string }>();
    if (!subscription?.endpoint?.startsWith('https://') || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new HttpError(400, 'Bad subscription');
    const zone = tz && Intl.supportedValuesOf('timeZone').includes(tz) ? tz : 'UTC';
    await env.DB.prepare('INSERT INTO push_subs (endpoint, user_id, p256dh, auth, tz, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz')
      .bind(subscription.endpoint, user.id, subscription.keys.p256dh, subscription.keys.auth, zone, Date.now()).run();
    return json({ ok: true, tz: zone });
  }
  if (req.method === 'POST' && p === '/push/unsubscribe') {
    const { endpoint } = await body<{ endpoint?: string }>();
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(endpoint ?? '', user.id).run();
    return json({ ok: true });
  }
  if (req.method === 'POST' && p === '/push/test') {
    if (!env.VAPID_PRIVATE_KEY) throw new HttpError(503, 'Push is not configured on the server');
    const subs = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').bind(user.id).all<{ endpoint: string; p256dh: string; auth: string }>();
    const statuses = [];
    for (const sub of subs.results) statuses.push(await sendPush(env, sub, { title: 'Tap In', body: 'Notifications work ✓', url: './#/settings', tag: 'test' }));
    return json({ sent: statuses.length, statuses });
  }

  if (req.method === 'POST' && p === '/sync/push') {
    const { changes } = await body<{ changes?: { tbl: string; id: string; data: unknown; updatedAt: number }[] }>();
    if (!Array.isArray(changes)) throw new HttpError(400, 'changes must be an array');
    if (changes.length > MAX_BATCH) throw new HttpError(413, `At most ${MAX_BATCH} changes per push`);
    let accepted = 0;
    const stmts: D1PreparedStatement[] = [];
    for (const c of changes) {
      if (!SYNC_TABLES.has(c.tbl) || typeof c.id !== 'string' || !c.id || typeof c.updatedAt !== 'number') throw new HttpError(400, 'Bad change');
      const data = JSON.stringify(c.data);
      if (data.length > MAX_RECORD_BYTES) throw new HttpError(413, `Record ${c.tbl}/${c.id} too large`);
      // Last-write-wins per record: only replace when the incoming client timestamp is newer (idempotent retries).
      stmts.push(env.DB.prepare(
        `INSERT INTO records (user_id, tbl, id, data, updated_at, server_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, (SELECT value + 1 FROM counters WHERE name = 'seq'))
         ON CONFLICT (user_id, tbl, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, server_seq = excluded.server_seq
         WHERE excluded.updated_at > records.updated_at`,
      ).bind(user.id, c.tbl, c.id, data, c.updatedAt));
      stmts.push(env.DB.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'seq'`));
      accepted++;
    }
    const results = stmts.length ? await env.DB.batch(stmts) : []; // a D1 batch runs as one transaction
    accepted = results.filter((_, i) => i % 2 === 0).reduce((a, r) => a + (r.meta.changes ?? 0), 0); // upserts only; older changes are skipped
    const cursor = await env.DB.prepare('SELECT COALESCE(MAX(server_seq), 0) AS c FROM records WHERE user_id = ?').bind(user.id).first<{ c: number }>();
    return json({ accepted, cursor: cursor?.c ?? 0 });
  }

  if (req.method === 'GET' && p === '/sync/pull') {
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
    const limit = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get('limit') ?? MAX_BATCH) || MAX_BATCH));
    const rows = await env.DB.prepare('SELECT tbl, id, data, updated_at, server_seq FROM records WHERE user_id = ? AND server_seq > ? ORDER BY server_seq LIMIT ?')
      .bind(user.id, since, limit + 1).all<{ tbl: string; id: string; data: string; updated_at: number; server_seq: number }>();
    const list = rows.results.slice(0, limit);
    return json({
      changes: list.map((r) => ({ tbl: r.tbl, id: r.id, data: JSON.parse(r.data), updatedAt: r.updated_at })),
      cursor: list.length ? list[list.length - 1].server_seq : since,
      more: rows.results.length > limit,
    });
  }

  throw new HttpError(404, 'Not found');
}

// ---------------- auth helpers ----------------
const bearer = (req: Request) => req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1] ?? null;

async function authenticate(req: Request, env: Env): Promise<User> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Sign in required');
  const h = await sha256(token);
  const row = await env.DB.prepare('SELECT u.id, u.name, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(h).first<User & { last_seen: number }>();
  if (!row) throw new HttpError(401, 'Session expired — sign in again');
  if (Date.now() - row.last_seen > 3600_000) await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(Date.now(), h).run();
  return { id: row.id, name: row.name };
}

async function newSession(env: Env, userId: string, req: Request) {
  const token = randomKey(32);
  const device = (req.headers.get('User-Agent') ?? '').slice(0, 120);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, device) VALUES (?, ?, ?, ?, ?)').bind(await sha256(token), userId, Date.now(), Date.now(), device).run();
  return token;
}

/** Random key in Crockford-style base32 (no ambiguous characters), `bytes` of entropy. */
function randomKey(bytes: number) {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(d)));
}

/** Keys may be shown grouped (abcde-fghij-…) or pasted with spaces. */
const normKey = (k: string) => k.replace(/[^0-9a-z]/gi, '');

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
