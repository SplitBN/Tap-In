// /ai/* routes (contract: docs/agent-contract.md). Called from index.ts after bearer auth.
import type { Env } from '../index';
import { HttpError, json } from '../http';
import { authorizeUrl, exchangeCode, jwtClaims, pkceChallenge, randomToken, SIWC, toMs } from './auth';
import { encrypt } from './crypto';
import { listOpenRouterModels, validateKey } from './openrouter';
import { completeText, loadState, mergeConfig, providerChain, runTurn, saveConfig } from './provider';
import { ProviderError, type AIMessage, type AITool, type TurnEvent, type TurnRequest } from './types';
import { EXTRACT_INSTRUCTIONS, extractPrompt, WebError, webAnswer, webRead } from './web';

const PENDING_MS = 10 * 60_000;
const STALE_MS = 20 * 86400_000;

/** Provider failure → HTTP error for the JSON routes. Never 401 (that means "sign in to Tap In" to the client). */
const providerHttp = (e: ProviderError) => new HttpError(e.code === 'limit' ? 429 : e.code === 'bad_request' ? 400 : 502, e.message, { code: e.code });

export async function handleAi(req: Request, env: Env, ctx: ExecutionContext, userId: string, p: string, url: URL): Promise<Response | null> {
  if (!p.startsWith('/ai/')) return null;
  const body = async <T>() => { try { return (await req.json()) as T; } catch { throw new HttpError(400, 'Invalid JSON'); } };
  const stub = () => env.AI_AUTH.get(env.AI_AUTH.idFromName(userId));

  if (req.method === 'GET' && p === '/ai/status') {
    const s = await loadState(env, userId);
    return json({ chatgpt: s.chatgpt, openrouter: { hasKey: !!s.orKey }, config: s.config });
  }

  if (req.method === 'POST' && p === '/ai/config') {
    const patch = await body<unknown>();
    const s = await loadState(env, userId);
    const config = mergeConfig(s.config, patch);
    await saveConfig(env, userId, config);
    return json({ config });
  }

  if (req.method === 'POST' && p === '/ai/openrouter/key') {
    const { key } = await body<{ key?: string | null }>();
    if (key === null) {
      await env.DB.prepare('UPDATE ai_config SET openrouter_key = NULL, updated_at = ? WHERE user_id = ?').bind(Date.now(), userId).run();
      return json({ hasKey: false });
    }
    const k = typeof key === 'string' ? key.trim() : '';
    if (k.length < 10 || k.length > 300 || /\s/.test(k)) throw new HttpError(400, 'That doesn\'t look like an OpenRouter key');
    if (!(await validateKey(k))) throw new HttpError(400, 'OpenRouter didn\'t accept that key');
    await env.DB.prepare(`INSERT INTO ai_config (user_id, config, openrouter_key, updated_at) VALUES (?, '{}', ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET openrouter_key = excluded.openrouter_key, updated_at = excluded.updated_at`).bind(userId, await encrypt(env.AI_ENC_KEY, k), Date.now()).run();
    return json({ hasKey: true });
  }

  // ---- ChatGPT (SIWC) paste-the-URL flow ----
  if (req.method === 'POST' && p === '/ai/chatgpt/start') {
    const now = Date.now();
    // ext_agent_host_id is stable per user (kept across disconnects, like the issued client id)
    await env.DB.prepare('INSERT OR IGNORE INTO ai_chatgpt (user_id, host_id) VALUES (?, ?)').bind(userId, `urn:uuid:${crypto.randomUUID()}`).run();
    const row = await env.DB.prepare('SELECT host_id, client_id FROM ai_chatgpt WHERE user_id = ?').bind(userId).first<{ host_id: string; client_id: string | null }>();
    const clientId = row?.client_id || SIWC.dynamicClient;
    const state = randomToken(24), nonce = randomToken(24), verifier = randomToken(48);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM ai_oauth_pending WHERE expires_at < ? OR user_id = ?').bind(now, userId), // one attempt at a time per user
      env.DB.prepare('INSERT INTO ai_oauth_pending (state, user_id, verifier, nonce, client_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(state, userId, verifier, nonce, clientId, now + PENDING_MS),
    ]);
    return json({ url: authorizeUrl({ clientId, hostId: row!.host_id, state, nonce, challenge: await pkceChallenge(verifier) }) });
  }

  if (req.method === 'POST' && p === '/ai/chatgpt/finish') {
    const { pastedUrl } = await body<{ pastedUrl?: string }>();
    const q = parsePasted(pastedUrl);
    if (!q) throw new HttpError(400, 'Paste the whole address from the page that failed to load (it starts with http://127.0.0.1)');
    if (q.get('error')) throw new HttpError(400, 'ChatGPT sign-in was cancelled or not allowed — tap Connect to try again');
    const code = q.get('code'), state = q.get('state');
    if (!code || !state) throw new HttpError(400, 'That address has no sign-in code — copy the full address and try again');
    const pend = await env.DB.prepare('SELECT verifier, nonce, client_id, expires_at FROM ai_oauth_pending WHERE state = ? AND user_id = ?').bind(state, userId)
      .first<{ verifier: string; nonce: string; client_id: string; expires_at: number }>();
    await env.DB.prepare('DELETE FROM ai_oauth_pending WHERE state = ?').bind(state).run(); // single use
    if (!pend) throw new HttpError(400, 'That sign-in link doesn\'t match — tap Connect to start again');
    if (pend.expires_at < Date.now()) throw new HttpError(400, 'That sign-in took too long — tap Connect to start again');

    // The registration callback carries the issued client id (oaiapp_…) as ?client_id=; use it for the exchange.
    const pastedClient = q.get('client_id');
    let clientId = pastedClient && pastedClient !== SIWC.dynamicClient ? pastedClient : pend.client_id;
    const r = await exchangeCode({ clientId, code, verifier: pend.verifier });
    if (!r.ok) throw new HttpError(400, r.status === 0 ? 'Could not reach ChatGPT — try again' : `ChatGPT didn't accept the code (${r.status}${r.error ? ` ${r.error}` : ''}) — codes expire fast, tap Connect to try again`);
    const t = r.t;
    const access = jwtClaims(t.access_token), id = jwtClaims(t.id_token);
    if (clientId === SIWC.dynamicClient) clientId = String(access?.client_id ?? (typeof id?.aud === 'string' ? id.aud : '') ?? '') || SIWC.dynamicClient; // last resort
    const scope = String(t.scope ?? access?.scope ?? '');
    if (scope && !scope.split(/[\s,]+/).includes('chatgpt.tokens.use.direct')) throw new HttpError(400, 'ChatGPT plan use wasn\'t allowed — connect again and approve "Use your ChatGPT plan"');
    if (!t.refresh_token) throw new HttpError(400, 'ChatGPT didn\'t grant offline access — tap Connect to try again');
    if (id) { // id_token claims (signature not verified: received directly from the token endpoint over TLS)
      const aud = Array.isArray(id.aud) ? id.aud : [id.aud];
      const bad = String(id.iss ?? '').replace(/\/$/, '') !== SIWC.issuer || (id.nonce != null && id.nonce !== pend.nonce)
        || (typeof id.exp === 'number' && id.exp * 1000 < Date.now() - 300_000) || (clientId !== SIWC.dynamicClient && id.aud != null && !aud.includes(clientId));
      if (bad) throw new HttpError(400, 'ChatGPT sign-in could not be verified — tap Connect to try again');
    }
    const prof = id?.['https://api.openai.com/profile'];
    const email = typeof id?.email === 'string' ? id.email : typeof prof?.email === 'string' ? prof.email : null;
    const now = Date.now();
    await stub().save({ userId, clientId, access: t.access_token, refresh: t.refresh_token, expiresAt: now + (t.expires_in ?? 3600) * 1000, earliestRefreshAt: toMs(t.earliest_refresh_at) });
    await env.DB.prepare('UPDATE ai_chatgpt SET client_id = ?, email = ?, connected_at = ?, refreshed_at = ?, attempt_at = ? WHERE user_id = ?').bind(clientId, email, now, now, now, userId).run();
    return json({ connected: true, ...(email ? { email } : {}) });
  }

  if (req.method === 'POST' && p === '/ai/chatgpt/disconnect') {
    const { revoked } = await stub().disconnect();
    await env.DB.prepare('UPDATE ai_chatgpt SET connected_at = NULL, email = NULL WHERE user_id = ?').bind(userId).run();
    return json({ ok: true, revoked });
  }

  if (req.method === 'GET' && p === '/ai/models') {
    const provider = url.searchParams.get('provider');
    if (provider === 'openrouter') {
      try { return json({ models: await listOpenRouterModels() }); } catch { throw new HttpError(502, 'Could not load OpenRouter models'); }
    }
    if (provider === 'chatgpt') {
      const s = await loadState(env, userId);
      if (!s.chatgpt.connected) throw new HttpError(409, 'ChatGPT is not connected', { code: 'not_connected' });
      const r = await stub().models();
      if (!r.ok) throw new HttpError(502, r.message, { code: r.code });
      return json({ models: r.models });
    }
    throw new HttpError(400, 'provider must be chatgpt or openrouter');
  }

  // ---- one model step, streamed ----
  if (req.method === 'POST' && p === '/ai/turn') return turn(req, env, ctx, userId);

  // ---- web tools ----
  if (req.method === 'POST' && p === '/ai/web/answer') {
    const { query } = await body<{ query?: string }>();
    if (typeof query !== 'string' || !query.trim()) throw new HttpError(400, 'query is required');
    const s = await loadState(env, userId);
    if (!s.orKey) throw new HttpError(409, 'Web answers need an OpenRouter key', { code: 'no_key' });
    try { return json(await webAnswer(s.orKey, s.config.webModel, query.trim().slice(0, 2000))); }
    catch (e) { if (e instanceof ProviderError) throw providerHttp(e); throw e; }
  }

  if (req.method === 'POST' && p === '/ai/web/read') {
    const { url: target, prompt } = await body<{ url?: string; prompt?: string | null }>();
    if (typeof target !== 'string' || !target || target.length > 2048) throw new HttpError(400, 'url is required');
    const extract = async (page: string, question: string) => {
      const chain = providerChain(env, userId, await loadState(env, userId));
      if (!chain.length) return null;
      return (await completeText(chain, EXTRACT_INSTRUCTIONS, extractPrompt(page, question))).trim() || null;
    };
    try { return json(await webRead(target, typeof prompt === 'string' ? prompt : null, extract)); }
    catch (e) { if (e instanceof WebError) throw new HttpError(e.status, e.message); throw e; }
  }

  throw new HttpError(404, 'Not found');
}

/** Accept the full callback URL, or just its query string. */
function parsePasted(s: unknown): URLSearchParams | null {
  if (typeof s !== 'string' || !s.trim() || s.length > 8000) return null;
  const t = s.trim();
  try { const u = new URL(t); return u.searchParams.has('code') || u.searchParams.has('error') ? u.searchParams : new URLSearchParams(u.hash.slice(1)); }
  catch { const i = t.indexOf('?'); return new URLSearchParams(i >= 0 ? t.slice(i + 1) : t); }
}

// ---------------- /ai/turn ----------------
function validTurn(b: any): TurnRequest | null {
  if (!b || typeof b !== 'object') return null;
  const tier = b.tier ?? 'smart';
  if (tier !== 'smart' && tier !== 'cheap') return null;
  if (typeof (b.instructions ?? '') !== 'string' || !Array.isArray(b.messages) || !b.messages.length || !Array.isArray(b.tools ?? [])) return null;
  for (const m of b.messages as AIMessage[]) {
    if (!m || typeof m !== 'object') return null;
    if (m.role === 'user') { if (!Array.isArray(m.content) || !m.content.every((c) => (c?.type === 'text' && typeof c.text === 'string') || (c?.type === 'image' && typeof c.mime === 'string' && /^image\/[\w.+-]+$/.test(c.mime) && typeof c.base64 === 'string'))) return null; }
    else if (m.role === 'assistant') { if ((m.text != null && typeof m.text !== 'string') || (m.toolCalls != null && !(Array.isArray(m.toolCalls) && m.toolCalls.every((c) => typeof c?.id === 'string' && typeof c.name === 'string')))) return null; }
    else if (m.role === 'tool') { if (typeof m.toolCallId !== 'string' || typeof m.content !== 'string') return null; }
    else return null;
  }
  for (const t of (b.tools ?? []) as AITool[]) if (typeof t?.name !== 'string' || !/^[\w-]{1,64}$/.test(t.name) || typeof t.parameters !== 'object') return null;
  return { instructions: b.instructions ?? '', messages: b.messages, tools: (b.tools ?? []).map((t: AITool) => ({ name: t.name, description: String(t.description ?? ''), parameters: t.parameters })), tier };
}

/** Always answers with SSE (errors included), one JSON object per `data:` line. `: ping` comments keep the stream alive. */
async function turn(req: Request, env: Env, ctx: ExecutionContext, userId: string): Promise<Response> {
  // read the body before responding: the request stream can't be read after the response has started
  let parsed: TurnRequest | null = null;
  try { parsed = validTurn(await req.json()); } catch { /* invalid JSON */ }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const abort = new AbortController();
  const write = async (chunk: string) => { try { await w.write(enc.encode(chunk)); } catch { abort.abort(); } };
  const send = (ev: TurnEvent) => write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => { void write(': ping\n\n'); }, 15_000);

  ctx.waitUntil((async () => {
    try {
      await write(': open\n\n');
      if (!parsed) { await send({ type: 'error', code: 'bad_request', message: 'Invalid turn request' }); return; }
      const chain = providerChain(env, userId, await loadState(env, userId));
      for await (const ev of runTurn(chain, parsed, abort.signal)) {
        if (abort.signal.aborted) break; // client went away
        await send(ev);
      }
    } catch (e) {
      console.error('ai turn failed', (e as Error)?.name);
      await send({ type: 'error', code: 'provider', message: 'AI request failed' });
    } finally {
      clearInterval(ping);
      try { await w.close(); } catch { /* already closed */ }
    }
  })());
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

// ---------------- cron ----------------
/** Keep 30-day refresh tokens alive: refresh a few connections older than 20 days per run (at most one attempt/hour each). */
export async function refreshStaleChatgpt(env: Env) {
  if (!env.AI_ENC_KEY) return;
  const now = Date.now();
  const rows = await env.DB.prepare('SELECT user_id FROM ai_chatgpt WHERE connected_at IS NOT NULL AND refreshed_at < ? AND (attempt_at IS NULL OR attempt_at < ?) LIMIT 2')
    .bind(now - STALE_MS, now - 3600_000).all<{ user_id: string }>();
  for (const { user_id } of rows.results) {
    await env.DB.prepare('UPDATE ai_chatgpt SET attempt_at = ? WHERE user_id = ?').bind(now, user_id).run();
    try { await env.AI_AUTH.get(env.AI_AUTH.idFromName(user_id)).refreshNow(); } catch { console.error('chatgpt refresh failed'); }
  }
}
