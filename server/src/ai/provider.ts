// Provider selection + fallback. Config and the (encrypted) OpenRouter key live in D1 `ai_config`, per user.
import type { Env } from '../index';
import { chatgptProvider } from './chatgpt';
import { decrypt } from './crypto';
import { openrouterProvider } from './openrouter';
import { ProviderError, type AIConfig, type Provider, type ProviderId, type TurnEvent, type TurnRequest } from './types';

// Defaults checked against openrouter.ai/api/v1/models on 2026-11-17.
export const DEFAULT_CONFIG: AIConfig = {
  primary: 'chatgpt',
  fallback: 'openrouter',
  models: { chatgpt: { smart: null, cheap: null }, openrouter: { smart: 'anthropic/claude-sonnet-5.5', cheap: 'anthropic/claude-haiku-5.5' } },
  webModel: 'perplexity/sonar',
};

const PROVIDERS: ProviderId[] = ['chatgpt', 'openrouter'];
const modelId = (v: unknown) => typeof v === 'string' && v.trim() && v.length <= 200 ? v.trim() : undefined;

/** Merge a (partial, untrusted) config over a base; unknown/invalid fields are ignored. */
export function mergeConfig(base: AIConfig, p: any): AIConfig {
  const c: AIConfig = structuredClone(base);
  if (!p || typeof p !== 'object') return c;
  if (PROVIDERS.includes(p.primary)) c.primary = p.primary;
  if (p.fallback === null || PROVIDERS.includes(p.fallback)) c.fallback = p.fallback;
  if (c.fallback === c.primary) c.fallback = p.fallback === undefined ? PROVIDERS.find((x) => x !== c.primary)! : null; // primary moved onto the backup: swap
  const m = p.models ?? {};
  for (const tier of ['smart', 'cheap'] as const) {
    if (m.chatgpt && tier in m.chatgpt) c.models.chatgpt[tier] = m.chatgpt[tier] === null ? null : modelId(m.chatgpt[tier]) ?? c.models.chatgpt[tier];
    if (m.openrouter && tier in m.openrouter) c.models.openrouter[tier] = modelId(m.openrouter[tier]) ?? c.models.openrouter[tier];
  }
  c.webModel = modelId(p.webModel) ?? c.webModel;
  return c;
}

export type AiState = { config: AIConfig; orKey: string | null; chatgpt: { connected: boolean; email?: string } };

export async function loadState(env: Env, userId: string): Promise<AiState> {
  const [cfg, gpt] = await env.DB.batch([
    env.DB.prepare('SELECT config, openrouter_key FROM ai_config WHERE user_id = ?').bind(userId),
    env.DB.prepare('SELECT email, connected_at FROM ai_chatgpt WHERE user_id = ?').bind(userId),
  ]);
  const row = cfg.results[0] as { config: string; openrouter_key: string | null } | undefined;
  const g = gpt.results[0] as { email: string | null; connected_at: number | null } | undefined;
  let stored: unknown = null;
  try { stored = row ? JSON.parse(row.config) : null; } catch { /* ignore */ }
  let orKey: string | null = null;
  if (row?.openrouter_key) { try { orKey = await decrypt(env.AI_ENC_KEY, row.openrouter_key); } catch { orKey = null; } }
  return { config: mergeConfig(DEFAULT_CONFIG, stored), orKey, chatgpt: { connected: !!g?.connected_at, email: g?.connected_at ? g.email ?? undefined : undefined } };
}

export async function saveConfig(env: Env, userId: string, config: AIConfig) {
  await env.DB.prepare('INSERT INTO ai_config (user_id, config, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
    .bind(userId, JSON.stringify(config), Date.now()).run();
}

export function makeProvider(env: Env, userId: string, s: AiState, id: ProviderId): Provider | null {
  if (id === 'chatgpt') return s.chatgpt.connected ? chatgptProvider(env, userId, s.config) : null;
  return s.orKey ? openrouterProvider(s.orKey, s.config) : null;
}

/** Usable providers in order: primary, then fallback (unconfigured ones are skipped). */
export function providerChain(env: Env, userId: string, s: AiState): Provider[] {
  const ids = [s.config.primary, s.config.fallback].filter((x, i, a): x is ProviderId => !!x && a.indexOf(x) === i);
  return ids.map((id) => makeProvider(env, userId, s, id)).filter((p): p is Provider => !!p);
}

/**
 * One model step with fallback. A provider that fails before yielding any event (HTTP error or an in-stream failure
 * such as response.failed) can still fall back to the next one. Never throws:
 * failures become a final `error` event.
 */
export async function* runTurn(chain: Provider[], req: TurnRequest, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  if (!chain.length) { yield { type: 'error', code: 'no_provider', message: 'No AI provider is set up — connect ChatGPT or add an OpenRouter key in Settings → Agent' }; return; }
  let last: ProviderError | null = null;
  for (const p of chain) {
    let sent = false;
    try {
      const model = await p.model(req.tier);
      for await (const ev of p.turn(req, model, signal)) { sent = true; yield ev; }
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

/** Collect a tool-less turn into plain text (used by web/read extract). */
export async function completeText(chain: Provider[], instructions: string, text: string): Promise<string> {
  let out = '';
  for await (const ev of runTurn(chain, { instructions, messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], tier: 'cheap' })) {
    if (ev.type === 'text') out += ev.delta;
    else if (ev.type === 'error') throw new ProviderError(ev.code, ev.message);
  }
  return out;
}
