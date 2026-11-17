// Offline self-test for the pure parts of src/ai (no network, no Workers runtime).
// Run: npm run test:ai   (bundles with esbuild, runs in Node)
import { parseResponsesStream, toInput } from '../src/ai/chatgpt';
import { decrypt, encrypt } from '../src/ai/crypto';
import { parseChatStream, toChat } from '../src/ai/openrouter';
import { DEFAULT_CONFIG, mergeConfig, runTurn } from '../src/ai/provider';
import { ProviderError, type Provider, type TurnEvent } from '../src/ai/types';
import { checkUrl, htmlToText } from '../src/ai/web';

let fails = 0;
const ok = (cond: unknown, name: string) => { if (!cond) { fails++; console.log('FAIL', name); } else console.log('ok  ', name); };
const stream = (s: string, split = 7) => new ReadableStream<Uint8Array>({ start(c) { const b = new TextEncoder().encode(s); for (let i = 0; i < b.length; i += split) c.enqueue(b.subarray(i, i + split)); c.close(); } });
const collect = async (g: AsyncGenerator<TurnEvent>) => { const out: TurnEvent[] = []; for await (const e of g) out.push(e); return out; };

// ---- SSRF guard ----
const blocked = (u: string) => { try { checkUrl(u); return false; } catch { return true; } };
for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://0x7f.1/', 'http://2130706433/', 'http://10.1.2.3/', 'http://169.254.169.254/latest', 'http://192.168.0.1/',
  'http://172.20.0.1/', 'http://100.64.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://example.com:8080/',
  'ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://intranet/', 'http://foo.localhost/', 'http://0.0.0.0/', 'http://[::]/'])
  ok(blocked(u), `blocks ${u}`);
for (const u of ['https://example.com/a?b=1', 'http://example.com:80/', 'https://en.wikipedia.org/wiki/Creatine', 'http://8.8.8.8/', 'http://[2606:4700::1111]/'])
  ok(!blocked(u), `allows ${u}`);

// ---- HTML → text ----
const html = `<!doctype html><html><head><title>Creatine &amp; you</title><style>p{}</style><script>alert(1)</script></head><body>
<nav><a href="/home">Home</a> menu</nav><header><h1>Creatine</h1></header>
<main><h2>Dosing</h2><p>Take <b>3&ndash;5 g</b> daily.&nbsp;See <a href="/study?id=1">the study</a>.</p>
<ul><li>Loading: optional</li><li>Timing: any</li></ul><table><tr><td>Form</td><td>Monohydrate</td></tr></table>
<p>${'Filler sentence for length. '.repeat(10)}</p><script>bad()</script></main>
<footer>© 2026 Footer stuff</footer></body></html>`;
const t = htmlToText(html, 'https://ex.com/page');
ok(t.title === 'Creatine & you', 'title decoded');
ok(t.text.includes('## Dosing') && t.text.includes('3–5 g daily'), 'heading + entities');
ok(t.text.includes('- Loading: optional'), 'list items');
ok(t.text.includes('the study (https://ex.com/study?id=1)'), 'links resolved');
ok(!/alert|bad\(\)|Footer|menu|p\{\}/.test(t.text), 'drops script/style/nav/footer');
console.log('---\n' + t.text.slice(0, 300) + '\n---');

// ---- Responses stream ----
const resp = [
  { type: 'response.created', response: {} },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] } },
  { type: 'response.output_text.delta', delta: 'Hel' }, { type: 'response.output_text.delta', delta: 'lo' },
  { type: 'response.function_call_arguments.delta', delta: '{"na' },
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'tapin.run_query', arguments: '{"name":"food.search","input":{"q":"egg"}}' } },
  { type: 'response.completed', response: { model: 'gpt-x', usage: { input_tokens: 10, output_tokens: 5 } } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const ev = await collect(parseResponsesStream(stream(resp), 'gpt-x', new Set(['run_query'])));
ok(ev.filter((e) => e.type === 'text').map((e: any) => e.delta).join('') === 'Hello', 'responses text');
const tc = ev.find((e) => e.type === 'tool_call') as any;
ok(tc?.call.name === 'run_query' && tc.call.args.name === 'food.search' && tc.call.id === 'call_1', 'responses tool_call (namespace stripped)');
const done = ev.at(-1) as any;
ok(done.type === 'done' && done.usage.input === 10 && done.opaque.items[0].encrypted_content === 'ENC', 'responses done + opaque');
const failed = `data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })}\n\n`;
try { await collect(parseResponsesStream(stream(failed), 'm', new Set())); ok(false, 'failed throws'); } catch (e) { ok(e instanceof ProviderError && e.code === 'limit' && e.fallback, 'response.failed → limit'); }
const input = toInput([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', mime: 'image/jpeg', base64: 'AAA' }] },
  { role: 'assistant', text: 'x', toolCalls: [{ id: 'c1', name: 'run_query', args: {} }], opaque: done.opaque },
  { role: 'assistant', text: 'y', opaque: { provider: 'openrouter', items: [{ bad: 1 }] } },
  { role: 'tool', toolCallId: 'c1', name: 'run_query', content: '{}' }]) as any[];
ok(input[1].type === 'reasoning' && input[3].type === 'function_call' && input[4].type === 'message' && input[5].type === 'function_call_output', 'toInput order + foreign opaque dropped');
ok(input[0].content[1].image_url === 'data:image/jpeg;base64,AAA', 'toInput image');

// ---- OpenRouter stream ----
const chunks = [
  ': OPENROUTER PROCESSING',
  JSON.stringify({ model: 'anthropic/claude-haiku-5.5', choices: [{ delta: { content: 'Hi ' } }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_a', function: { name: 'run_query', arguments: '{"name":' } }] } }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'tc_b', function: { name: 'memory_read', arguments: '' } }] } }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }, { index: 1, function: { arguments: '{"id":"m1"}' } }] } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  '[DONE]',
].map((c) => c.startsWith(':') ? `${c}\n\n` : `data: ${c}\n\n`).join('');
const oev = await collect(parseChatStream(stream(chunks, 5), 'm'));
const calls = oev.filter((e) => e.type === 'tool_call') as any[];
ok(calls.length === 2 && calls[0].call.args.name === 'x' && calls[1].call.args.id === 'm1' && calls[0].call.id === 'tc_a', 'openrouter buffered tool calls');
const odone = oev.at(-1) as any;
ok(odone.type === 'done' && odone.usage.output === 3 && odone.model === 'anthropic/claude-haiku-5.5', 'openrouter done + usage');
const oerr = `data: ${JSON.stringify({ error: { code: 429, message: 'rate' } })}\n\n`;
try { await collect(parseChatStream(stream(oerr), 'm')); ok(false, 'or error throws'); } catch (e) { ok(e instanceof ProviderError && e.code === 'limit', 'openrouter in-stream error'); }
const chat = toChat('sys', [{ role: 'assistant', toolCalls: [{ id: 'a', name: 'n', args: { q: 1 } }] }, { role: 'tool', toolCallId: 'a', name: 'n', content: '1' }]) as any[];
ok(chat[0].role === 'system' && chat[1].tool_calls[0].function.arguments === '{"q":1}' && chat[1].content === null && chat[2].tool_call_id === 'a', 'toChat');

// ---- fallback ----
const failing = (code: 'auth' | 'bad_request'): Provider => ({ id: 'chatgpt', model: async () => 'm', async *turn() { throw new ProviderError(code, 'nope', code === 'auth'); } });
const good: Provider = { id: 'openrouter', model: async () => 'm2', async *turn() { yield { type: 'text', delta: 'ok' }; yield { type: 'done', provider: 'openrouter', model: 'm2' }; } };
const fb = await collect(runTurn([failing('auth'), good], { instructions: '', messages: [], tools: [], tier: 'smart' }));
ok(fb[0].type === 'text' && (fb[1] as any).provider === 'openrouter', 'falls back on auth');
const nofb = await collect(runTurn([failing('bad_request'), good], { instructions: '', messages: [], tools: [], tier: 'smart' }));
ok(nofb.length === 1 && nofb[0].type === 'error' && (nofb[0] as any).code === 'bad_request', 'no fallback on bad_request');
const none = await collect(runTurn([], { instructions: '', messages: [], tools: [], tier: 'smart' }));
ok((none[0] as any).code === 'no_provider', 'no_provider');

// ---- config + crypto ----
const c = mergeConfig(DEFAULT_CONFIG, { primary: 'openrouter', fallback: 'openrouter', models: { chatgpt: { cheap: 'gpt-mini' }, openrouter: { smart: '' } }, webModel: 5, junk: 1 });
ok(c.primary === 'openrouter' && c.fallback === null && mergeConfig(DEFAULT_CONFIG, { primary: 'openrouter' }).fallback === 'chatgpt' && c.models.chatgpt.cheap === 'gpt-mini' && c.models.chatgpt.smart === null && c.models.openrouter.smart === DEFAULT_CONFIG.models.openrouter.smart && c.webModel === 'perplexity/sonar', 'mergeConfig');
const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const sealed = await encrypt(key, 'sk-or-secret');
ok(sealed !== 'sk-or-secret' && (await decrypt(key, sealed)) === 'sk-or-secret', 'crypto round trip');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
