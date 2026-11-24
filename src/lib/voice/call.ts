// A voice call = a normal chat driven by voice (contract v4). Mic → VAD → /ai/voice/transcribe → sendMessage (the
// usual agent loop) → the streamed reply is cut into sentences → /ai/voice/speak per chunk → ordered playback.
// The transcript stays readable afterwards because it *is* the chat. Nothing here touches the loop's internals:
// this controller subscribes to the loop's live text (subscribeLive) and cuts it into sentences as it streams.
import { getLive, isRunning, sendMessage, stop as stopLoop, subscribeLive } from '../agent/loop';
import { setChatFields } from '../agent/chats';
import type { AIPart } from '../agent/types';
import { speak, transcribe } from './api';
import { openMic, Player, type Mic } from './audio';
import { encodeWav, resample, speakableText, takeChunks, Vad } from './vad';

/** Rides on every user message of a call as a hidden context part (constant text: cache-friendly, not in the
 *  byte-stable instructions). isContextPart() hides it in the chat and keeps it out of titles. */
export const VOICE_NOTE = '<context>voice call: the user is talking to you and hears your reply read aloud. Answer in short, natural spoken sentences '
  + '(usually one to three), like a person on the phone. No markdown, lists, tables, emoji, URLs or ids, and never read out JSON or long number lists. '
  + 'Cards (food logs, requests, questions, charts) still appear on the user’s screen during the call: when you create one, say so in a few words, '
  + 'e.g. “I’ve put it on screen, tap Log to save it.” Their words come from speech recognition and may have mistakes; if something sounds off, ask.</context>';

export type CallState = 'starting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking' | 'muted' | 'ended';
export type CallSnapshot = { state: CallState; you: string; agent: string; error: string; micOk: boolean; photos: number; frames: number };

const MAX_FRAMES_PER_UTTERANCE = 3;
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

  constructor(chatId: string, ctx: AudioContext) {
    this.chatId = chatId;
    this.ctx = ctx;
    this.player = new Player(ctx);
    this.vad = new Vad({ rate: ctx.sampleRate });
    this.player.onSpeaking = (on) => { this.vad.bargeIn = on; if (on) this.set({ state: 'speaking' }); else if (!this.ended) this.settle(); };
    this.player.onChunk = (text) => this.set({ agent: text });
    this.player.onError = (e) => this.set({ error: `Couldn’t play the voice: ${(e as Error).message ?? 'error'}` });
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
    this.wasRunning = running;
  }

  private speakChunks(chunks: string[]) {
    for (const c of chunks) {
      const t = speakableText(c);
      if (!t) continue;
      this.firstChunk = false;
      this.player.enqueue(t, speak(t, this.abort.signal));
    }
  }

  // ---- mic → utterances ----
  private onSamples(s: Float32Array) {
    if (this.ended || this.muted) return;
    for (const ev of this.vad.push(s)) {
      if (ev.type === 'start') {
        this.player.duck(true); // a cough must not kill the reply: only a real utterance (sendUtterance) stops it
        this.uttFrames = [];
        this.grabFrame();
        if (this.live) { clearInterval(this.frameTimer); this.frameTimer = window.setInterval(() => this.grabFrame(), FRAME_EVERY_MS); }
        this.set({ state: 'hearing' });
      } else {
        clearInterval(this.frameTimer);
        if (ev.type === 'drop') { this.uttFrames = []; this.player.duck(false); this.settle(); continue; }
        void this.handleUtterance(ev.samples);
      }
    }
  }

  private grabFrame() {
    if (!this.live || !this.frameSource || this.uttFrames.length >= MAX_FRAMES_PER_UTTERANCE || this.callFrames >= MAX_FRAMES_PER_CALL) return;
    const f = this.frameSource();
    if (f) { this.uttFrames.push(f); this.callFrames++; this.set({ frames: this.callFrames }); }
    if (this.callFrames >= MAX_FRAMES_PER_CALL) { this.live = false; this.set({ error: 'Live camera paused: frame limit for this call reached. Use the shutter for more.' }); }
  }

  private async handleUtterance(samples: Float32Array) {
    this.set({ state: 'transcribing' });
    const wav = encodeWav(resample(samples, this.ctx.sampleRate, 16000), 16000);
    let text = '';
    try { text = await transcribe(new Blob([wav as BlobPart], { type: 'audio/wav' }), this.abort.signal); }
    catch (e) {
      if (this.ended) return;
      this.set({ error: (e as Error).message || 'Couldn’t hear that. Try again.' });
      this.uttFrames = [];
      this.player.duck(false);
      return this.settle();
    }
    if (this.ended) return;
    if (!text || /^[\s.,!?…-]*$/.test(text)) { this.uttFrames = []; this.player.duck(false); return this.settle(); }
    await this.sendUtterance(text);
  }

  private async sendUtterance(text: string) {
    if (this.ended) return;
    if (this.player.busy || isRunning(this.chatId)) await this.bargeIn();
    this.player.duck(false);
    const parts: AIPart[] = [{ type: 'text', text: VOICE_NOTE }, ...this.photos, ...this.uttFrames, { type: 'text', text }];
    if (this.uttFrames.length) parts.splice(1 + this.photos.length, 0, { type: 'text', text: `<context>${this.uttFrames.length} live camera frame${this.uttFrames.length > 1 ? 's' : ''} taken while the user spoke</context>` });
    this.photos = []; this.uttFrames = [];
    this.set({ you: text, agent: '', error: '', photos: 0, state: 'thinking' });
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
