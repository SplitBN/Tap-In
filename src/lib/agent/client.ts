// Client for the Worker's /ai/* routes (docs/agent-contract.md). The app never talks to a provider directly.
// Fake mode (localStorage['tapin:fakeAI'] set): no network at all — a scripted model and canned data (see fake.ts),
// so the UI and the loop can be tested without credentials.
import { apiAuth } from '../sync';
import { fakeConfig, fakeGlobal, fakeModels, fakeStatus, fakeTurn, fakeWebAnswer, fakeWebRead } from './fake';
import type { AIConfig, AIGlobal, AIModel, AIProviderInfo, AIStatus, ProviderId, TurnEvent, TurnRequest } from './types';

export const isFake = () => { try { return !!localStorage.getItem('tapin:fakeAI'); } catch { return false; } };

export class AIError extends Error {
  status: number; code?: string;
  constructor(message: string, status = 0, code?: string) { super(message); this.status = status; this.code = code; }
}

async function authed() {
  const a = await apiAuth();
  if (!a) throw new AIError('Sign in first: Settings → Back up & sync. The assistant runs through your Tap In account.', 401, 'signed_out');
  return a;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const a = await authed();
  let res: Response;
  try {
    res = await fetch(`${a.api}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` } });
  } catch { throw new AIError('Could not reach the server. Check your connection.', 0, 'network'); }
  const body = await res.json().catch(() => ({})) as { error?: string; message?: string; code?: string };
  if (!res.ok) throw new AIError(body.error ?? body.message ?? `HTTP ${res.status}`, res.status, body.code);
  return body as T;
}
const post = <T>(path: string, body: unknown = {}) => req<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const DEFAULT_GLOBAL: AIGlobal = {
  models: { chatgpt: 'gpt-6.1-sol', openrouter: 'z-ai/glm-5.3-flash' }, openrouterProvider: { order: ['river'], allow_fallbacks: true },
  defaultEffort: 'auto', titleEffort: 'low', extractEffort: 'auto', webModel: 'perplexity/sonar',
  voice: { sttModel: 'openai/gpt-transcribe', ttsModel: 'elevenlabs/eleven-v4-turbo', ttsVoice: 'sarah', ttsStyle: 'Warm, relaxed and conversational, like a friendly coach on a phone call. Natural pace.' },
};
/** One place that turns whatever /ai/status returns (v2, or a lagging v1 Worker) into the v2 shape. */
export function normalizeStatus(raw: Partial<AIStatus> & { config?: Partial<AIConfig> }): AIStatus {
  const chatgpt = { connected: !!raw.chatgpt?.connected, ...(raw.chatgpt?.email ? { email: raw.chatgpt.email } : {}) };
  const openrouter = { hasKey: !!raw.openrouter?.hasKey };
  const g0 = (raw.global ?? {}) as Partial<AIGlobal> & { helperEffort?: AIGlobal['titleEffort'] }; // helperEffort: v2 rows
  const { helperEffort, ...g1 } = g0;
  const global: AIGlobal = { ...DEFAULT_GLOBAL, ...(helperEffort ? { titleEffort: helperEffort, extractEffort: helperEffort } : {}), ...g1, models: { ...DEFAULT_GLOBAL.models, ...g0.models }, voice: { ...DEFAULT_GLOBAL.voice!, ...g0.voice } };
  const providers: AIProviderInfo[] = Array.isArray(raw.providers) && raw.providers.length ? raw.providers : [
    { id: 'chatgpt', connected: chatgpt.connected, model: global.models.chatgpt, label: 'ChatGPT', video: false, files: true },
    { id: 'openrouter', connected: openrouter.hasKey, model: global.models.openrouter, label: 'OpenRouter', video: false, files: true },
  ];
  return { isAdmin: !!raw.isAdmin, global, chatgpt, openrouter, providers,
    config: { primary: raw.config?.primary ?? 'chatgpt', fallback: raw.config?.fallback === undefined ? 'openrouter' : raw.config.fallback } };
}
export const getStatus = async (): Promise<AIStatus> => normalizeStatus(isFake() ? fakeStatus() : await req('/ai/status'));
export const setConfig = (patch: Partial<AIConfig>): Promise<{ config: AIConfig }> => (isFake() ? Promise.resolve({ config: fakeConfig(patch) }) : post('/ai/config', patch));
/** Admin only (403 otherwise). */
export const setGlobal = (patch: Partial<AIGlobal>): Promise<{ global: AIGlobal }> => (isFake() ? Promise.resolve({ global: fakeGlobal(patch) }) : post('/ai/global', patch));
export const setOpenRouterKey = (key: string | null): Promise<{ hasKey: boolean }> => (isFake() ? Promise.resolve({ hasKey: !!key }) : post('/ai/openrouter/key', { key }));
export const chatgptStart = (): Promise<{ url: string }> => (isFake() ? Promise.resolve({ url: 'https://example.com/fake-sign-in' }) : post('/ai/chatgpt/start'));
export const chatgptFinish = (pastedUrl: string): Promise<{ connected: true; email?: string }> =>
  (isFake() ? Promise.resolve({ connected: true as const, email: 'fake@example.com' }) : post('/ai/chatgpt/finish', { pastedUrl }));
export const chatgptDisconnect = (): Promise<{ ok: boolean; revoked?: boolean }> => (isFake() ? Promise.resolve({ ok: true, revoked: true }) : post('/ai/chatgpt/disconnect'));
export const getModels = async (provider: ProviderId): Promise<AIModel[]> =>
  (isFake() ? fakeModels(provider) : (await req<{ models: AIModel[] }>(`/ai/models?provider=${provider}`)).models);
export const webAnswer = (query: string, academic = false): Promise<{ answer: string; citations: string[] }> => (isFake() ? Promise.resolve(fakeWebAnswer(query)) : post('/ai/web/answer', { query, ...(academic ? { academic: true } : {}) }));
export const webRead = (url: string, prompt?: string | null): Promise<{ mode: 'raw' | 'extract' | 'full'; content: string; tokens: number; title?: string }> =>
  (isFake() ? Promise.resolve(fakeWebRead(url)) : post('/ai/web/read', { url, prompt: prompt ?? null }));

/** One model step. Yields SSE events; always ends with exactly one `done` or `error`. */
export async function* turn(body: TurnRequest, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  if (isFake()) { yield* fakeTurn(body, signal); return; }
  let a;
  try { a = await authed(); } catch (e) { yield { type: 'error', code: 'auth', message: (e as Error).message }; return; }
  let res: Response;
  try {
    res = await fetch(`${a.api}/ai/turn`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}`, Accept: 'text/event-stream' }, body: JSON.stringify(body) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    yield { type: 'error', code: 'network', message: 'Could not reach the server. Check your connection.' }; return;
  }
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => ({})) as { error?: string; message?: string };
    const code = res.status === 401 ? 'auth' : res.status === 429 ? 'limit' : res.status === 400 ? 'bad_request' : res.status === 409 ? 'no_provider' : 'provider';
    yield { type: 'error', code, message: b.message ?? b.error ?? `HTTP ${res.status}` }; return;
  }
  yield* parseSSE(res.body, signal);
}

/** SSE over fetch streaming: buffers across chunks, one JSON object per `data:` line, blank line ends an event. */
export async function* parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '', data: string[] = [], ended = false;
  const flush = function* (): Generator<TurnEvent> {
    if (!data.length) return;
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') return;
    let ev: TurnEvent;
    try { ev = JSON.parse(raw) as TurnEvent; } catch { return; }
    if (ev.type === 'done' || ev.type === 'error') ended = true;
    yield ev;
  };
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      buf += dec.decode(value ?? new Uint8Array(), { stream: !done });
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
        if (line === '') { yield* flush(); if (ended) return; continue; }
        if (line.startsWith(':')) continue; // comment / keep-alive
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) break;
    }
    if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
    yield* flush();
    if (!ended) yield { type: 'error', code: 'network', message: 'The connection dropped before the reply finished. Try again.' };
  } catch (e) {
    if ((e as Error).name !== 'AbortError') yield { type: 'error', code: 'network', message: 'The connection dropped before the reply finished. Try again.' };
  } finally { reader.releaseLock?.(); }
}
