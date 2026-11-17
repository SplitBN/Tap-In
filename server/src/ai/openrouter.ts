// OpenRouter adapter (OpenAI chat-completions format, user's own API key). Streams text, buffers tool-call argument
// deltas per index and emits each call complete when the stream finishes.
import { parseArgs, ProviderError, sseData, statusError, type AIGlobal, type AIMessage, type AIPart, type AITool, type Provider, type TurnEvent, type TurnRequest } from './types';

export const OPENROUTER = 'https://openrouter.ai/api/v1';
export const OR_HEADERS = { 'HTTP-Referer': 'https://splitbn.github.io/Tap-In/', 'X-Title': 'Tap In' };

function chatPart(p: AIPart) {
  const url = p.type === 'text' ? '' : `data:${p.mime};base64,${p.base64}`;
  switch (p.type) {
    case 'text': return { type: 'text', text: p.text };
    case 'image': return { type: 'image_url', image_url: { url } };
    case 'file': return { type: 'file', file: { filename: p.name || 'file.pdf', file_data: url } }; // OpenRouter parses PDFs for any model
    case 'video': return { type: 'video_url', video_url: { url } };
  }
}

/** Neutral → chat messages. No opaque replay (reasoning output is not sent back).
 *  cache: Anthropic/Gemini models on OpenRouter only cache with explicit breakpoints — one on the (byte-stable) system
 *  prompt (covers tools + instructions) and one on the newest user turn (covers the chat so far). OpenAI-style models
 *  cache implicitly on identical prefixes, so nothing is added for them. */
export const wantsCacheMarks = (model: string) => /^(anthropic|google)\//.test(model);
export function toChat(instructions: string, messages: AIMessage[], cache = false): unknown[] {
  const out: any[] = [];
  const mark = { type: 'ephemeral' };
  if (instructions) out.push({ role: 'system', content: cache ? [{ type: 'text', text: instructions, cache_control: mark }] : instructions });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content.map(chatPart) });
    } else if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
      if (!m.text && !calls.length) continue;
      out.push({ role: 'assistant', content: m.text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  if (cache) { // breakpoint on the last content part of the newest user message
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.role === 'user' && Array.isArray(m.content) && m.content.length) { m.content[m.content.length - 1] = { ...m.content[m.content.length - 1], cache_control: mark }; break; }
    }
  }
  return out;
}

export const toOrTools = (tools: AITool[]) => tools.length ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined;

function chunkError(e: any): ProviderError {
  const c = Number(e?.code);
  if (Number.isFinite(c) && c >= 400) return statusError('OpenRouter', c, String(e?.message ?? ''));
  return new ProviderError('provider', `OpenRouter failed: ${String(e?.message ?? 'unknown error').slice(0, 160)}`, true);
}

/** Parse an OpenRouter chat-completions SSE stream into neutral events. Pure (testable with canned input). */
export async function* parseChatStream(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<TurnEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let usage: { input: number; output: number } | undefined;
  let finished = false, served = model;
  for await (const data of sseData(body)) {
    if (data === '[DONE]') { finished = true; break; }
    let ch: any;
    try { ch = JSON.parse(data); } catch { continue; }
    if (ch.error) throw chunkError(ch.error);
    if (ch.model) served = ch.model;
    if (ch.usage) usage = { input: ch.usage.prompt_tokens ?? 0, output: ch.usage.completion_tokens ?? 0 };
    const choice = ch.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason === 'error') throw chunkError(choice.error ?? ch.error);
    const d = choice.delta ?? {};
    if (typeof d.content === 'string' && d.content) yield { type: 'text', delta: d.content };
    for (const tc of d.tool_calls ?? []) {
      const i = typeof tc.index === 'number' ? tc.index : calls.size;
      const cur = calls.get(i) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(i, cur);
    }
    if (choice.finish_reason) finished = true;
  }
  if (!finished) throw new ProviderError('provider', 'OpenRouter stream ended early', true);
  for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (c.name) yield { type: 'tool_call', call: { id: c.id || `call_${i}_${Date.now().toString(36)}`, name: c.name, args: parseArgs(c.args) } };
  }
  yield { type: 'done', provider: 'openrouter', model: served, usage };
}

export function openrouterProvider(key: string, global: AIGlobal): Provider {
  return {
    id: 'openrouter',
    async model() { return global.models.openrouter; },
    async *turn(req: TurnRequest, model: string, signal?: AbortSignal) {
      const body: Record<string, unknown> = { model, messages: toChat(req.instructions, req.messages, wantsCacheMarks(model)), stream: true, usage: { include: true }, reasoning: { effort: req.effort } };
      if (global.openrouterProvider) body.provider = global.openrouterProvider; // e.g. { order: ['river'], allow_fallbacks: true }
      const tools = toOrTools(req.tools);
      if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
      let res: Response;
      try {
        res = await fetch(`${OPENROUTER}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...OR_HEADERS }, body: JSON.stringify(body), signal });
      } catch { throw new ProviderError('provider', 'Could not reach OpenRouter', true); }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({})) as any).error ?? {};
        throw statusError('OpenRouter', res.status, String(err.message ?? ''));
      }
      if (!res.body) throw new ProviderError('provider', 'OpenRouter sent no stream', true);
      yield* parseChatStream(res.body, model);
    },
  };
}

/** Non-streaming completion (web answers). Returns the raw JSON body. */
export async function orComplete(key: string, body: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${OPENROUTER}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...OR_HEADERS }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new ProviderError('provider', 'Could not reach OpenRouter', true); }
  const j = await res.json().catch(() => ({})) as any;
  if (!res.ok || j.error) throw statusError('OpenRouter', res.ok ? Number(j.error?.code) || 502 : res.status, String(j.error?.message ?? ''));
  return j;
}

/** Cheap key check before saving: GET /api/v1/key. */
export async function validateKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${key}`, ...OR_HEADERS }, signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch { return false; }
}

export type OrModel = { id: string; name: string; input: string[] };
let orCache: { at: number; models: OrModel[] } | null = null; // per isolate; the edge cache also holds it for an hour

export async function listOpenRouterModels(): Promise<OrModel[]> {
  if (orCache && Date.now() - orCache.at < 3600_000) return orCache.models;
  const res = await fetch(`${OPENROUTER}/models`, { headers: OR_HEADERS, signal: AbortSignal.timeout(15_000), cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
  if (!res.ok) throw new ProviderError('provider', `OpenRouter model list failed (${res.status})`);
  const j = await res.json() as { data?: { id: string; name?: string; architecture?: { input_modalities?: string[] } }[] };
  const models = (j.data ?? []).map((m) => ({ id: m.id, name: m.name || m.id, input: m.architecture?.input_modalities ?? [] }));
  orCache = { at: Date.now(), models };
  return models;
}
