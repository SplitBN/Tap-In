// Admin only (Settings → Agent → For everyone): the voice-call models. Lists come from OpenRouter's public catalog
// (speech + transcription models) through /ai/voice/models; voices from /ai/voice/voices for the chosen TTS model.
import { useEffect, useState } from 'react';
import { DEFAULT_GLOBAL } from '../lib/agent/client';
import type { AIGlobal, VoiceConfig } from '../lib/agent/types';
import { voiceModels, voiceVoices } from '../lib/voice/api';

type M = { id: string; name: string };

export function VoiceAdminRows({ g, save }: { g: AIGlobal; save: (patch: Partial<AIGlobal>) => void | Promise<void> }) {
  const v: VoiceConfig = { ...DEFAULT_GLOBAL.voice!, ...g.voice };
  const [lists, setLists] = useState<{ stt: M[]; tts: M[] }>({ stt: [], tts: [] });
  const [info, setInfo] = useState<{ voices: string[]; instructions: boolean } | null>(null);
  const [style, setStyle] = useState(v.ttsStyle);
  useEffect(() => { voiceModels().then(setLists).catch(() => {}); }, []);
  useEffect(() => { let on = true; setInfo(null); voiceVoices(v.ttsModel).then((r) => on && setInfo(r)).catch(() => {}); return () => { on = false; }; }, [v.ttsModel]);
  const set = (patch: Partial<VoiceConfig>) => save({ voice: { ...v, ...patch } });
  const pickModel = async (ttsModel: string) => {
    // a voice from the old model rarely exists in the new one: take the new model's first voice
    const r = await voiceVoices(ttsModel).catch(() => null);
    void set({ ttsModel, ...(r?.voices.length && !r.voices.includes(v.ttsVoice) ? { ttsVoice: r.voices[0] } : {}) });
  };
  return (
    <>
      <Pick label="Voice: listening" sub="Speech to text" list={lists.stt} value={v.sttModel} onChange={(sttModel) => set({ sttModel })} />
      <Pick label="Voice: speaking" sub="Text to speech" list={lists.tts} value={v.ttsModel} onChange={pickModel} />
      <Pick label="Voice" list={(info?.voices ?? []).map((id) => ({ id, name: id }))} value={v.ttsVoice} onChange={(ttsVoice) => set({ ttsVoice })} />
      {info?.instructions && (
        <div className="list-item" style={{ flexWrap: 'wrap' }}>
          <span className="grow title">Speaking style</span>
          <input className="input" style={{ width: '100%' }} maxLength={300} aria-label="Speaking style" value={style}
            onChange={(e) => setStyle(e.target.value)} onBlur={() => style !== v.ttsStyle && set({ ttsStyle: style })} />
        </div>
      )}
    </>
  );
}

function Pick({ label, sub, list, value, onChange }: { label: string; sub?: string; list: M[]; value: string; onChange: (v: string) => void }) {
  const known = list.some((m) => m.id === value);
  return (
    <label className="list-item">
      <span className="grow"><span className="title">{label}</span>{sub && <span className="sub" style={{ display: 'block' }}>{sub}</span>}</span>
      <select className="inline-select" value={value} onChange={(e) => e.target.value && onChange(e.target.value)}>
        {!known && <option value={value}>{value}</option>}
        {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </label>
  );
}
