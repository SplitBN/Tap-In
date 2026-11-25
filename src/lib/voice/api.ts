// Client for /ai/voice/* (contract v4). Fake mode (localStorage['tapin:fakeAI']): no network — transcribe returns
// canned text, speak returns { kind:'synth' } (the browser's speechSynthesis), or a generated PCM tone when
// localStorage['tapin:fakeVoicePcm'] is set, so the real decode-and-queue path can be exercised without credentials.
import { AIError, isFake } from '../agent/client';
import { apiAuth } from '../sync';

/** speed: time-stretch to apply on playback (pitch kept), from the server's X-Tapin-Speed (the model had no speed
 *  parameter); 1 or missing = play as is. */
export type SpokenAudio =
  | { kind: 'pcm'; rate: number; data: ArrayBuffer; speed?: number; ms?: SpeakMs }
  | { kind: 'encoded'; data: ArrayBuffer; speed?: number; ms?: SpeakMs }
  | { kind: 'synth'; text: string; ms?: SpeakMs };
/** /speak timing: response headers vs whole body (ms from the request). head ≪ body would mean audio streams early. */
export type SpeakMs = { head: number; body: number };

async function authed() {
  const a = await apiAuth();
  if (!a) throw new AIError('Sign in first: Settings → Back up & sync.', 401, 'signed_out');
  return a;
}
async function fail(res: Response): Promise<never> {
  const b = await res.json().catch(() => ({})) as { error?: string; code?: string };
  throw new AIError(b.error ?? `HTTP ${res.status}`, res.status, b.code);
}

const CANNED = ['How did my training go this week?', 'Log two eggs and toast for breakfast.', 'What should I eat for dinner to hit my protein?'];
let cannedI = 0;
/** Fake mode with segments: one canned sentence per utterance (`part.utt`), all of it on segment 0, '' on later ones,
 *  so a call in fake mode still sends whole sentences. */
const fakeUtt = new Map<number, string>();
function fakeText(part?: { utt: number; index: number }) {
  if (!part) return CANNED[cannedI++ % CANNED.length];
  if (part.index > 0) return '';
  if (!fakeUtt.has(part.utt)) fakeUtt.set(part.utt, CANNED[cannedI++ % CANNED.length]);
  return fakeUtt.get(part.utt)!;
}

/** Speech → text (language auto-detected). '' when nothing was understood. `part` only matters in fake mode. */
export async function transcribe(audio: Blob, signal?: AbortSignal, part?: { utt: number; index: number }): Promise<string> {
  if (isFake()) {
    await new Promise<void>((r, j) => { const t = setTimeout(r, 350); signal?.addEventListener('abort', () => { clearTimeout(t); j(new DOMException('aborted', 'AbortError')); }); });
    return fakeText(part);
  }
  const a = await authed();
  let res: Response;
  try {
    res = await fetch(`${a.api}/ai/voice/transcribe`, { method: 'POST', signal, headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': audio.type || 'audio/wav' }, body: audio });
  } catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new AIError('Could not reach the server. Check your connection.', 0, 'network'); }
  if (!res.ok) await fail(res);
  return ((await res.json()) as { text?: string }).text?.trim() ?? '';
}

/** One chunk of the reply → audio. With `hedgeMs`, a second identical request goes out if the first hasn't answered by
 *  then, and whichever finishes first wins (the other is aborted). Used for the first chunk of a reply only: TTS p50 is
 *  ~0.9 s but p90 ~2.9 s, and the first chunk is what the user waits on; it costs a duplicate of a ~40-char request. */
export function speakFast(text: string, signal: AbortSignal, hedgeMs: number): Promise<SpokenAudio> {
  if (isFake()) return speak(text, signal);
  const ctrls: AbortController[] = [];
  const onAbort = () => ctrls.forEach((c) => c.abort());
  signal.addEventListener('abort', onAbort);
  return new Promise<SpokenAudio>((resolve, reject) => {
    let settled = false, running = 0, timer = 0;
    const launch = () => {
      const c = new AbortController(); ctrls.push(c); running++;
      speak(text, c.signal).then((r) => {
        if (settled) return;
        settled = true; clearTimeout(timer); ctrls.forEach((x) => x !== c && x.abort()); resolve(r);
      }, (e) => {
        running--;
        if (settled) return;
        if (ctrls.length < 2 && !signal.aborted && (e as Error).name !== 'AbortError') { clearTimeout(timer); launch(); return; } // failed fast: one retry
        if (running === 0) { settled = true; clearTimeout(timer); reject(e); }
      });
    };
    launch();
    timer = window.setTimeout(() => { if (!settled && ctrls.length < 2) launch(); }, hedgeMs);
  }).finally(() => signal.removeEventListener('abort', onAbort));
}

/** One chunk of the reply → audio. */
export async function speak(text: string, signal?: AbortSignal): Promise<SpokenAudio> {
  if (isFake()) {
    let pcm = false;
    try { pcm = !!localStorage.getItem('tapin:fakeVoicePcm'); } catch { /* ignore */ }
    if (!pcm && 'speechSynthesis' in window) return { kind: 'synth', text };
    await new Promise((r) => setTimeout(r, 250));
    return { kind: 'pcm', rate: 24000, data: tone(Math.min(4, 0.4 + text.length * 0.045), 24000), speed: 1.12 }; // exercises the time-stretch path
  }
  const a = await authed();
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${a.api}/ai/voice/speak`, { method: 'POST', signal, headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 1000) }) });
  } catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new AIError('Could not reach the server. Check your connection.', 0, 'network'); }
  if (!res.ok) await fail(res);
  const type = res.headers.get('Content-Type') ?? '';
  const head = Math.round(performance.now() - t0);
  const data = await res.arrayBuffer();
  const ms = { head, body: Math.round(performance.now() - t0) };
  const pcm = type.match(/^audio\/pcm(?:;\s*rate=(\d+))?/i);
  const sp = Number(res.headers.get('X-Tapin-Speed'));
  const speed = sp > 0.5 && sp < 2 ? sp : 1;
  return pcm ? { kind: 'pcm', rate: Number(pcm[1]) || 24000, data, speed, ms } : { kind: 'encoded', data, speed, ms };
}

/** Admin pickers. */
export async function voiceModels(): Promise<{ stt: { id: string; name: string }[]; tts: { id: string; name: string }[] }> {
  if (isFake()) return { stt: [{ id: 'openai/gpt-transcribe', name: 'GPT Transcribe' }, { id: 'openai/whisper-large-v3-turbo', name: 'Whisper Large V3 Turbo' }, { id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' }],
    tts: [{ id: 'elevenlabs/eleven-v4-turbo', name: 'Eleven v4 Turbo' }, { id: 'google/gemini-3.8-flash-tts', name: 'Gemini 3.8 Flash TTS' }] };
  const a = await authed();
  const res = await fetch(`${a.api}/ai/voice/models`, { headers: { Authorization: `Bearer ${a.token}` } });
  if (!res.ok) await fail(res);
  return res.json();
}
export async function voiceVoices(model: string): Promise<{ voices: string[]; formats: string[]; instructions: boolean; speed?: { min: number; max: number } | null }> {
  if (isFake()) return model.includes('gemini') ? { voices: ['Kore', 'Puck', 'Sulafat', 'Achird'], formats: ['pcm'], instructions: true, speed: null }
    : { voices: ['chris', 'eric', 'roger', 'brian', 'george', 'sarah', 'jessica', 'river'], formats: ['mp3', 'pcm'], instructions: false, speed: null };
  const a = await authed();
  const res = await fetch(`${a.api}/ai/voice/voices?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${a.token}` } });
  if (!res.ok) await fail(res);
  return res.json();
}

/** A soft two-note hum as 16-bit PCM (fake mode). */
function tone(secs: number, rate: number): ArrayBuffer {
  const n = Math.round(secs * rate), dv = new DataView(new ArrayBuffer(n * 2));
  for (let i = 0; i < n; i++) {
    const t = i / rate, env = Math.min(1, t * 20, (secs - t) * 20);
    const f = 220 + 40 * Math.sin(t * 3);
    dv.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * f * t) * env * 0.18 * 0x7fff), true);
  }
  return dv.buffer;
}
