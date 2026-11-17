// Neutral AI types — mirror of app/src/lib/agent/types.ts (see docs/agent-contract.md). Keep in sync.
export type AIPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; base64: string }
  | { type: 'file'; mime: string; name: string; base64: string } // PDF ≤ 10 MB
  | { type: 'video'; mime: string; base64: string };             // ≤ 20 MB, only for providers with video:true
export type AIToolCall = { id: string; name: string; args: Record<string, unknown> };
export type AIMessage =
  | { role: 'user'; content: AIPart[] }
  | { role: 'assistant'; text?: string; toolCalls?: AIToolCall[]; opaque?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
export type AITool = { name: string; description: string; parameters: Record<string, unknown> };
export type Effort = 'low' | 'medium' | 'high';
export const EFFORTS: Effort[] = ['low', 'medium', 'high'];
export type ProviderId = 'chatgpt' | 'openrouter';

/** Per user: which provider to prefer when both are connected. */
export type AIConfig = { primary: ProviderId; fallback: ProviderId | null };

/** Global (admin-only) config, one row in D1 ai_global. */
export type AIGlobal = {
  models: { chatgpt: string; openrouter: string }; // chatgpt: if not in the account's list → first listed
  openrouterProvider: { order: string[]; allow_fallbacks: boolean } | null; // sent as OpenRouter `provider`
  defaultEffort: Effort;
  helperEffort: Effort; // titles, web/read extract
  webModel: string;
};

export type TurnRequest = { instructions: string; messages: AIMessage[]; tools: AITool[]; effort: Effort };

export type ErrorCode = 'no_provider' | 'auth' | 'limit' | 'provider' | 'bad_request';
export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: AIToolCall }
  | { type: 'done'; provider: string; model: string; effort?: Effort; opaque?: unknown; usage?: { input: number; output: number } }
  | { type: 'error'; code: ErrorCode; message: string };

/** Provider failure. `fallback` = eligible for retrying on the backup provider (auth / 429 / 5xx / network). */
export class ProviderError extends Error {
  constructor(public code: ErrorCode, message: string, public fallback = false) { super(message); }
}

/** One adapter = one provider. `turn` streams one model step; it throws ProviderError on failure. */
export interface Provider {
  id: ProviderId;
  model(): Promise<string>;
  turn(req: TurnRequest, model: string, signal?: AbortSignal): AsyncGenerator<TurnEvent>;
}

/** Map an upstream HTTP status to an error (never includes the upstream body verbatim beyond a short message). */
export function statusError(provider: string, status: number, detail = ''): ProviderError {
  const d = detail ? `: ${detail.slice(0, 160)}` : '';
  if (status === 401 || status === 403) return new ProviderError('auth', `${provider} rejected the credentials${d}`, true);
  if (status === 402) return new ProviderError('limit', `${provider}: out of credits${d}`, true);
  if (status === 429) return new ProviderError('limit', `${provider} usage limit reached${d}`, true);
  if (status >= 500) return new ProviderError('provider', `${provider} is unavailable (${status})`, true);
  return new ProviderError('bad_request', `${provider} refused the request (${status})${d}`);
}

/** Read an SSE body and yield each `data:` payload (joined across multi-line events). Comments (":") are skipped. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line === '') { if (data.length) yield data.join('\n'); data = []; }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
    if (data.length) yield data.join('\n');
  } finally { reader.releaseLock(); }
}

/** Parse tool-call arguments; invalid JSON is passed through so the client's validation reports it. */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : { _value: v }; } catch { return { _invalid_json: raw.slice(0, 2000) }; }
}
