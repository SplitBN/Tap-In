// Web Audio plumbing for calls: one AudioContext (created + resumed inside the Call tap — iOS only unlocks audio in a
// user gesture), the mic tap (AudioWorklet, ScriptProcessor fallback) and an ordered playback queue.
import { pcm16ToFloat } from './vad';
import type { SpokenAudio } from './api';

/** Call synchronously from the tap handler, before any await. */
export function unlockAudio(): AudioContext {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  void ctx.resume();
  // a silent one-sample buffer played inside the gesture fully unlocks output on older iOS
  try { const b = ctx.createBuffer(1, 1, ctx.sampleRate); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(); } catch { /* ignore */ }
  // speechSynthesis (fake mode) also needs a gesture on iOS
  try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch { /* ignore */ }
  // Safari 16.4+: tell iOS this is a call (mic + playback together)
  try { const s = (navigator as unknown as { audioSession?: { type: string } }).audioSession; if (s) s.type = 'play-and-record'; } catch { /* ignore */ }
  return ctx;
}

const rmsOf = (a: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length || 1)); };

// ---------------- mic ----------------
const WORKLET = `class TapinMic extends AudioWorkletProcessor { process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor('tapin-mic', TapinMic);`;

export type Mic = { stream: MediaStream; track: MediaStreamTrack; close: () => void };

/** Open the mic with echo cancellation and feed raw samples (at ctx.sampleRate) to onSamples. */
export async function openMic(ctx: AudioContext, onSamples: (s: Float32Array) => void): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t use the microphone here.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const track = stream.getAudioTracks()[0];
  const src = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination); // nodes must reach the destination to be pulled
  let node: AudioNode;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const w = new AudioWorkletNode(ctx, 'tapin-mic', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    w.port.onmessage = (e) => onSamples(e.data as Float32Array);
    node = w;
  } catch {
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
    node = sp;
  }
  src.connect(node); node.connect(sink);
  return {
    stream, track,
    close: () => {
      try { src.disconnect(); node.disconnect(); sink.disconnect(); } catch { /* ignore */ }
      if (node instanceof AudioWorkletNode) node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// ---------------- playback queue ----------------
type Item = { text: string; audio: Promise<SpokenAudio> };

/** Plays chunks strictly in order. Each chunk's audio is fetched as soon as it's queued (prefetch), so the next
 *  sentence is usually ready when the current one ends. stop() drops everything (barge-in). */
export class Player {
  private ctx: AudioContext;
  private out: GainNode;
  readonly analyser: AnalyserNode;
  private queue: Item[] = [];
  private current: AudioBufferSourceNode | null = null;
  private gen = 0;
  private pumping = false;
  private buf: Float32Array<ArrayBuffer>;
  onSpeaking: (on: boolean) => void = () => {};
  onChunk: (text: string) => void = () => {};
  onError: (e: unknown) => void = () => {};

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.out.connect(this.analyser); this.analyser.connect(ctx.destination);
  }
  get busy() { return this.pumping || this.queue.length > 0; }
  /** current output level 0..1 (speechSynthesis can't be measured: a gentle fake pulse instead) */
  level() {
    if (this.synthOn) return 0.05 + 0.04 * Math.abs(Math.sin(performance.now() / 140));
    this.analyser.getFloatTimeDomainData(this.buf);
    return rmsOf(this.buf);
  }
  private synthOn = false;

  enqueue(text: string, audio: Promise<SpokenAudio>) {
    audio.catch(() => {}); // handled when its turn comes
    this.queue.push({ text, audio });
    if (!this.pumping) void this.pump();
  }

  /** Lower the voice while the user may be talking (restored when it turns out to be noise). */
  duck(on: boolean) {
    const t = this.ctx.currentTime;
    try { this.out.gain.cancelScheduledValues(t); this.out.gain.setTargetAtTime(on ? 0.15 : 1, t, 0.05); } catch { this.out.gain.value = on ? 0.15 : 1; }
    if ('speechSynthesis' in window) { try { if (on) speechSynthesis.pause(); else speechSynthesis.resume(); } catch { /* ignore */ } }
  }

  stop() {
    this.gen++;
    this.queue = [];
    try { this.current?.stop(); } catch { /* already stopped */ }
    this.current = null;
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch { /* ignore */ }
    this.synthOn = false;
  }

  private async pump() {
    this.pumping = true;
    const g = this.gen;
    this.onSpeaking(true);
    try {
      while (this.queue.length && g === this.gen) {
        const item = this.queue.shift()!;
        let a: SpokenAudio;
        try { a = await item.audio; } catch (e) { if (g === this.gen) this.onError(e); continue; }
        if (g !== this.gen) break;
        this.onChunk(item.text);
        if (a.kind === 'synth') { await this.playSynth(a.text, g); continue; }
        let buffer: AudioBuffer;
        try {
          if (a.kind === 'pcm') {
            const f = pcm16ToFloat(a.data);
            buffer = this.ctx.createBuffer(1, Math.max(1, f.length), a.rate);
            buffer.getChannelData(0).set(f);
          } else buffer = await this.ctx.decodeAudioData(a.data.slice(0));
        } catch (e) { this.onError(e); continue; }
        if (g !== this.gen) break;
        await this.playBuffer(buffer, g);
      }
    } finally {
      this.pumping = false;
      if (g === this.gen) this.onSpeaking(false);
      else if (this.queue.length) void this.pump(); // stop() then new chunks arrived while this run was unwinding
      else this.onSpeaking(false);
    }
  }

  private playBuffer(buffer: AudioBuffer, g: number) {
    return new Promise<void>((resolve) => {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      const s = this.ctx.createBufferSource();
      s.buffer = buffer; s.connect(this.out);
      s.onended = () => { if (this.current === s) this.current = null; resolve(); };
      this.current = s;
      try { s.start(); } catch { resolve(); }
      if (g !== this.gen) { try { s.stop(); } catch { /* ignore */ } }
    });
  }

  private playSynth(text: string, g: number) {
    return new Promise<void>((resolve) => {
      if (g !== this.gen) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = /[֐-׿]/.test(text) ? 'he-IL' : 'en-US';
      u.rate = 1.05;
      const done = () => { this.synthOn = false; clearTimeout(t); resolve(); };
      const t = setTimeout(done, 2000 + text.length * 120); // some engines never fire onend
      u.onend = done; u.onerror = done;
      this.synthOn = true;
      speechSynthesis.speak(u);
    });
  }
}
