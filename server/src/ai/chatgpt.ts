// ChatGPT-plan adapter (SIWC tokens → OpenAI Responses API). Rules from the SIWC preview: store:false + stream:true,
// full history in `input` every time (no previous_response_id), system prompt via `instructions`, and none of
// temperature/top_p/max_output_tokens/metadata/user/… . Reasoning items come back encrypted (include
// reasoning.encrypted_content); we hand them to the client as `opaque` and replay them next turn.
import type { Env } from '../index';
import { parseArgs, ProviderError, sseData, statusError, type AIGlobal, type AIMessage, type AIPart, type AITool, type Provider, type TurnEvent, type TurnRequest } from './types';

const API = 'https://api.openai.com/v1'; // = SIWC.resource
const NS = 'tapin';
let useNamespace = false; // flipped (per isolate) if the API rejects top-level function tools

type Opaque = { provider: 'chatgpt'; items: unknown[] };
const isOurs = (o: unknown): o is Opaque => !!o && typeof o === 'object' && (o as Opaque).provider === 'chatgpt' && Array.isArray((o as Opaque).items);

function inputPart(p: AIPart) {
  switch (p.type) {
    case 'text': return { type: 'input_text', text: p.text };
    case 'image': return { type: 'input_image', image_url: `data:${p.mime};base64,${p.base64}`, detail: 'auto' };
    case 'file': return { type: 'input_file', filename: p.name || 'file.pdf', file_data: `data:${p.mime};base64,${p.base64}` };
    // fallback-eligible so a backup provider with video can take the turn; otherwise the user sees this message
    case 'video': throw new ProviderError('bad_request', 'ChatGPT can\'t watch videos — send photos (frames) instead, or switch this chat to a provider with video', true);
  }
}

/** Neutral messages → Responses `input` items. Opaque items from other providers are dropped. */
export function toInput(messages: AIMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content.map(inputPart) });
    } else if (m.role === 'assistant') {
      if (isOurs(m.opaque)) out.push(...m.opaque.items); // reasoning first, as the model produced it
      if (m.text) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.text, annotations: [] }] });
      for (const c of m.toolCalls ?? []) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    } else {
      out.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
    }
  }
  return out;
}

export function toTools(tools: AITool[], namespaced: boolean): unknown[] | undefined {
  if (!tools.length) return undefined;
  const fns = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  // Undocumented shape (preview page only says "group in namespaces"); used only if top-level tools are rejected.
  return namespaced ? [{ type: 'namespace', name: NS, description: 'Tap In app tools', tools: fns }] : fns;
}

const errText = (e: any) => String(e?.message ?? '').slice(0, 160);
function streamError(e: any): ProviderError {
  const code = String(e?.code ?? e?.type ?? '');
  if (/usage_limit|rate_limit|quota/.test(code)) return new ProviderError('limit', 'ChatGPT plan usage limit reached — check ChatGPT Settings → Usage', true);
  if (/invalid_user|unauthorized|invalid_api_key|token/.test(code)) return new ProviderError('auth', 'ChatGPT rejected the sign-in — reconnect ChatGPT', true);
  return new ProviderError('provider', `ChatGPT failed${code ? ` (${code.slice(0, 60)})` : ''}`, true);
}

/** Parse a Responses SSE stream into neutral events. Pure (testable with canned input). */
export async function* parseResponsesStream(body: ReadableStream<Uint8Array>, model: string, toolNames: Set<string>): AsyncGenerator<TurnEvent> {
  const reasoning: unknown[] = [];
  for await (const data of sseData(body)) {
    if (data === '[DONE]') break;
    let ev: any;
    try { ev = JSON.parse(data); } catch { continue; }
    switch (ev.type) {
      case 'response.output_text.delta':
        if (ev.delta) yield { type: 'text', delta: ev.delta };
        break;
      case 'response.output_item.done': {
        const it = ev.item ?? {};
        if (it.type === 'function_call') {
          let name = String(it.name ?? '');
          if (!toolNames.has(name)) { const s = name.replace(new RegExp(`^${NS}(\\.|__|:|/)`), ''); if (toolNames.has(s)) name = s; }
          yield { type: 'tool_call', call: { id: String(it.call_id ?? it.id), name, args: parseArgs(String(it.arguments ?? '')) } };
        } else if (it.type === 'reasoning' && it.encrypted_content) {
          reasoning.push(it);
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const u = ev.response?.usage;
        yield { type: 'done', provider: 'chatgpt', model: ev.response?.model ?? model, opaque: reasoning.length ? { provider: 'chatgpt', items: reasoning } : undefined, usage: u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 } : undefined };
        return;
      }
      case 'response.failed':
        throw streamError(ev.response?.error);
      case 'error':
        throw streamError(ev.error ?? ev);
    }
  }
  throw new ProviderError('provider', 'ChatGPT stream ended early', true);
}

/** The global ChatGPT model if this account lists it, else the account's first listed model (lists are cached in AiAuth). */
export async function resolveChatgptModel(env: Env, userId: string, wanted: string): Promise<{ id: string; name: string | null }> {
  const r = await env.AI_AUTH.get(env.AI_AUTH.idFromName(userId)).models();
  if (!r.ok || !r.models.length) return { id: wanted, name: null }; // can't check: try the configured one
  return r.models.find((m) => m.id === wanted) ?? r.models[0];
}

export function chatgptProvider(env: Env, userId: string, global: AIGlobal): Provider {
  const stub = () => env.AI_AUTH.get(env.AI_AUTH.idFromName(userId));
  return {
    id: 'chatgpt',
    async model() { return (await resolveChatgptModel(env, userId, global.models.chatgpt)).id; },
    async *turn(req: TurnRequest, model: string, signal?: AbortSignal) {
      const input = toInput(req.messages);
      let res: Response | null = null;
      let refreshed = false, force = false, triedNs = false, noReasoning = false;
      let firstErr: any = null;
      for (;;) {
        const a = await stub().access(force);
        force = false;
        if (!a.ok) throw new ProviderError(a.code, a.message, true);
        const body: Record<string, unknown> = {
          model, instructions: req.instructions, input, store: false, stream: true, include: ['reasoning.encrypted_content'],
        };
        if (!noReasoning) body.reasoning = { effort: req.effort };
        const tools = toTools(req.tools, useNamespace);
        if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
        try {
          res = await fetch(`${API}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
        } catch { throw new ProviderError('provider', 'Could not reach ChatGPT', true); }
        if (res.ok) break;
        let err = (await res.json().catch(() => ({})) as any).error ?? {};
        if (res.status === 401 && !refreshed) { refreshed = force = true; continue; } // access token revoked/expired early: refresh once
        if (res.status === 400 && !noReasoning && /reasoning|effort/i.test(`${err.message} ${err.param}`)) { noReasoning = true; continue; } // model without effort control
        if (res.status === 400 && tools && !triedNs && /tool|function|namespace/i.test(`${err.message} ${err.param}`)) { triedNs = true; firstErr = err; useNamespace = !useNamespace; continue; }
        if (triedNs) { useNamespace = !useNamespace; if (res.status === 400) err = firstErr; } // the other shape failed too: revert, report the original error
        if (res.status === 429) throw streamError({ code: err.code || 'usage_limit' });
        if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'ChatGPT rejected the sign-in — reconnect ChatGPT', true);
        throw statusError('ChatGPT', res.status, errText(err));
      }
      if (!res.body) throw new ProviderError('provider', 'ChatGPT sent no stream', true);
      yield* parseResponsesStream(res.body, model, new Set(req.tools.map((t) => t.name)));
    },
  };
}
