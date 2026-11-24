// Provider selection + fallback. Per-user prefs and the (encrypted) OpenRouter key live in D1 `ai_config`; models,
// routing and effort defaults are global (one row in `ai_global`, editable by admins only).
import type { Env } from '../index';
import { chatgptProvider } from './chatgpt';
import { decrypt } from './crypto';
import { openrouterProvider } from './openrouter';
import { DEFAULT_VOICE, mergeVoice } from './voiceConfig';
import { EFFORTS, ProviderError, type AIConfig, type AIGlobal, type Effort, type Provider, type ProviderId, type TurnEvent, type TurnRequest } from './types';

export const DEFAULT_CONFIG: AIConfig = { primary: 'chatgpt', fallback: 'openrouter' };

// z-ai/glm-5.3-flash has a `river` endpoint with tools + reasoning + image/video input (checked 2026-11-17).
export const DEFAULT_GLOBAL: AIGlobal = {
  models: { chatgpt: 'gpt-6.1-sol', openrouter: 'z-ai/glm-5.3-flash' },
  openrouterProvider: { order: ['river'], allow_fallbacks: true },
  defaultEffort: 'auto',
  titleEffort: 'low',
  extractEffort: 'auto',
  webModel: 'perplexity/sonar',
  voice: DEFAULT_VOICE,
};

export const PROVIDERS: ProviderId[] = ['chatgpt', 'openrouter'];
const modelId = (v: unknown) => typeof v === 'string' && v.trim() && v.length <= 200 ? v.trim() : undefined;
export const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort);

/** Merge a (partial, untrusted) per-user config over a base; unknown/invalid fields (incl. old `models`) are ignored. */
export function mergeConfig(base: AIConfig, p: any): AIConfig {
  const c: AIConfig = { primary: base.primary, fallback: base.fallback };
  if (!p || typeof p !== 'object') return c;
  if (PROVIDERS.includes(p.primary)) c.primary = p.primary;
  if (p.fallback === null || PROVIDERS.includes(p.fallback)) c.fallback = p.fallback;
  if (c.fallback === c.primary) c.fallback = p.fallback === undefined ? PROVIDERS.find((x) => x !== c.primary)! : null; // primary moved onto the backup: swap
  return c;
}

/** Merge a (partial, untrusted) global config over a base. */
export function mergeGlobal(base: AIGlobal, p: any): AIGlobal {
  const g: AIGlobal = structuredClone(base);
  if (!p || typeof p !== 'object') return g;
  if (p.models && typeof p.models === 'object') for (const id of PROVIDERS) g.models[id] = modelId(p.models[id]) ?? g.models[id];
  if (p.openrouterProvider === null) g.openrouterProvider = null;
  else if (p.openrouterProvider && typeof p.openrouterProvider === 'object') {
    const order = Array.isArray(p.openrouterProvider.order) ? p.openrouterProvider.order.map(modelId).filter(Boolean).slice(0, 10) as string[] : g.openrouterProvider?.order ?? [];
    const allow = typeof p.openrouterProvider.allow_fallbacks === 'boolean' ? p.openrouterProvider.allow_fallbacks : g.openrouterProvider?.allow_fallbacks ?? true;
    g.openrouterProvider = order.length ? { order, allow_fallbacks: allow } : null; // empty order = let OpenRouter route
  }
  if (isEffort(p.helperEffort)) g.titleEffort = g.extractEffort = p.helperEffort; // v2 rows: helperEffort covered both
  if (isEffort(p.defaultEffort)) g.defaultEffort = p.defaultEffort;
  if (isEffort(p.titleEffort)) g.titleEffort = p.titleEffort;
  if (isEffort(p.extractEffort)) g.extractEffort = p.extractEffort;
  g.webModel = modelId(p.webModel) ?? g.webModel;
  g.voice = mergeVoice(g.voice, p.voice);
  return g;
}

/** "gpt-6.1-sol" → "GPT-6.1 Sol", "z-ai/glm-5.3-flash" → "GLM 5.3 Flash" (used when no display name is known). */
export function prettyModel(id: string) {
  const parts = id.split('/').pop()!.split(/[-_]/).filter(Boolean)
    .map((t) => /^(gpt|glm|ai|r\d*|o\d+)$/i.test(t) ? t.toUpperCase() : /^\d/.test(t) ? t : t[0].toUpperCase() + t.slice(1));
  if (parts[0] === 'GPT' && /^\d/.test(parts[1] ?? '')) parts.splice(0, 2, `GPT-${parts[1]}`);
  return parts.join(' ');
}

export const isAdmin = (env: Env, userId: string) => (env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(userId);

export type AiState = { config: AIConfig; global: AIGlobal; orKey: string | null; chatgpt: { connected: boolean; email?: string } };

export async function loadState(env: Env, userId: string): Promise<AiState> {
  const [cfg, gpt, glob] = await env.DB.batch([
    env.DB.prepare('SELECT config, openrouter_key FROM ai_config WHERE user_id = ?').bind(userId),
    env.DB.prepare('SELECT email, connected_at FROM ai_chatgpt WHERE user_id = ?').bind(userId),
    env.DB.prepare('SELECT config FROM ai_global WHERE id = 1'),
  ]);
  const row = cfg.results[0] as { config: string; openrouter_key: string | null } | undefined;
  const g = gpt.results[0] as { email: string | null; connected_at: number | null } | undefined;
  const parse = (s: string | undefined) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  let orKey: string | null = null;
  if (row?.openrouter_key) { try { orKey = await decrypt(env.AI_ENC_KEY, row.openrouter_key); } catch { orKey = null; } }
  return {
    config: mergeConfig(DEFAULT_CONFIG, parse(row?.config)),
    global: mergeGlobal(DEFAULT_GLOBAL, parse((glob.results[0] as { config: string } | undefined)?.config)),
    orKey,
    chatgpt: { connected: !!g?.connected_at, email: g?.connected_at ? g.email ?? undefined : undefined },
  };
}

export async function saveConfig(env: Env, userId: string, config: AIConfig) {
  await env.DB.prepare('INSERT INTO ai_config (user_id, config, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
    .bind(userId, JSON.stringify(config), Date.now()).run();
}

export async function saveGlobal(env: Env, userId: string, global: AIGlobal) {
  await env.DB.prepare('INSERT INTO ai_global (id, config, updated_at, updated_by) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(JSON.stringify(global), Date.now(), userId).run();
}

export function makeProvider(env: Env, userId: string, s: AiState, id: ProviderId): Provider | null {
  if (id === 'chatgpt') return s.chatgpt.connected ? chatgptProvider(env, userId, s.global) : null;
  return s.orKey ? openrouterProvider(s.orKey, s.global) : null;
}

/** Usable providers in order: the chat's pick (if any), then the user's primary and fallback; unconfigured ones skipped. */
export function providerChain(env: Env, userId: string, s: AiState, preferred?: ProviderId | null): Provider[] {
  const ids = [preferred, s.config.primary, s.config.fallback].filter((x, i, a): x is ProviderId => !!x && a.indexOf(x) === i);
  return ids.map((id) => makeProvider(env, userId, s, id)).filter((p): p is Provider => !!p);
}

/**
 * One model step with fallback. A provider that fails before yielding any event (HTTP error or an in-stream failure
 * such as response.failed) can still fall back to the next one. Never throws: failures become a final `error` event.
 */
export async function* runTurn(chain: Provider[], req: TurnRequest, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  if (!chain.length) { yield { type: 'error', code: 'no_provider', message: 'No AI provider is set up — connect ChatGPT or add an OpenRouter key in Settings → Agent' }; return; }
  let last: ProviderError | null = null;
  for (const p of chain) {
    let sent = false;
    try {
      const model = await p.model();
      for await (const ev of p.turn(req, model, signal)) { sent = true; yield ev.type === 'done' ? { ...ev, effort: req.effort } : ev; }
      return;
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('provider', 'AI request failed', true);
      if (!(e instanceof ProviderError)) console.error('ai turn', p.id, (e as Error)?.name); // no details: may contain user data
      if (sent || !err.fallback || signal?.aborted) { yield { type: 'error', code: err.code, message: err.message }; return; }
      last = err;
    }
  }
  yield { type: 'error', code: last!.code, message: last!.message };
}

/** Collect a tool-less turn into plain text (helper calls: web/read extract). */
export async function completeText(chain: Provider[], instructions: string, text: string, effort: Effort): Promise<string> {
  let out = '';
  for await (const ev of runTurn(chain, { instructions, messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], effort })) {
    if (ev.type === 'text') out += ev.delta;
    else if (ev.type === 'error') throw new ProviderError(ev.code, ev.message);
  }
  return out;
}
