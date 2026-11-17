// Fake provider for development (localStorage['tapin:fakeAI'] = '1'). A tiny scripted "model" that is a pure
// function of the messages it is given — no hidden state — so reload / Apply / Reject all behave like the real loop.
//   "log eggs"            → one batched run_query (foods.search) → request_changes entries.logMany with alternatives
//   photo + "log this…"   → ask_user (2 multiple-choice questions) → batched run_query (rice, chicken) → food request
//   "remember X"          → memory_write
//   "search X"            → web_answer
//   anything else         → echoes the text, streamed
// Title calls (no tools) get a short title. Status: admin, both providers connected.
import type { AIConfig, AIGlobal, AIMessage, AIModel, AIStatus, ProviderId, TurnEvent, TurnRequest } from './types';

const CFG_KEY = 'tapin:fakeAIConfig';
const GLOBAL_KEY = 'tapin:fakeAIGlobal';
const DEFAULT_CFG: AIConfig = { primary: 'chatgpt', fallback: 'openrouter' };
const DEFAULT_GLOBAL: AIGlobal = {
  models: { chatgpt: 'gpt-6.1-sol', openrouter: 'z-ai/glm-5.3-flash' }, openrouterProvider: { order: ['river'], allow_fallbacks: true },
  defaultEffort: 'medium', helperEffort: 'low', webModel: 'perplexity/sonar',
};
const read = <T,>(k: string, d: T): T => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) ?? '{}') }; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
export function fakeConfig(patch: Partial<AIConfig> = {}): AIConfig { const n = { ...read(CFG_KEY, DEFAULT_CFG), ...patch }; write(CFG_KEY, n); return n; }
export function fakeGlobal(patch: Partial<AIGlobal> = {}): AIGlobal { const n = { ...read(GLOBAL_KEY, DEFAULT_GLOBAL), ...patch }; write(GLOBAL_KEY, n); return n; }
const LABELS: Record<string, string> = { 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6.1-mini': 'GPT-6.1 mini', 'z-ai/glm-5.3-flash': 'GLM 5.3 Flash', 'anthropic/claude-sonnet-5': 'Claude Sonnet 5' };
export function fakeStatus(): AIStatus {
  const global = read(GLOBAL_KEY, DEFAULT_GLOBAL);
  return {
    isAdmin: true, global, config: read(CFG_KEY, DEFAULT_CFG), chatgpt: { connected: true, email: 'fake@example.com' }, openrouter: { hasKey: true },
    providers: [
      { id: 'chatgpt', connected: true, model: global.models.chatgpt, label: LABELS[global.models.chatgpt] ?? global.models.chatgpt, video: false, files: true },
      { id: 'openrouter', connected: true, model: global.models.openrouter, label: LABELS[global.models.openrouter] ?? global.models.openrouter, video: true, files: true },
    ],
  };
}
export const fakeModels = (p: ProviderId): AIModel[] => (p === 'chatgpt'
  ? [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }, { id: 'gpt-6.1-mini', name: 'GPT-6.1 mini' }]
  : [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }, { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' }, { id: 'perplexity/sonar', name: 'Perplexity Sonar' }]);
export const fakeWebAnswer = (query: string) => ({ answer: `(fake) A short web answer about “${query}”.`, citations: ['https://example.com/source'] });
export const fakeWebRead = (url: string) => ({ mode: 'raw' as const, content: `(fake) The readable text of ${url}.`, tokens: 12, title: 'Example page' });

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); });

const userText = (m: AIMessage | undefined) => (m?.role === 'user' ? m.content.map((p) => (p.type === 'text' && !p.text.startsWith('<context>') ? p.text : '')).join(' ').trim() : '');
const hasMedia = (m: AIMessage | undefined) => m?.role === 'user' && m.content.some((p) => p.type !== 'text');
const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

type Plan = { text?: string; call?: { name: string; args: Record<string, unknown> } };

function plan(msgs: AIMessage[], tools: string[]): Plan {
  const last = msgs[msgs.length - 1];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && userText(m));
  const said = userText(lastUser);
  const photo = hasMedia(lastUser) && /^log this/i.test(said);
  const food = said.match(/^log\s+(.+)/i)?.[1]?.replace(/\s+(to|for)\s+(breakfast|lunch|dinner|snacks).*$/i, '').trim();
  const meal = said.match(/\b(breakfast|lunch|dinner|snacks)\b/i)?.[1]?.toLowerCase();

  if (last?.role === 'user') {
    if (photo) return { call: { name: 'ask_user', args: { questions: [
      { id: 'cook', question: 'How was the chicken cooked?', options: ['Grilled', 'Fried', 'Baked'], other: true },
      { id: 'rice', question: 'How much rice?', options: ['½ cup', '1 cup', '2 cups'] },
    ] } } };
    if (food) return { call: { name: 'run_query', args: { queries: [{ name: 'foods.search', input: { query: food, limit: 5 } }] } } };
    const mem = said.match(/^remember\s+(.+)/i)?.[1]?.trim();
    if (mem) return { call: { name: 'memory_write', args: { name: mem.slice(0, 40), description: 'Something the user asked me to remember', content: mem } } };
    const q = said.match(/^search\s+(.+)/i)?.[1]?.trim();
    if (q && tools.includes('web_answer')) return { call: { name: 'web_answer', args: { query: q } } };
    return { text: `${hasMedia(last) ? 'Got your attachment. ' : ''}You said: “${said || '…'}”. (Fake model: try “log eggs”, a photo with “log this”, or “remember …”.)` };
  }
  if (last?.role === 'tool') {
    const out = parse(last.content) as Record<string, unknown> | unknown[];
    switch (last.name) {
      case 'ask_user': return { call: { name: 'run_query', args: { queries: [{ name: 'foods.search', input: { query: 'rice cooked', limit: 5 } }, { name: 'foods.search', input: { query: 'chicken breast grilled', limit: 5 } }] } } };
      case 'run_query': {
        const groups = (Array.isArray(out) ? out : []) as { result?: { key: string; name: string }[] }[];
        const items = groups.map((g, i) => {
          const rows = Array.isArray(g.result) ? g.result : [];
          return rows[0] ? { foodKey: rows[0].key, grams: photo ? [180, 150][i] ?? 100 : 100, alternatives: rows.slice(1, 4).map((r) => r.key) } : null;
        }).filter(Boolean);
        if (!items.length) return { text: `I couldn't find “${food}” in the food database.` };
        return { call: { name: 'request_changes', args: { summary: photo ? 'Lunch: rice and chicken' : `Log ${food}`, actions: [{ name: 'entries.logMany', input: { items, ...(meal ? { meal } : {}) } }] } } };
      }
      case 'request_changes': {
        const r = out as { status?: string; comment?: string; error?: string; applied?: { input: { items?: unknown[] } }[] };
        if (r.error) return { text: `That request didn't go through: ${r.error}` };
        if (r.status === 'applied') { const n = (r.applied ?? []).reduce((s, a) => s + (a.input.items?.length ?? 1), 0); return { text: `Logged ✓ (${n} item${n === 1 ? '' : 's'})` }; }
        if (r.status === 'rejected') return { text: r.comment ? `OK, not logged. You said: “${r.comment}”.` : 'OK, not logged.' };
        return { text: `Got it: “${r.comment ?? ''}”. Tell me what to change and I'll ask again.` };
      }
      case 'memory_write': return { text: 'Saved to memory.' };
      case 'web_answer': return { text: `From the web: ${(out as { untrusted_web_content?: { answer?: string } }).untrusted_web_content?.answer ?? '…'}` };
      default: return { text: 'Done.' };
    }
  }
  return { text: 'Hi!' };
}

function title(body: TurnRequest): string {
  const t = body.messages[0]?.role === 'user' ? body.messages[0].content.map((p) => (p.type === 'text' ? p.text : '')).join(' ') : '';
  const said = t.match(/^User[^:]*:\s*(.*)$/m)?.[1] ?? '';
  if (/attachment/.test(t) && /log this/i.test(said)) return 'Lunch photo log';
  const words = said.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 4);
  return words.length ? words.map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ') : 'New chat';
}

export async function* fakeTurn(body: TurnRequest, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  await sleep(250, signal);
  const provider = body.provider ?? 'chatgpt';
  const done: TurnEvent = { type: 'done', provider, model: provider === 'chatgpt' ? 'gpt-6.1-sol' : 'z-ai/glm-5.3-flash', effort: body.effort ?? 'medium' };
  if (!body.tools.length) { yield { type: 'text', delta: title(body) }; yield done; return; }
  const p = plan(body.messages, body.tools.map((t) => t.name));
  if (p.text) {
    for (const w of p.text.split(/(?<= )/)) { if (signal?.aborted) return; await sleep(35, signal); yield { type: 'text', delta: w }; }
  }
  if (p.call) yield { type: 'tool_call', call: { id: `fake_${body.messages.length}`, ...p.call } };
  yield done;
}
