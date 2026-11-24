// Energy-based voice activity detection + WAV encoding (pure: no DOM, no Web Audio — testable with generated buffers).
// Frames of 20 ms. The noise floor adapts while nobody speaks; speech = RMS clearly above it for a short run of frames.
// While the agent talks (barge-in mode) the bar is higher and longer, so the agent's own voice leaking past echo
// cancellation doesn't interrupt it.

export type VadOptions = {
  rate: number;
  /** silence that ends an utterance */
  endSilenceMs?: number;
  /** audio kept from before the detected start, so the first syllable isn't clipped */
  preRollMs?: number;
  maxMs?: number;
  /** utterances with less voiced audio than this are dropped (coughs, clicks) */
  minVoicedMs?: number;
};
export type VadEvent = { type: 'start' } | { type: 'end'; samples: Float32Array; voicedMs: number } | { type: 'drop' };

export class Vad {
  readonly rate: number;
  private frameLen: number;
  private frame: Float32Array;
  private fi = 0;
  private noise = 0.004;
  private speaking = false;
  private above = 0;
  private below = 0;
  private voiced = 0;
  private pre: Float32Array[] = [];
  private rec: Float32Array[] = [];
  private recLen = 0;
  private o: Required<VadOptions>;
  /** true while the agent is speaking: higher threshold + longer run to start */
  bargeIn = false;
  /** last frame RMS (0..1), for the orb */
  level = 0;

  constructor(opts: VadOptions) {
    this.o = { endSilenceMs: 700, preRollMs: 300, maxMs: 120_000, minVoicedMs: 300, ...opts };
    this.rate = opts.rate;
    this.frameLen = Math.max(64, Math.round(opts.rate * 0.02));
    this.frame = new Float32Array(this.frameLen);
  }
  get isSpeaking() { return this.speaking; }
  private get frameMs() { return (this.frameLen / this.rate) * 1000; }
  threshold() { return this.bargeIn ? Math.max(0.035, this.noise * 5) : Math.max(0.012, this.noise * 3); }

  /** Forget the current utterance (mute, barge-in handled elsewhere). */
  reset() { this.speaking = false; this.above = this.below = this.voiced = 0; this.rec = []; this.recLen = 0; }

  push(samples: Float32Array): VadEvent[] {
    const out: VadEvent[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.frame[this.fi++] = samples[i];
      if (this.fi === this.frameLen) { this.fi = 0; const e = this.onFrame(this.frame.slice()); if (e) out.push(e); }
    }
    return out;
  }

  private onFrame(f: Float32Array): VadEvent | null {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    this.level = rms;
    const thr = this.threshold();
    const loud = rms > thr;
    if (!this.speaking) {
      // pre-roll ring
      this.pre.push(f);
      const keep = Math.ceil(this.o.preRollMs / this.frameMs) + 1;
      while (this.pre.length > keep) this.pre.shift();
      if (!loud) this.noise = this.noise * 0.95 + Math.min(rms, 0.05) * 0.05; // adapt only on quiet frames
      this.above = loud ? this.above + 1 : 0;
      const need = this.bargeIn ? 12 : 4; // 240 ms vs 80 ms of sustained voice
      if (this.above >= need) {
        this.speaking = true; this.below = 0; this.voiced = this.above;
        this.rec = [...this.pre]; this.recLen = this.rec.reduce((n, x) => n + x.length, 0);
        this.pre = [];
        return { type: 'start' };
      }
      return null;
    }
    this.rec.push(f); this.recLen += f.length;
    if (rms > thr * 0.7) { this.voiced++; this.below = 0; } else this.below++;
    const silentMs = this.below * this.frameMs;
    if (silentMs >= this.o.endSilenceMs || (this.recLen / this.rate) * 1000 >= this.o.maxMs) {
      const voicedMs = this.voiced * this.frameMs;
      const all = concat(this.rec, this.recLen);
      this.reset();
      return voicedMs < this.o.minVoicedMs ? { type: 'drop' } : { type: 'end', samples: all, voicedMs };
    }
    return null;
  }
}

function concat(parts: Float32Array[], n: number) {
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Linear-interpolated resample to `to` Hz (speech: 16 kHz is plenty and keeps uploads ~32 KB/s). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const n = Math.floor((input.length * to) / from);
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step, i0 = Math.floor(x), t = x - i0;
    out[i] = (input[i0] ?? 0) * (1 - t) + (input[i0 + 1] ?? input[i0] ?? 0) * t;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const b = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(b.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return b;
}

/** Raw 16-bit little-endian PCM → float samples. */
export function pcm16ToFloat(buf: ArrayBuffer): Float32Array {
  const n = Math.floor(buf.byteLength / 2);
  const dv = new DataView(buf, 0, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 0x8000;
  return out;
}

// ---- sentence chunking for streamed text → TTS ----
const BOUNDARY = /[.!?…;:]+["'”’)\]]*(?=\s)|\n+/g;

/** Strip what must never be read aloud. Returns '' when nothing speakable is left. */
export function speakableText(s: string) {
  const t = s.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/^\s*[-*•]\s+/gm, '').replace(/[*_#`>|~]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ').replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

/**
 * Split newly streamed text into chunks to synthesize. `from` = how much of `text` was already taken.
 * Returns the chunks and the new offset. The first chunk goes out at the first sentence end (low latency); later
 * short sentences are merged so we don't pay a TTS round trip per "Sure." A run with no boundary is cut at a comma or
 * space once it passes `maxLen`. `final` = the stream ended: everything left is one more chunk.
 */
export function takeChunks(text: string, from: number, final: boolean, first: boolean, maxLen = 280): { chunks: string[]; next: number } {
  const chunks: string[] = [];
  let pos = from, isFirst = first;
  for (;;) {
    const rest = text.slice(pos);
    BOUNDARY.lastIndex = 0;
    let cut = -1, m: RegExpExecArray | null;
    while ((m = BOUNDARY.exec(rest))) {
      const end = m.index + m[0].length;
      if (rest.slice(0, end).trim().length >= (isFirst ? 2 : 40)) { cut = end; break; }
    }
    if (cut < 0 && rest.length > maxLen) {
      const sp = Math.max(rest.lastIndexOf(', ', maxLen), rest.lastIndexOf(' ', maxLen));
      cut = sp > 20 ? sp + 1 : maxLen;
    }
    if (cut < 0) break;
    const c = rest.slice(0, cut).trim();
    if (c) chunks.push(c);
    pos += cut; isFirst = false;
  }
  if (final) { const c = text.slice(pos).trim(); if (c) chunks.push(c); pos = text.length; }
  return { chunks, next: pos };
}
