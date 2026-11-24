// Voice-call routes (contract: docs/agent-contract.md "v4 voice"). Wired from routes.ts after bearer auth.
//   POST /ai/voice/transcribe   raw audio bytes (Content-Type audio/wav | audio/mp4 | audio/webm …, ≤ 10 MB, ≤ 2 min)
//                               → { text } via OpenRouter /audio/transcriptions (multipart, language auto-detected)
//   POST /ai/voice/speak        { text } (≤ 1000 chars) → audio bytes streamed straight through from OpenRouter
//                               /audio/speech. Content-Type: audio/mpeg, or audio/pcm;rate=24000 (16-bit LE mono)
//   GET  /ai/voice/models       → { stt: {id,name}[], tts: {id,name}[] } (admin pickers; public catalog)
//   GET  /ai/voice/voices?model → { voices: string[], formats: string[], instructions: boolean }
// All use the user's own OpenRouter key (409 { code:'no_key' } without one). The chat routing (`openrouterProvider`,
// e.g. river) is never sent: it names chat providers, not speech ones.
import type { Env } from '../index';
import { HttpError, json } from '../http';
import { OPENROUTER, OR_HEADERS } from './openrouter';
import { loadState } from './provider';
import { ProviderError, statusError } from './types';
import type { VoiceConfig } from './voiceConfig';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 125; // 2 min + a little slack for the end-of-speech silence
export const MAX_SPEAK_CHARS = 1000;
/** Gemini TTS returns raw 16-bit little-endian mono PCM at 24 kHz (Google's TTS output format; OpenRouter only says "pcm"). */
export const PCM_RATE = 24000;

const AUDIO_EXT: Record<string, string> = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac' };
export const audioExt = (contentType: string | null) => AUDIO_EXT[(contentType ?? '').split(';')[0].trim().toLowerCase()] ?? null;

/** Duration of a PCM WAV file from its header, or null when it isn't one we can read. */
export function wavSeconds(b: Uint8Array): number | null {
  if (b.length < 44) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12, byteRate = 0;
  while (o + 8 <= b.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 16 <= b.length) byteRate = dv.getUint32(o + 16, true);
    if (id === 'data') return byteRate ? Math.min(size, b.length - o - 8) / byteRate : null;
    o += 8 + size + (size & 1);
  }
  return null;
}

/** Multipart body for /audio/transcriptions. No `language` (auto-detect: the user mixes Hebrew and English) and no
 *  `prompt` (Whisper tends to echo a prompt back on near-silent audio). */
export function transcribeForm(model: string, audio: Uint8Array, ext: string): FormData {
  const f = new FormData();
  f.append('file', new Blob([audio], { type: `audio/${ext === 'm4a' ? 'mp4' : ext}` }), `speech.${ext}`);
  f.append('model', model);
  f.append('response_format', 'json');
  return f;
}

export type SpeechInfo = { voices: string[]; formats: string[]; instructions: boolean };
const infoCache = new Map<string, { at: number; info: SpeechInfo | null }>();
/** What a TTS model takes (public catalog, cached 1 h). null = unknown (catalog unreachable / model not listed). */
export async function speechInfo(model: string, fetcher: typeof fetch = fetch): Promise<SpeechInfo | null> {
  const hit = infoCache.get(model);
  if (hit && Date.now() - hit.at < 3600_000) return hit.info;
  let info: SpeechInfo | null = null;
  try {
    const res = await fetcher(`${OPENROUTER}/audio/speech/models/${model.split('/').map(encodeURIComponent).join('/')}`, { headers: OR_HEADERS, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j = await res.json() as any;
      const d = j?.data ?? j;
      const voices = new Set<string>(), formats = new Set<string>();
      let instructions = false;
      for (const e of d?.endpoints ?? []) for (const o of e?.output_modalities ?? []) {
        const sp = o?.supported_parameters ?? {};
        for (const v of sp.voice?.values ?? []) voices.add(String(v));
        for (const v of sp.response_format?.values ?? []) formats.add(String(v));
        if (sp.instructions) instructions = true;
      }
      info = { voices: [...voices], formats: [...formats], instructions };
    }
  } catch { /* unknown */ }
  infoCache.set(model, { at: Date.now(), info });
  return info;
}

/** mp3 whenever the model offers it (decodes everywhere, smaller); otherwise pcm (Gemini TTS is pcm-only). */
export function pickFormat(model: string, info: SpeechInfo | null): 'mp3' | 'pcm' {
  if (info?.formats.length) return info.formats.includes('mp3') ? 'mp3' : 'pcm';
  return /^google\/gemini/.test(model) ? 'pcm' : 'mp3';
}

export function speechBody(v: VoiceConfig, text: string, info: SpeechInfo | null): Record<string, unknown> {
  const body: Record<string, unknown> = { model: v.ttsModel, input: text, voice: v.ttsVoice, response_format: pickFormat(v.ttsModel, info) };
  if (v.ttsStyle && info?.instructions) body.instructions = v.ttsStyle;
  return body;
}

/** Spoken text clean-up: markdown and emoji never get read out. */
export function speakable(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[*_#`>|~]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ').replace(/\s+/g, ' ').trim();
}

const upstreamError = async (res: Response) => {
  const err = (await res.json().catch(() => ({})) as any)?.error ?? {};
  return statusError('OpenRouter', res.status, String(err.message ?? ''));
};
const providerHttp = (e: ProviderError) => new HttpError(e.code === 'limit' ? 429 : e.code === 'bad_request' ? 400 : 502, e.message, { code: e.code });

type Model = { id: string; name: string };
let catalog: { at: number; stt: Model[]; tts: Model[] } | null = null;
async function voiceModels() {
  if (catalog && Date.now() - catalog.at < 3600_000) return catalog;
  const list = async (mod: string) => {
    const res = await fetch(`${OPENROUTER}/models?output_modalities=${mod}`, { headers: OR_HEADERS, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new HttpError(502, 'Could not load OpenRouter models');
    const j = await res.json() as { data?: { id: string; name?: string }[] };
    return (j.data ?? []).map((m) => ({ id: m.id, name: (m.name || m.id).replace(/^[^:]{1,40}:\s*/, '') }));
  };
  const [stt, tts] = await Promise.all([list('transcription'), list('speech')]);
  catalog = { at: Date.now(), stt, tts };
  return catalog;
}

export async function handleVoice(req: Request, env: Env, userId: string, p: string, url: URL): Promise<Response | null> {
  if (!p.startsWith('/ai/voice/')) return null;

  if (req.method === 'GET' && p === '/ai/voice/models') { const c = await voiceModels(); return json({ stt: c.stt, tts: c.tts }); }
  if (req.method === 'GET' && p === '/ai/voice/voices') {
    const model = url.searchParams.get('model') ?? '';
    if (!model || model.length > 200) throw new HttpError(400, 'model is required');
    const info = await speechInfo(model);
    return json(info ?? { voices: [], formats: [], instructions: false });
  }

  if (req.method === 'POST' && p === '/ai/voice/transcribe') {
    const ext = audioExt(req.headers.get('Content-Type'));
    if (!ext) throw new HttpError(415, 'Send audio as wav, m4a/mp4, webm, ogg, mp3 or flac');
    if (Number(req.headers.get('Content-Length') ?? 0) > MAX_AUDIO_BYTES) throw new HttpError(413, 'That recording is too long (2 minutes max)');
    const audio = new Uint8Array(await req.arrayBuffer());
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new HttpError(413, 'That recording is too long (2 minutes max)');
    if (audio.byteLength < 200) throw new HttpError(400, 'No audio');
    const secs = ext === 'wav' ? wavSeconds(audio) : null;
    if (secs !== null && secs > MAX_AUDIO_SECONDS) throw new HttpError(413, 'That recording is too long (2 minutes max)');
    const s = await loadState(env, userId);
    if (!s.orKey) throw new HttpError(409, 'Voice calls need an OpenRouter key (Settings → Agent)', { code: 'no_key' });
    let res: Response;
    try {
      res = await fetch(`${OPENROUTER}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${s.orKey}`, ...OR_HEADERS },
        body: transcribeForm(s.global.voice.sttModel, audio, ext), signal: AbortSignal.timeout(60_000) });
    } catch { throw new HttpError(502, 'Could not reach OpenRouter', { code: 'provider' }); }
    if (!res.ok) throw providerHttp(await upstreamError(res));
    const j = await res.json().catch(() => ({})) as { text?: unknown };
    return json({ text: typeof j.text === 'string' ? j.text.trim() : '' });
  }

  if (req.method === 'POST' && p === '/ai/voice/speak') {
    let b: { text?: unknown };
    try { b = await req.json() as { text?: unknown }; } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (typeof b?.text !== 'string') throw new HttpError(400, 'text is required');
    if (b.text.length > MAX_SPEAK_CHARS) throw new HttpError(400, `text is limited to ${MAX_SPEAK_CHARS} characters per call`);
    const text = speakable(b.text);
    if (!text) throw new HttpError(400, 'Nothing to say');
    const s = await loadState(env, userId);
    if (!s.orKey) throw new HttpError(409, 'Voice calls need an OpenRouter key (Settings → Agent)', { code: 'no_key' });
    const info = await speechInfo(s.global.voice.ttsModel);
    const body = speechBody(s.global.voice, text, info);
    let res: Response;
    try {
      res = await fetch(`${OPENROUTER}/audio/speech`, { method: 'POST', headers: { Authorization: `Bearer ${s.orKey}`, 'Content-Type': 'application/json', ...OR_HEADERS },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch { throw new HttpError(502, 'Could not reach OpenRouter', { code: 'provider' }); }
    if (!res.ok || !res.body) throw providerHttp(res.ok ? new ProviderError('provider', 'OpenRouter sent no audio', true) : await upstreamError(res));
    // streamed straight through: the client can start decoding as soon as the request finishes, the Worker holds nothing
    const type = body.response_format === 'pcm' ? `audio/pcm;rate=${PCM_RATE}` : 'audio/mpeg';
    return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  }

  throw new HttpError(404, 'Not found');
}
