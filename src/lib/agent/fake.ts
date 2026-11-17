// Fake provider for development (localStorage['tapin:fakeAI'] = '1'). A tiny scripted "model" that is a pure
// function of the messages it is given — no hidden state — so reload / Apply / Reject all behave like the real loop.
//   "log eggs" / photo + "log this…" → describe_commands → run_query foods.search → request_changes entries.log
//   "remember X"      → memory_write
//   "search X"        → web_answer
//   anything else     → echoes the text, streamed
import type { AIConfig, AIMessage, AIModel, AIStatus, ProviderId, TurnEvent, TurnRequest } from './types';

const CFG_KEY = 'tapin:fakeAIConfig';
const DEFAULT_CFG: AIConfig = {
  primary: 'chatgpt', fallback: 'openrouter',
  models: { chatgpt: { smart: null, cheap: null }, openrouter: { smart: 'anthropic/claude-sonnet-4.5', cheap: 'google/gemini-2.5-flash' } },
  webModel: 'perplexity/sonar',
};
const readCfg = (): AIConfig => { try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(CFG_KEY) ?? '{}') }; } catch { return DEFAULT_CFG; } };
export function fakeConfig(patch: Partial<AIConfig> = {}): AIConfig {
  const next = { ...readCfg(), ...patch };
  try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}
export const fakeStatus = (): AIStatus => ({ chatgpt: { connected: true, email: 'fake@example.com' }, openrouter: { hasKey: true }, config: readCfg() });
export const fakeModels = (p: ProviderId): AIModel[] => (p === 'chatgpt'
  ? [{ id: 'gpt-5.1', name: 'GPT-5.1' }, { id: 'gpt-5.1-mini', name: 'GPT-5.1 mini' }]
  : [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }, { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }, { id: 'perplexity/sonar', name: 'Perplexity Sonar' }]);
export const fakeWebAnswer = (query: string) => ({ answer: `(fake) A short web answer about “${query}”.`, citations: ['https://example.com/source'] });
export const fakeWebRead = (url: string) => ({ mode: 'raw' as const, content: `(fake) The readable text of ${url}.`, tokens: 12, title: 'Example page' });

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); });

const userText = (m: AIMessage | undefined) => (m?.role === 'user' ? m.content.map((p) => (p.type === 'text' && !p.text.startsWith('<context>') ? p.text : '')).join(' ').trim() : '');
const hasImage = (m: AIMessage | undefined) => m?.role === 'user' && m.content.some((p) => p.type === 'image');
const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

type Plan = { text?: string; call?: { name: string; args: Record<string, unknown> } };

function plan(msgs: AIMessage[], tools: string[]): Plan {
  const last = msgs[msgs.length - 1];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const said = userText(lastUser);
  // a photo with "log this …" is "seen" as eggs (no real vision in fake mode)
  const food = hasImage(lastUser) && /^log this/i.test(said) ? 'eggs' : said.match(/^log\s+(.+)/i)?.[1]?.trim();

  if (last?.role === 'user') {
    if (food) return { call: { name: 'describe_commands', args: { names: ['foods.search', 'entries.log'] } } };
    const mem = said.match(/^remember\s+(.+)/i)?.[1]?.trim();
    if (mem) return { call: { name: 'memory_write', args: { name: mem.slice(0, 40), description: 'Something the user asked me to remember', content: mem } } };
    const q = said.match(/^search\s+(.+)/i)?.[1]?.trim();
    if (q && tools.includes('web_answer')) return { call: { name: 'web_answer', args: { query: q } } };
    return { text: `${hasImage(last) ? 'Nice photo. ' : ''}You said: “${said || '…'}”. (Fake model: try “log eggs” or “remember I train mornings”.)` };
  }
  if (last?.role === 'tool') {
    const out = parse(last.content) as Record<string, unknown> | unknown[];
    switch (last.name) {
      case 'describe_commands': return { call: { name: 'run_query', args: { name: 'foods.search', input: { query: food ?? 'eggs', limit: 5 } } } };
      case 'run_query': {
        const rows = (Array.isArray(out) ? out : ((out as { result?: unknown }).result as unknown[] | undefined)) ?? [];
        const first = rows[0] as { key?: string; name?: string } | undefined;
        if (!first?.key) return { text: `I couldn't find “${food}” in the food database.` };
        return { call: { name: 'request_changes', args: { summary: `Log ${first.name}`, actions: [{ name: 'entries.log', input: { foodKey: first.key, grams: 100, meal: 'breakfast' } }] } } };
      }
      case 'request_changes': {
        const r = out as { status?: string; comment?: string; error?: string };
        if (r.error) return { text: `That request didn't go through: ${r.error}` };
        if (r.status === 'applied') return { text: 'Logged ✓' };
        if (r.status === 'rejected') return { text: r.comment ? `OK, not logged. You said: “${r.comment}”.` : 'OK, not logged.' };
        return { text: `Got it: “${r.comment ?? ''}”. Tell me the amount and I'll ask again.` };
      }
      case 'memory_write': return { text: 'Saved to memory.' };
      case 'web_answer': return { text: `From the web: ${(out as { untrusted_web_content?: { answer?: string } }).untrusted_web_content?.answer ?? '…'}` };
      default: return { text: 'Done.' };
    }
  }
  return { text: 'Hi!' };
}

export async function* fakeTurn(body: TurnRequest, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  await sleep(250, signal);
  const p = plan(body.messages, body.tools.map((t) => t.name));
  if (p.text) {
    for (const w of p.text.split(/(?<= )/)) { if (signal?.aborted) return; await sleep(35, signal); yield { type: 'text', delta: w }; }
  }
  if (p.call) yield { type: 'tool_call', call: { id: `fake_${body.messages.length}`, ...p.call } };
  yield { type: 'done', provider: 'fake', model: 'scripted' };
}
