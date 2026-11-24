// Offline self-test for the pure parts of src/ai (no network, no Workers runtime).
// Run: npm run test:ai   (bundles with esbuild, runs in Node)
import { chatgptProvider, parseResponsesStream, toInput } from '../src/ai/chatgpt';
import { decrypt, encrypt } from '../src/ai/crypto';
import { openrouterProvider, parseChatStream, toChat } from '../src/ai/openrouter';
import { DEFAULT_CONFIG, DEFAULT_GLOBAL, mergeConfig, mergeGlobal, prettyModel, runTurn } from '../src/ai/provider';
import { ProviderError, type Provider, type TurnEvent } from '../src/ai/types';
import { ACADEMIC_PREFIX, checkUrl, htmlToText, webAnswerBody } from '../src/ai/web';
import { HttpError } from '../src/http';
import { audioExt, handleVoice, pickFormat, speakable, wavSeconds } from '../src/ai/voice';
import { DEFAULT_VOICE } from '../src/ai/voiceConfig';

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
const fb = await collect(runTurn([failing('auth'), good], { instructions: '', messages: [], tools: [], effort: 'medium' }));
ok(fb[0].type === 'text' && (fb[1] as any).provider === 'openrouter' && (fb[1] as any).effort === 'medium', 'falls back on auth, done carries effort');
const nofb = await collect(runTurn([failing('bad_request'), good], { instructions: '', messages: [], tools: [], effort: 'medium' }));
ok(nofb.length === 1 && nofb[0].type === 'error' && (nofb[0] as any).code === 'bad_request', 'no fallback on bad_request');
const none = await collect(runTurn([], { instructions: '', messages: [], tools: [], effort: 'medium' }));
ok((none[0] as any).code === 'no_provider', 'no_provider');

// ---- config + crypto ----
const c = mergeConfig(DEFAULT_CONFIG, { primary: 'openrouter', fallback: 'openrouter', models: { x: 1 }, junk: 1 });
ok(c.primary === 'openrouter' && c.fallback === null && mergeConfig(DEFAULT_CONFIG, { primary: 'openrouter' }).fallback === 'chatgpt' && Object.keys(c).length === 2, 'mergeConfig');
const g = mergeGlobal(DEFAULT_GLOBAL, { models: { openrouter: 'anthropic/claude-haiku-5.5', chatgpt: '' }, defaultEffort: 'high', helperEffort: 'max', openrouterProvider: { order: ['river', 5] }, webModel: null });
ok(g.models.openrouter === 'anthropic/claude-haiku-5.5' && g.models.chatgpt === 'gpt-6.1-sol' && g.defaultEffort === 'high' && g.titleEffort === 'low' && g.extractEffort === 'auto'
  && g.openrouterProvider?.order.join() === 'river' && g.openrouterProvider.allow_fallbacks === true && g.webModel === 'perplexity/sonar', 'mergeGlobal');
ok(DEFAULT_GLOBAL.defaultEffort === 'auto' && DEFAULT_GLOBAL.titleEffort === 'low' && DEFAULT_GLOBAL.extractEffort === 'auto', 'v3 effort defaults');
const old = mergeGlobal(DEFAULT_GLOBAL, { helperEffort: 'medium' });
ok(old.titleEffort === 'medium' && old.extractEffort === 'medium' && !('helperEffort' in old), 'old helperEffort → title + extract');
const nw = mergeGlobal(DEFAULT_GLOBAL, { helperEffort: 'medium', titleEffort: 'high', extractEffort: 'auto', defaultEffort: 'auto' });
ok(nw.titleEffort === 'high' && nw.extractEffort === 'auto' && nw.defaultEffort === 'auto', 'new effort fields win over helperEffort');
ok(mergeGlobal(DEFAULT_GLOBAL, { openrouterProvider: null }).openrouterProvider === null && mergeGlobal(DEFAULT_GLOBAL, { openrouterProvider: { order: [] } }).openrouterProvider === null, 'mergeGlobal routing off');
ok(prettyModel('gpt-6.1-sol') === 'GPT-6.1 Sol' && prettyModel('z-ai/glm-5.3-flash') === 'GLM 5.3 Flash', 'prettyModel');

// ---- attachments ----
const att = [{ role: 'user' as const, content: [{ type: 'file' as const, mime: 'application/pdf', name: 'a.pdf', base64: 'UERG' }] }];
const gi = toInput(att) as any[];
ok(gi[0].content[0].type === 'input_file' && gi[0].content[0].filename === 'a.pdf' && gi[0].content[0].file_data === 'data:application/pdf;base64,UERG', 'chatgpt input_file');
try { toInput([{ role: 'user', content: [{ type: 'video', mime: 'video/mp4', base64: 'AAA' }] }]); ok(false, 'chatgpt video rejected'); }
catch (e) { ok(e instanceof ProviderError && e.code === 'bad_request', 'chatgpt video → bad_request'); }
const oc = toChat('', [...att, { role: 'user', content: [{ type: 'video', mime: 'video/mp4', base64: 'AAA' }] }]) as any[];
ok(oc[0].content[0].type === 'file' && oc[0].content[0].file.file_data.startsWith('data:application/pdf') && oc[1].content[0].type === 'video_url' && oc[1].content[0].video_url.url === 'data:video/mp4;base64,AAA', 'openrouter file + video parts');
const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const sealed = await encrypt(key, 'sk-or-secret');
ok(sealed !== 'sk-or-secret' && (await decrypt(key, sealed)) === 'sk-or-secret', 'crypto round trip');

// ---- request bodies (fetch stubbed) ----
const sent: { url: string; body: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  sent.push({ url, body: JSON.parse(String(init.body)) });
  const sse = url.includes('openrouter')
    ? `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    : `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`;
  return new Response(stream(sse), { status: 200 });
}) as typeof fetch;
const fakeEnv = { AI_AUTH: { idFromName: () => 'id', get: () => ({ models: async () => ({ ok: true, models: [{ id: 'gpt-x', name: 'GPT X' }] }), access: async () => ({ ok: true, token: 't' }) }) } } as any;
const gptP = chatgptProvider(fakeEnv, 'u', DEFAULT_GLOBAL);
const gm = await gptP.model();
ok(gm === 'gpt-x', 'chatgpt model falls back to first listed when gpt-6.1-sol is missing');
const req = { instructions: 'i', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], tools: [], effort: 'high' as const };
await collect(gptP.turn(req, gm));
ok(sent[0].body.reasoning?.effort === 'high' && sent[0].body.store === false && sent[0].body.model === 'gpt-x', 'chatgpt body: reasoning effort');
await collect(openrouterProvider('k', DEFAULT_GLOBAL).turn({ ...req, effort: 'low' }, DEFAULT_GLOBAL.models.openrouter));
const ob = sent[1].body;
ok(ob.reasoning?.effort === 'low' && ob.provider?.order?.[0] === 'river' && ob.provider.allow_fallbacks === true && ob.model === 'z-ai/glm-5.3-flash', 'openrouter body: reasoning + provider routing');
await collect(openrouterProvider('k', { ...DEFAULT_GLOBAL, openrouterProvider: null }).turn(req, 'm'));
ok(!('provider' in sent[2].body), 'openrouter body: no routing when off');
await collect(openrouterProvider('k', DEFAULT_GLOBAL).turn({ ...req, effort: 'auto' }, 'm'));
await collect(gptP.turn({ ...req, effort: 'auto' }, gm));
ok(!('reasoning' in sent[3].body) && !('reasoning' in sent[4].body), 'effort auto → no reasoning param (both)');
globalThis.fetch = realFetch;

// ---- voice (fetch + D1 stubbed): request shapes for /ai/voice/transcribe and /ai/voice/speak ----
{
  const v0 = mergeGlobal(DEFAULT_GLOBAL, {}).voice;
  ok(v0.sttModel === DEFAULT_VOICE.sttModel && v0.ttsModel === DEFAULT_VOICE.ttsModel && v0.ttsVoice === DEFAULT_VOICE.ttsVoice, 'voice defaults in global');
  const v1 = mergeGlobal(DEFAULT_GLOBAL, { voice: { ttsModel: 'google/gemini-3.8-flash-tts', ttsVoice: 'Kore', sttModel: '', junk: 1 } }).voice;
  ok(v1.ttsModel === 'google/gemini-3.8-flash-tts' && v1.ttsVoice === 'Kore' && v1.sttModel === DEFAULT_VOICE.sttModel && !('junk' in v1), 'mergeVoice');
  ok(mergeGlobal(mergeGlobal(DEFAULT_GLOBAL, { voice: { ttsVoice: 'x' } }), { webModel: 'y' }).voice.ttsVoice === 'x', 'voice survives other global patches');
  // a 1 s, 16 kHz mono 16-bit WAV
  const wav = (secs: number) => { const n = Math.round(16000 * secs), b = new Uint8Array(44 + n * 2), dv = new DataView(b.buffer);
    const w = (o: number, s: string) => [...s].forEach((ch, i) => (b[o + i] = ch.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true); return b; };
  ok(Math.abs(wavSeconds(wav(1))! - 1) < 0.001 && wavSeconds(new Uint8Array(50)) === null, 'wavSeconds');
  ok(audioExt('audio/wav') === 'wav' && audioExt('audio/mp4; codecs=mp4a') === 'm4a' && audioExt('text/plain') === null, 'audioExt');
  ok(pickFormat('elevenlabs/eleven-v4-turbo', { voices: [], formats: ['mp3', 'pcm'], instructions: false }) === 'mp3' && pickFormat('google/gemini-3.8-flash-tts', { voices: [], formats: ['pcm'], instructions: true }) === 'pcm'
    && pickFormat('google/gemini-3.8-flash-tts', null) === 'pcm' && pickFormat('x/y', null) === 'mp3', 'pickFormat');
  ok(speakable('**Done!** I logged it 🍳. See https://x.y/z\n| a | b |') === 'Done! I logged it . See a b', 'speakable strips markdown/emoji/urls');

  const encKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const orSealed = await encrypt(encKey, 'sk-or-user');
  const vEnv = (hasKey: boolean, voice?: object) => ({ AI_ENC_KEY: encKey, DB: {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => [{ results: hasKey ? [{ config: '{}', openrouter_key: orSealed }] : [] }, { results: [] }, { results: voice ? [{ config: JSON.stringify({ voice }) }] : [] }],
  } }) as any;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/audio/speech/models/')) return Response.json({ data: { endpoints: [{ output_modalities: [{ type: 'speech', supported_parameters: url.includes('gemini')
      ? { voice: { type: 'enum', values: ['Kore'] }, response_format: { type: 'enum', values: ['pcm'] }, instructions: { type: 'unknown' } }
      : { voice: { type: 'enum', values: ['sarah'] }, response_format: { type: 'enum', values: ['mp3', 'pcm'] } } }] }] } });
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: ' log two eggs ', usage: { seconds: 1 } });
    if (url.endsWith('/audio/speech')) return new Response(stream('ID3fakeaudio'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const call = async (path: string, init: RequestInit, env = vEnv(true)) => {
    try { return await handleVoice(new Request(`https://w.test${path}`, init), env, 'u1', path.split('?')[0], new URL(`https://w.test${path}`)); }
    catch (e) { return e as HttpError; }
  };
  const tr = await call('/ai/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(1) }) as Response;
  const trCall = calls.find((c) => c.url.endsWith('/audio/transcriptions'))!;
  const form = trCall.init!.body as FormData;
  const file = form.get('file') as File;
  ok(tr.status === 200 && (await tr.json() as any).text === 'log two eggs', 'transcribe → trimmed text');
  ok((trCall.init!.headers as any).Authorization === 'Bearer sk-or-user' && form.get('model') === DEFAULT_VOICE.sttModel && file.name === 'speech.wav' && file.size === wav(1).length
    && form.get('language') === null && form.get('prompt') === null, 'transcribe body: multipart file + model, no language/prompt');
  const long = await call('/ai/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(130) });
  ok(long instanceof HttpError && long.status === 413, 'transcribe rejects > 2 min');
  const bad = await call('/ai/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' });
  ok(bad instanceof HttpError && bad.status === 415, 'transcribe rejects non-audio');
  const nokey = await call('/ai/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(1) }, vEnv(false));
  ok(nokey instanceof HttpError && nokey.status === 409 && nokey.extra?.code === 'no_key', 'transcribe without key → 409 no_key');

  calls.length = 0;
  const sp = await call('/ai/voice/speak', { method: 'POST', body: JSON.stringify({ text: '**Logged** two eggs.' }) }) as Response;
  const spCall = calls.find((c) => c.url.endsWith('/audio/speech'))!;
  const spBody = JSON.parse(String(spCall.init!.body));
  ok(sp.status === 200 && sp.headers.get('Content-Type') === 'audio/mpeg' && (await sp.text()) === 'ID3fakeaudio', 'speak streams audio back (mp3)');
  ok(spBody.model === DEFAULT_VOICE.ttsModel && spBody.voice === 'sarah' && spBody.input === 'Logged two eggs.' && spBody.response_format === 'mp3' && !('instructions' in spBody) && !('provider' in spBody),
    'speak body: model/voice/clean input/mp3, no routing, no instructions for eleven');
  calls.length = 0;
  const gsp = await call('/ai/voice/speak', { method: 'POST', body: JSON.stringify({ text: 'Hi there.' }) }, vEnv(true, { ttsModel: 'google/gemini-3.8-flash-tts', ttsVoice: 'Kore' })) as Response;
  const gBody = JSON.parse(String(calls.find((c) => c.url.endsWith('/audio/speech'))!.init!.body));
  ok(gsp.headers.get('Content-Type') === 'audio/pcm;rate=24000' && gBody.response_format === 'pcm' && gBody.voice === 'Kore' && typeof gBody.instructions === 'string', 'speak gemini: pcm + style instructions');
  const tooLong = await call('/ai/voice/speak', { method: 'POST', body: JSON.stringify({ text: 'a'.repeat(1001) }) });
  ok(tooLong instanceof HttpError && tooLong.status === 400, 'speak rejects > 1000 chars');
  const empty = await call('/ai/voice/speak', { method: 'POST', body: JSON.stringify({ text: '** 🍳 **' }) });
  ok(empty instanceof HttpError && empty.status === 400, 'speak rejects nothing-to-say');
  globalThis.fetch = realFetch;
}

// ---- web_answer request body (academic mode) ----
{
  const plain = webAnswerBody('perplexity/sonar', 'creatine loading') as any;
  ok(plain.messages[0].content === 'creatine loading' && plain.search_mode === undefined && plain.web_search_options === undefined, 'web_answer plain body unchanged');
  const ac = webAnswerBody('perplexity/sonar', 'creatine loading', true) as any;
  ok(ac.messages.length === 1 && ac.messages[0].role === 'user' && ac.messages[0].content === ACADEMIC_PREFIX + 'creatine loading', 'academic restriction rides in the user message');
  ok(ac.search_mode === 'academic' && ac.web_search_options?.search_context_size === 'high', 'academic sends search_mode + context size');
  const retry = webAnswerBody('perplexity/sonar', 'q', true, false) as any;
  ok(retry.search_mode === undefined && retry.web_search_options === undefined && retry.messages[0].content.startsWith(ACADEMIC_PREFIX), 'academic retry drops extras, keeps prompt');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
