// Voice-call model config (part of AIGlobal, admin-only). No imports from provider.ts: provider.ts imports this
// file to build DEFAULT_GLOBAL, so it must stay dependency-free (no import cycle at module init).

export type VoiceConfig = {
  sttModel: string; // OpenRouter /audio/transcriptions model
  ttsModel: string; // OpenRouter /audio/speech model
  ttsVoice: string; // a voice id the TTS model lists
  ttsStyle: string; // delivery instructions, only sent to models that take `instructions` (Gemini TTS, gpt-4o-mini-tts, Fish)
};

// Picked 2026-11-24 from OpenRouter's live catalog (see docs/agent-contract.md "v4 voice"):
// - STT gpt-transcribe: one endpoint (OpenAI), measured p50 0.72 s / p90 1.0 s, $75 / M audio-seconds ≈ $0.0045 per
//   minute, multilingual with auto-detect (Hebrew expected, not verified on a page). Whisper turbo is cheaper but
//   OpenRouter price-routes it mostly to DeepInfra (p50 2.4 s, p90 7.6 s) and transcription routing can't be pinned.
// - TTS eleven-v4-turbo: Hebrew in ElevenLabs' v4 language list, p50 ≈ 0.9 s per request, mp3 output, $40 / M chars
//   (≈ $0.04 per 1k chars ≈ $0.035 per spoken minute). Gemini 3.8 Flash TTS is cheaper (≈ $0.013/min) and steerable
//   but measured p50 2.7–3.2 s per request, too slow for a phone-call feel.
export const DEFAULT_VOICE: VoiceConfig = {
  sttModel: 'openai/gpt-transcribe',
  ttsModel: 'elevenlabs/eleven-v4-turbo',
  ttsVoice: 'sarah',
  ttsStyle: 'Warm, relaxed and conversational, like a friendly coach on a phone call. Natural pace.',
};

const id = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= 200 ? v.trim() : undefined);

/** Merge an untrusted partial voice config over a base. */
export function mergeVoice(base: VoiceConfig | undefined, p: unknown): VoiceConfig {
  const v: VoiceConfig = { ...DEFAULT_VOICE, ...(base ?? {}) };
  if (!p || typeof p !== 'object') return v;
  const o = p as Record<string, unknown>;
  v.sttModel = id(o.sttModel) ?? v.sttModel;
  v.ttsModel = id(o.ttsModel) ?? v.ttsModel;
  v.ttsVoice = id(o.ttsVoice) ?? v.ttsVoice;
  if (typeof o.ttsStyle === 'string') v.ttsStyle = o.ttsStyle.trim().slice(0, 300);
  return v;
}
