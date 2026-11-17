// ChatGPT "Sign in with ChatGPT" (SIWC) — OAuth helpers + the per-user token holder.
// Refresh tokens rotate (each refresh returns a new one and invalidates the old), so two parallel Workers must never
// refresh the same set: every user's tokens live in one Durable Object (`AiAuth`, idFromName(userId)) that does all
// refreshes behind a single in-flight promise. Only the short-lived access token ever leaves the object. Storage is
// encrypted with AI_ENC_KEY. D1 `ai_chatgpt` is just an index (connected?, email, refreshed_at) for status + cron.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index';
import { decrypt, encrypt } from './crypto';

export const SIWC = {
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  discovery: 'https://auth.openai.com/.well-known/openid-configuration',
  issuer: 'https://auth.openai.com',
  redirectUri: 'http://127.0.0.1:1455/auth/callback', // loopback only; the user pastes the dead-end URL back into the app
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  resource: 'https://api.openai.com/v1',
  dynamicClient: 'dynamic_agent_client', // registration entrypoint only; the callback returns the issued oaiapp_… id
  appName: 'Tap In',
};

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function pkceChallenge(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Decode a JWT payload WITHOUT verifying the signature (tokens come straight from the token endpoint over TLS). */
export function jwtClaims(jwt: string | undefined): Record<string, any> | null {
  try {
    const part = jwt!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part + '='.repeat((4 - (part.length % 4)) % 4)), (c) => c.charCodeAt(0))));
  } catch { return null; }
}

export function authorizeUrl(p: { clientId: string; hostId: string; state: string; nonce: string; challenge: string }) {
  const q = new URLSearchParams({
    client_id: p.clientId, agent_name_hint: SIWC.appName, ext_agent_host_id: p.hostId, response_type: 'code',
    redirect_uri: SIWC.redirectUri, scope: SIWC.scope, resource: SIWC.resource, state: p.state, nonce: p.nonce,
    code_challenge_method: 'S256', code_challenge: p.challenge,
  });
  return `${SIWC.authorize}?${q}`;
}

export type TokenResponse = { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; earliest_refresh_at?: number | string; scope?: string };

async function tokenPost(form: Record<string, string>): Promise<{ ok: true; t: TokenResponse } | { ok: false; status: number; error: string }> {
  let res: Response;
  try {
    res = await fetch(SIWC.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
  } catch { return { ok: false, status: 0, error: 'network' }; }
  const body = await res.json().catch(() => ({})) as any;
  if (!res.ok || !body.access_token) return { ok: false, status: res.status, error: String(body.error?.code ?? body.error ?? body.code ?? '').slice(0, 60) };
  return { ok: true, t: body };
}

export const exchangeCode = (p: { clientId: string; code: string; verifier: string }) =>
  tokenPost({ grant_type: 'authorization_code', client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: SIWC.redirectUri, resource: SIWC.resource });

/** earliest_refresh_at may be unix seconds, ms or an ISO string; normalise to ms. */
export function toMs(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') { const n = Number(v); if (Number.isFinite(n)) return toMs(n); const d = Date.parse(v); if (Number.isFinite(d)) return d; }
  return 0;
}

let revocationUrl: string | null = null;
async function revoke(token: string, clientId: string) {
  try {
    if (!revocationUrl) {
      const d = await fetch(SIWC.discovery, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()) as { revocation_endpoint?: string };
      if (!d.revocation_endpoint?.startsWith('https://')) return false;
      revocationUrl = d.revocation_endpoint;
    }
    const res = await fetch(revocationUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: clientId }), signal: AbortSignal.timeout(10_000) });
    return res.ok; // 200 also when the token was already invalid
  } catch { return false; }
}

export type TokenSet = { userId: string; clientId: string; access: string; refresh: string; expiresAt: number; earliestRefreshAt: number };
export type AccessResult = { ok: true; token: string } | { ok: false; code: 'auth' | 'provider'; message: string };
export type ModelsResult = { ok: true; models: { id: string; name: string }[] } | { ok: false; code: 'auth' | 'provider'; message: string };

const TERMINAL = /invalid_grant|refresh_token_(invalidated|expired|reused)|invalid_client|unauthorized_client/;
const MODELS_TTL = 6 * 3600_000;

export class AiAuth extends DurableObject<Env> {
  private refreshing: Promise<AccessResult> | null = null;

  private async load(): Promise<TokenSet | null> {
    const sealed = await this.ctx.storage.get<string>('tokens');
    if (!sealed) return null;
    try { return JSON.parse(await decrypt(this.env.AI_ENC_KEY, sealed)); } catch { return null; }
  }
  private async store(t: TokenSet) { await this.ctx.storage.put('tokens', await encrypt(this.env.AI_ENC_KEY, JSON.stringify(t))); }

  /** Called once after a successful code exchange. */
  async save(t: TokenSet) { await this.store(t); await this.ctx.storage.delete('models'); }

  /** A valid access token, refreshing when it is (nearly) expired or `force` (after a 401). */
  async access(force = false): Promise<AccessResult> {
    const t = await this.load();
    if (!t) return { ok: false, code: 'auth', message: 'ChatGPT is not connected' };
    if (!force && t.expiresAt - 120_000 > Date.now()) return { ok: true, token: t.access };
    return this.refresh();
  }

  /** Cron: refresh now so the 30-day refresh token never lapses. */
  async refreshNow(): Promise<AccessResult> { return this.refresh(); }

  private refresh(): Promise<AccessResult> {
    // one refresh at a time: concurrent callers share the same promise (the old refresh token dies on first use)
    this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<AccessResult> {
    const t = await this.load();
    if (!t) return { ok: false, code: 'auth', message: 'ChatGPT is not connected' };
    const r = await tokenPost({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh, resource: SIWC.resource });
    const now = Date.now();
    if (!r.ok) {
      if ((r.status === 400 || r.status === 401) && TERMINAL.test(r.error)) { // terminal: the user must sign in again
        await this.ctx.storage.delete('tokens');
        await this.env.DB.prepare('UPDATE ai_chatgpt SET connected_at = NULL, attempt_at = ? WHERE user_id = ?').bind(now, t.userId).run();
        return { ok: false, code: 'auth', message: 'ChatGPT sign-in expired — reconnect ChatGPT in Settings' };
      }
      // transient (network / 5xx / unknown): keep the credentials, try again later
      await this.env.DB.prepare('UPDATE ai_chatgpt SET attempt_at = ? WHERE user_id = ?').bind(now, t.userId).run();
      return { ok: false, code: 'provider', message: 'Could not refresh the ChatGPT sign-in, try again shortly' };
    }
    const next: TokenSet = {
      ...t, access: r.t.access_token, refresh: r.t.refresh_token || t.refresh,
      expiresAt: now + (r.t.expires_in ?? 3600) * 1000, earliestRefreshAt: toMs(r.t.earliest_refresh_at),
    };
    await this.store(next); // persist the rotated refresh token before anyone can use the new access token
    await this.env.DB.prepare('UPDATE ai_chatgpt SET refreshed_at = ?, attempt_at = ? WHERE user_id = ?').bind(now, now, t.userId).run();
    return { ok: true, token: next.access };
  }

  /** Revoke (best effort), then clear tokens. Host id and issued client id stay in D1 for the next sign-in. */
  async disconnect(): Promise<{ revoked: boolean }> {
    await this.refreshing?.catch(() => {}); // let an in-flight refresh land first, so the newest token is revoked
    const t = await this.load();
    const revoked = t ? await revoke(t.refresh, t.clientId) : true;
    await this.ctx.storage.deleteAll();
    return { revoked };
  }

  /** ChatGPT model list (visibility == "list", server order), cached for a few hours. */
  async models(): Promise<ModelsResult> {
    const cached = await this.ctx.storage.get<{ at: number; models: { id: string; name: string }[] }>('models');
    if (cached && Date.now() - cached.at < MODELS_TTL && cached.models.length) return { ok: true, models: cached.models };
    for (let attempt = 0; attempt < 2; attempt++) {
      const a = await this.access(attempt > 0);
      if (!a.ok) return a;
      let res: Response;
      try { res = await fetch(`${SIWC.resource}/models`, { headers: { Authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(15_000) }); }
      catch { return { ok: false, code: 'provider', message: 'Could not reach ChatGPT' }; }
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) return { ok: false, code: res.status === 401 || res.status === 403 ? 'auth' : 'provider', message: `ChatGPT model list failed (${res.status})` };
      const body = await res.json().catch(() => ({})) as { models?: { slug?: string; display_name?: string; visibility?: string }[]; data?: { id?: string }[] };
      const models = (body.models ?? []).filter((m) => m.visibility === 'list' && m.slug).map((m) => ({ id: m.slug!, name: m.display_name || m.slug! }));
      if (!models.length && body.data) for (const m of body.data) if (m.id) models.push({ id: m.id, name: m.id }); // defensive: OpenAI-style list
      if (models.length) await this.ctx.storage.put('models', { at: Date.now(), models });
      return { ok: true, models };
    }
    return { ok: false, code: 'auth', message: 'ChatGPT rejected the sign-in' };
  }
}
