// A voice call = a normal chat driven by voice (contract v4). Mic → VAD → /ai/voice/transcribe → sendMessage (the
// usual agent loop) → the streamed reply is cut into sentences → /ai/voice/speak per chunk → ordered playback.
// Latency (2026-11-25): the utterance is transcribed in segments while the user talks (cut at pauses, see Vad), so at
// the end only a short tail (usually nothing) is left; the first reply chunk goes to TTS at the first clause and is
// hedged; call turns run at the admin's voiceEffort (low).
// The transcript stays readable afterwards because it *is* the chat. Nothing here touches the loop's internals:
// this controller subscribes to the loop's live text (subscribeLive) and cuts it into sentences as it streams.
import { getLive, isRunning, sendMessage, setVoiceTurns, stop as stopLoop, subscribeLive } from '../agent/loop';
import { setChatFields } from '../agent/chats';
import type { AIPart } from '../agent/types';
import { speak, speakFast, transcribe } from './api';
import { openMic, Player, type Mic } from './audio';
import { encodeWav, resample, speakableText, takeChunks, Vad, type VadEvent } from './vad';

/** Rides on every user message of a call as a hidden context part (constant text: cache-friendly, not in the
 *  byte-stable instructions). isContextPart() hides it in the chat and keeps it out of titles. */
export const VOICE_NOTE = '<context>voice call: the user is talking to you and hears your reply read aloud. Answer in short, natural spoken sentences '
  + '(usually one to three), like a person on the phone. No markdown, lists, tables, emoji, URLs or ids, and never read out JSON or long number lists. '
  + 'Lead with the answer itself in the first few words; skip preambles like “Sure” or “Great question”. '
  + 'Cards (food logs, requests, questions, charts) still appear on the user’s screen during the call: when you create one, say so in a few words, '
  + 'e.g. “I’ve put it on screen, tap Log to save it.” Their words come from speech recognition and may have mistakes; if something sounds off, ask.</context>';

export type CallState = 'starting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking' | 'muted' | 'ended';
/** debug: last exchange's latency line (only with localStorage 'tapin:voicedebug' = '1') */
export type CallSnapshot = { state: CallState; you: string; agent: string; error: string; micOk: boolean; photos: number; frames: number; debug?: string };

const MAX_FRAMES_PER_UTTERANCE = 3;
/** Utterance end: the VAD ends at 500 ms of silence. If the transcript then doesn't end like a sentence, wait until
 *  HOLD_MS of silence before answering (and merge if the user goes on): people pause mid-sentence. Heuristic: the
 *  STT sometimes puts a period after a fragment, and then we answer at 500 ms as before. */
const HOLD_MS = 1100;
const SENTENCE_END = /[.!?…。？！؟]["'”’)\]]*\s*$/;
/** first reply chunk: a second TTS request if the first hasn't answered by then */
const HEDGE_MS = 1800; // above the measured p75 (1.6 s): ~1 in 5 first chunks gets a duplicate request

/** One utterance being transcribed in segments (index order). */
type Utt = { id: number; segs: Map<number, { ctl: AbortController; text: Promise<string> }>; done: Map<number, string> };
/** Latency marks of one exchange, ms from the end of the user's voice. */
export type VoiceTimings = { stt?: number; send?: number; firstText?: number; firstAudio?: number; segments: number; tailSent: boolean; ttsHead?: number; ttsBody?: number };
const MAX_FRAMES_PER_CALL = 24;
const FRAME_EVERY_MS = 2000;

export class VoiceCall {
  readonly chatId: string;
  readonly ctx: AudioContext;
  private player: Player;
  private vad: Vad;
  private mic: Mic | null = null;
  private snap: CallSnapshot = { state: 'starting', you: '', agent: '', error: '', micOk: false, photos: 0, frames: 0 };
  private subs = new Set<() => void>();
  private muted = false;
  private ended = false;
  private wake: { release: () => Promise<void> } | null = null;
  private abort = new AbortController();
  // streamed-reply tracking
  private lastText = '';
  private taken = 0;
  private firstChunk = true;
  private wasRunning = false;
  private ignoreLive = false; // after barge-in: drop the rest of the interrupted step's text
  // camera
  private photos: AIPart[] = [];
  private uttFrames: AIPart[] = [];
  private callFrames = 0;
  private frameTimer = 0;
  /** set by the call screen while the camera is on; returns a ≤768 px JPEG part or null */
  frameSource: (() => AIPart | null) | null = null;
  live = false;
  // utterance in progress (segments in flight), text held for a possible continuation
  private utt: Utt | null = null;
  private uttSeq = 0;
  private carry = '';
  /** utterance endings finish in order: a later part waits until the earlier part's text is in `carry` */
  private finalizing: Promise<void> = Promise.resolve();
  private holdTimer = 0;
  // metrics
  private t0 = 0;
  private marks: VoiceTimings = { segments: 0, tailSent: false };
  /** latency marks of the last exchanges (window.tapinVoice.call.timings) */
  timings: VoiceTimings[] = [];

  constructor(chatId: string, ctx: AudioContext) {
    this.chatId = chatId;
    this.ctx = ctx;
    this.player = new Player(ctx);
    this.vad = new Vad({ rate: ctx.sampleRate });
    this.player.onSpeaking = (on) => { this.vad.bargeIn = on; if (on) this.set({ state: 'speaking' }); else if (!this.ended) this.settle(); };
    this.player.onChunk = (text) => this.set({ agent: text });
    this.player.onError = (e) => this.set({ error: `Couldn’t play the voice: ${(e as Error).message ?? 'error'}` });
    this.player.onFirstAudio = () => this.mark('firstAudio');
  }

  private mark(k: 'stt' | 'send' | 'firstText' | 'firstAudio') {
    if (!this.t0 || this.marks[k] !== undefined) return;
    this.marks[k] = Math.round(performance.now() - this.t0);
    if (k === 'firstAudio') {
      this.timings = [...this.timings.slice(-19), { ...this.marks }];
      console.info('[voice] ms after speech end', this.marks);
      let dbg = false;
      try { dbg = localStorage.getItem('tapin:voicedebug') === '1'; } catch { /* ignore */ }
      const m = this.marks;
      if (dbg) this.set({ debug: `stt ${m.stt ?? '–'} · send ${m.send ?? '–'} · 1st text ${m.firstText ?? '–'} · 1st audio ${m.firstAudio} ms · seg ${m.segments}${m.tailSent ? '+tail' : ''}${m.ttsHead !== undefined ? ` · tts ${m.ttsHead}/${m.ttsBody}` : ''}` });
    }
  }

  // ---- store-ish API for React (useSyncExternalStore) ----
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  getSnapshot = () => this.snap;
  private set(p: Partial<CallSnapshot>) { this.snap = { ...this.snap, ...p }; this.subs.forEach((f) => f()); }
  /** mic level and agent level, 0..1, for the orb (read every frame, not React state) */
  levels() { return { mic: this.muted ? 0 : this.vad.level, agent: this.player.level() }; }

  private started = false;
  private sending = false; // between sending an utterance and the loop finishing
  private unsubLive: (() => void) | null = null;
  private endTimer = 0;
  /** React StrictMode mounts effects twice: the cleanup schedules end(), a re-run cancels it. */
  endSoon() { this.endTimer = window.setTimeout(() => this.end(), 0); }

  async start() {
    clearTimeout(this.endTimer);
    if (this.started) return;
    this.started = true;
    void setChatFields(this.chatId, { voice: true });
    setVoiceTurns(this.chatId, true);
    // every live delta, synchronously (a React effect would see only the batched last value and miss whole replies)
    let prev = getLive(this.chatId);
    this.unsubLive = subscribeLive(() => { const l = getLive(this.chatId); if (l.text !== prev.text || l.running !== prev.running) { prev = l; this.feedLive(l.text, l.running); } });
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.lockScreen();
    try {
      this.mic = await openMic(this.ctx, (s) => this.onSamples(s));
      this.mic.track.addEventListener('ended', this.onTrackEnded);
      this.set({ micOk: true });
    } catch (e) {
      const name = (e as Error).name;
      this.set({ micOk: false, error: name === 'NotAllowedError' ? 'Microphone access is off. Allow it for Tap In in Settings, or type below.' : `Microphone unavailable${(e as Error).message ? `: ${(e as Error).message}` : ''}. You can type below.` });
    }
    if (this.ended) { this.mic?.close(); return; }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.settle();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    setVoiceTurns(this.chatId, false);
    this.dropUtterance();
    this.abort.abort();
    this.unsubLive?.(); this.unsubLive = null;
    this.player.stop();
    this.mic?.track.removeEventListener('ended', this.onTrackEnded);
    this.mic?.close(); this.mic = null;
    clearInterval(this.frameTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.wake?.release().catch(() => {}); this.wake = null;
    void this.ctx.close().catch(() => {});
    this.set({ state: 'ended' });
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.mic) this.mic.track.enabled = !m;
    this.vad.reset();
    this.dropUtterance();
    this.player.duck(false);
    this.settle();
  }

  /** Photo from the shutter: goes with the next utterance. */
  addPhoto(p: AIPart) { this.photos = [...this.photos, p].slice(-3); this.set({ photos: this.photos.length }); }
  clearPhotos() { this.photos = []; this.set({ photos: 0 }); }
  /** Send the waiting photo(s) right away with a short question. */
  sendPhotosNow(text = 'What’s this?') { if (this.photos.length) void this.sendUtterance(text); }
  /** Typed text (no mic, or debugging): same path as a transcribed utterance. */
  sendText(text: string) { if (text.trim()) void this.sendUtterance(text.trim()); }

  // ---- reply → speech ----
  /** The loop's live state on every change (subscribed in start()). */
  feedLive(text: string, running: boolean) {
    if (this.ended) return;
    if (this.ignoreLive) {
      if (!running) { this.ignoreLive = false; this.lastText = ''; this.taken = 0; }
      this.wasRunning = running;
      return;
    }
    if (!text.startsWith(this.lastText)) { // the step ended (live text reset): speak what's left of the old text
      this.speakChunks(takeChunks(this.lastText, this.taken, true, this.firstChunk).chunks);
      this.taken = 0;
    }
    this.lastText = text;
    const r = takeChunks(text, this.taken, false, this.firstChunk);
    this.taken = r.next;
    this.speakChunks(r.chunks);
    if (this.wasRunning && !running) {
      this.speakChunks(takeChunks(this.lastText, this.taken, true, this.firstChunk).chunks);
      this.lastText = ''; this.taken = 0;
      if (!this.player.busy) this.settle();
    }
    if (running && !this.wasRunning) this.firstChunk = true;
    if (text) this.mark('firstText');
    this.wasRunning = running;
  }

  private speakChunks(chunks: string[]) {
    for (const c of chunks) {
      const t = speakableText(c);
      if (!t) continue;
      // the first chunk of a reply is what the user waits on: hedge it against a slow TTS request
      const first = this.firstChunk;
      this.firstChunk = false;
      const audio = first ? speakFast(t, this.abort.signal, HEDGE_MS) : speak(t, this.abort.signal);
      if (first) audio.then((a) => { if (a.ms && this.marks.ttsHead === undefined) { this.marks.ttsHead = a.ms.head; this.marks.ttsBody = a.ms.body; } }, () => {});
      this.player.enqueue(t, audio);
    }
  }

  // ---- mic → utterances ----
  private onSamples(s: Float32Array) {
    if (this.ended || this.muted) return;
    for (const ev of this.vad.push(s)) {
      if (ev.type === 'start') {
        this.player.duck(true); // a cough must not kill the reply: only a real utterance (sendUtterance) stops it
        if (this.holdTimer) {
          // the user went on after a pause that looked like the end: keep what was said, merge it with this part
          clearTimeout(this.holdTimer); this.holdTimer = 0;
        } else if (!this.carry) {
          this.uttFrames = [];
          this.grabFrame();
        }
        this.utt = { id: ++this.uttSeq, segs: new Map(), done: new Map() };
        if (this.live) { clearInterval(this.frameTimer); this.frameTimer = window.setInterval(() => this.grabFrame(), FRAME_EVERY_MS); }
        this.set({ state: 'hearing', you: this.carry ? this.carry + '…' : '' }); // live caption fills in as segments come back
      } else if (ev.type === 'segment') {
        this.transcribeSegment(ev.index, ev.samples);
      } else if (ev.type === 'retract') {
        this.utt?.segs.get(ev.index)?.ctl.abort();
        this.utt?.segs.delete(ev.index); this.utt?.done.delete(ev.index);
      } else {
        clearInterval(this.frameTimer);
        if (ev.type === 'drop') {
          if (this.utt) for (const x of this.utt.segs.values()) x.ctl.abort();
          this.utt = null;
          if (this.carry) { const t = this.carry; this.carry = ''; void this.sendUtterance(t); continue; } // a cough after a held sentence
          this.uttFrames = []; this.player.duck(false); this.settle(); continue;
        }
        void this.handleUtterance(ev);
      }
    }
  }

  private grabFrame() {
    if (!this.live || !this.frameSource || this.uttFrames.length >= MAX_FRAMES_PER_UTTERANCE || this.callFrames >= MAX_FRAMES_PER_CALL) return;
    const f = this.frameSource();
    if (f) { this.uttFrames.push(f); this.callFrames++; this.set({ frames: this.callFrames }); }
    if (this.callFrames >= MAX_FRAMES_PER_CALL) { this.live = false; this.set({ error: 'Live camera paused: frame limit for this call reached. Use the shutter for more.' }); }
  }

  /** Send one segment for transcription now (in the background); captions update as segments come back. */
  private transcribeSegment(index: number, samples: Float32Array) {
    const utt = this.utt;
    if (!utt) return;
    const ctl = new AbortController();
    this.abort.signal.addEventListener('abort', () => ctl.abort());
    const wav = encodeWav(resample(samples, this.ctx.sampleRate, 16000), 16000);
    const text = transcribe(new Blob([wav as BlobPart], { type: 'audio/wav' }), ctl.signal, { utt: utt.id, index });
    text.catch(() => {}); // awaited (and handled) at the end of the utterance
    utt.segs.set(index, { ctl, text });
    void text.then((t) => {
      if (this.utt !== utt || utt.segs.get(index)?.text !== text) return;
      utt.done.set(index, t);
      const partial = this.joinDone(utt);
      if (partial && this.snap.state === 'hearing') this.set({ you: [this.carry, partial].filter(Boolean).join(' ') + '…' });
    }, () => {});
  }
  /** The text of the leading run of finished segments. */
  private joinDone(utt: Utt) {
    const out: string[] = [];
    for (let i = 0; utt.done.has(i); i++) out.push(utt.done.get(i)!);
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }
  private dropGen = 0; // bumped when an utterance is thrown away (mute / end): its late transcripts are ignored
  private dropUtterance() {
    this.dropGen++;
    if (this.utt) for (const x of this.utt.segs.values()) x.ctl.abort();
    this.utt = null;
    clearTimeout(this.holdTimer); this.holdTimer = 0;
    this.carry = '';
  }

  private async handleUtterance(ev: Extract<VadEvent, { type: 'end' }>) {
    const prev = this.finalizing;
    let release = () => {};
    this.finalizing = new Promise<void>((r) => { release = r; });
    try { await this.finishUtterance(ev, prev); } finally { release(); }
  }

  private async finishUtterance(ev: Extract<VadEvent, { type: 'end' }>, prev: Promise<void>) {
    const utt = this.utt ?? { id: ++this.uttSeq, segs: new Map(), done: new Map() };
    this.utt = utt;
    const gen = this.dropGen;
    this.t0 = performance.now() - this.vad.endSilenceMs; // when the voice stopped
    this.marks = { segments: utt.segs.size, tailSent: false };
    this.set({ state: 'transcribing' });
    // only the tail after the last segment is left, usually just the end-of-speech silence: then nothing is sent
    if (ev.tailVoicedMs >= 120 || utt.segs.size === 0) {
      this.marks.tailSent = true; this.marks.segments++;
      this.transcribeSegment(ev.index, utt.segs.size === 0 ? ev.samples : ev.tail);
    }
    let text = '';
    try {
      const parts: string[] = [];
      for (const i of [...utt.segs.keys()].sort((x, y) => x - y)) parts.push(await utt.segs.get(i)!.text);
      text = parts.join(' ').replace(/\s+/g, ' ').trim();
    } catch (e) {
      if (this.ended || gen !== this.dropGen || (e as Error).name === 'AbortError') return;
      // a segment failed: one more try with the whole utterance in one piece
      try { text = await transcribe(new Blob([encodeWav(resample(ev.samples, this.ctx.sampleRate, 16000), 16000) as BlobPart], { type: 'audio/wav' }), this.abort.signal); }
      catch (e2) {
        if (this.ended || gen !== this.dropGen) return;
        this.set({ error: (e2 as Error).message || 'Couldn’t hear that. Try again.' });
        this.utt = null; this.carry = ''; this.uttFrames = [];
        this.player.duck(false);
        return this.settle();
      }
    }
    await prev; // an earlier part still being transcribed lands in `carry` first
    if (this.ended || gen !== this.dropGen) return; // muted / ended meanwhile
    if (this.utt !== utt) { this.carry = [this.carry, text].filter(Boolean).join(' '); return; } // talking again: merge into the next part
    this.utt = null;
    this.mark('stt');
    const full = [this.carry, text].filter((t) => t && !/^[\s.,!?…-]*$/.test(t)).join(' ').trim();
    if (!full) { this.carry = ''; this.uttFrames = []; this.player.duck(false); return this.settle(); }
    // doesn't sound finished: give the user up to HOLD_MS of silence to go on (a new start merges, see onSamples)
    const silent = performance.now() - this.t0;
    if (!SENTENCE_END.test(full) && silent < HOLD_MS) {
      this.carry = full;
      this.set({ you: full + '…' });
      this.holdTimer = window.setTimeout(() => { this.holdTimer = 0; const t = this.carry; this.carry = ''; if (t && !this.vad.isSpeaking) void this.sendUtterance(t); else this.carry = t; }, HOLD_MS - silent);
      return;
    }
    this.carry = '';
    await this.sendUtterance(full);
  }

  private async sendUtterance(text: string) {
    if (this.ended) return;
    if (this.player.busy || isRunning(this.chatId)) await this.bargeIn();
    this.player.duck(false);
    const parts: AIPart[] = [{ type: 'text', text: VOICE_NOTE }, ...this.photos, ...this.uttFrames, { type: 'text', text }];
    if (this.uttFrames.length) parts.splice(1 + this.photos.length, 0, { type: 'text', text: `<context>${this.uttFrames.length} live camera frame${this.uttFrames.length > 1 ? 's' : ''} taken while the user spoke</context>` });
    this.photos = []; this.uttFrames = [];
    this.set({ you: text, agent: '', error: '', photos: 0, state: 'thinking' });
    this.mark('send');
    this.firstChunk = true; this.lastText = ''; this.taken = 0;
    this.sending = true;
    void sendMessage(this.chatId, parts).finally(() => { this.sending = false; if (!this.ended && !this.player.busy) this.settle(); });
  }

  /** The user spoke over the agent: stop talking and stop the model, then let the new utterance through. */
  private async bargeIn() {
    this.player.stop();
    if (isRunning(this.chatId)) {
      this.ignoreLive = true;
      stopLoop(this.chatId);
      for (let i = 0; i < 50 && isRunning(this.chatId); i++) await new Promise((r) => setTimeout(r, 40)); // sendMessage ignores a running chat
    }
    this.lastText = ''; this.taken = 0;
  }

  /** Pick the resting state from what's going on. */
  private settle() {
    if (this.ended) return;
    if (this.muted) return this.set({ state: 'muted' });
    if (this.player.busy) return this.set({ state: 'speaking' });
    if (this.vad.isSpeaking) return this.set({ state: 'hearing' });
    if (this.sending || isRunning(this.chatId)) return this.set({ state: 'thinking' });
    this.set({ state: 'listening' });
  }

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') { this.set({ error: 'Call ended: the app went to the background.' }); this.end(); }
  };
  private onTrackEnded = () => { this.set({ micOk: false, error: 'The microphone stopped. End the call and start again, or type below.' }); };
  private async lockScreen() {
    try { const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock; if (wl) this.wake = await wl.request('screen'); } catch { /* not allowed */ }
  }
}
