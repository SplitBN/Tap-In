// Voice-call pure logic checks on generated audio (runs before every build; Node strips the TS types):
// VAD segmentation for transcribe-while-talking, first-chunk clause cuts for TTS, and the pitch-keeping time-stretch.
import { takeChunks, Vad } from '../src/lib/voice/vad.ts';
import { timeStretch } from '../src/lib/voice/stretch.ts';

const fails = [];
const check = (name, ok, detail = '') => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ''}`); };
const RATE = 16000;

/** Build audio from [ms, 'voice' | 'quiet'] runs: a 180 Hz tone at 0.2 or a faint noise floor. */
function audio(runs) {
  const out = [];
  let t = 0;
  for (const [ms, kind] of runs) {
    const n = Math.round((RATE * ms) / 1000);
    for (let i = 0; i < n; i++, t++) out.push(kind === 'voice' ? 0.2 * Math.sin((2 * Math.PI * 180 * t) / RATE) : (Math.random() - 0.5) * 0.002);
  }
  return Float32Array.from(out);
}
function run(runs, opts = {}) {
  const vad = new Vad({ rate: RATE, ...opts });
  const evs = [];
  const a = audio(runs);
  for (let i = 0; i < a.length; i += 128) evs.push(...vad.push(a.subarray(i, i + 128)));
  return evs;
}
const types = (evs) => evs.map((e) => e.type + (e.type === 'segment' ? `${e.index}${e.provisional ? 'p' : ''}` : e.type === 'retract' ? e.index : '')).join(' ');

// 1. one phrase then silence: a provisional segment at the pause, then end with an (almost) silent tail
{
  const evs = run([[500, 'quiet'], [900, 'voice'], [800, 'quiet']]);
  check('short phrase: start, segment (provisional), end', types(evs) === 'start segment0p end', types(evs));
  const end = evs.find((e) => e.type === 'end');
  check('short phrase: tail holds no voice', end && end.tailVoicedMs < 120, String(end?.tailVoicedMs));
  check('short phrase: end index = 1 (after the segment)', end?.index === 1);
}
// 2. long talk with pauses: committed segments at pauses ≥ 260 ms, nothing at 150 ms breaths
{
  const evs = run([[500, 'quiet'], [1600, 'voice'], [300, 'quiet'], [1500, 'voice'], [150, 'quiet'], [700, 'voice'], [700, 'quiet']]);
  check('long talk: committed segment, then a later one', types(evs) === 'start segment0 segment1 end', types(evs));
  const segs = evs.filter((e) => e.type === 'segment');
  const end = evs.find((e) => e.type === 'end');
  const total = segs.reduce((n, s) => n + s.samples.length, 0) + end.tail.length;
  check('long talk: segments + tail = whole utterance (no audio sent twice)', total === end.samples.length, `${total} vs ${end.samples.length}`);
}
// 3. a short fragment, a pause, then more speech: the provisional segment is retracted and merged
{
  const evs = run([[500, 'quiet'], [600, 'voice'], [300, 'quiet'], [1400, 'voice'], [700, 'quiet']]);
  check('fragment + more: retract then one merged segment', types(evs) === 'start segment0p retract0 segment0 end', types(evs));
  const seg = evs.filter((e) => e.type === 'segment').pop();
  check('merged segment holds both parts (≥ 2.2 s)', seg.samples.length / RATE >= 2.2, String(seg.samples.length / RATE));
}
// 4. end of speech comes at 500 ms silence now (was 700)
{
  const evs = run([[500, 'quiet'], [900, 'voice'], [480, 'quiet']]);
  check('no end before 500 ms of silence', !evs.some((e) => e.type === 'end'), types(evs));
  const evs2 = run([[500, 'quiet'], [900, 'voice'], [560, 'quiet']]);
  check('end at ~500 ms of silence', evs2.some((e) => e.type === 'end'), types(evs2));
}
// 5. a cough: dropped, any segment with it
{
  const evs = run([[500, 'quiet'], [200, 'voice'], [800, 'quiet']]);
  check('cough: start then drop', types(evs) === 'start drop', types(evs));
}

// ---- TTS chunking: the first chunk starts at a clause after ≥ 6 words ----
{
  const a = takeChunks('Sure, here it is', 0, false, true);
  check('first chunk: no cut at a comma before 6 words', a.chunks.length === 0, JSON.stringify(a.chunks));
  const b = takeChunks('You had about two thousand calories today, and protein was', 0, false, true);
  check('first chunk: cut at the comma after ≥ 6 words', b.chunks[0] === 'You had about two thousand calories today,', JSON.stringify(b.chunks));
  const c = takeChunks('Done. You had about two thousand calories today, and', 0, false, true);
  check('first chunk: an earlier sentence end still wins', c.chunks[0] === 'Done.', JSON.stringify(c.chunks));
  const d = takeChunks('אכלת היום בערך אלפיים קלוריות וחלבון, וזה', 0, false, true);
  check('first chunk: Hebrew clause', d.chunks[0] === 'אכלת היום בערך אלפיים קלוריות וחלבון,', JSON.stringify(d.chunks));
  const e = takeChunks('One two three four five six seven, eight nine', 0, false, false);
  check('later chunks: no clause cuts', e.chunks.length === 0, JSON.stringify(e.chunks));
}

// ---- time-stretch: shorter by the factor, pitch kept, no blow-ups ----
{
  const rate = 48000, f0 = 220, secs = 2;
  const x = Float32Array.from({ length: rate * secs }, (_, i) => 0.3 * Math.sin((2 * Math.PI * f0 * i) / rate));
  const t0 = performance.now();
  const y = timeStretch(x, rate, 1.12);
  const ms = performance.now() - t0;
  check('stretch: length / 1.12', Math.abs(y.length - Math.round(x.length / 1.12)) <= 1, `${y.length}`);
  let peak = 0, zc = 0;
  for (let i = 1; i < y.length; i++) { peak = Math.max(peak, Math.abs(y[i])); if ((y[i - 1] < 0) !== (y[i] < 0)) zc++; }
  const pitch = zc / 2 / (y.length / rate);
  check('stretch: pitch kept (zero crossings ≈ 220 Hz)', Math.abs(pitch - f0) < 8, pitch.toFixed(1));
  check('stretch: no clipping / NaN', peak <= 0.35 && !Number.isNaN(peak), String(peak));
  check('stretch: 1.0 returns the input', timeStretch(x, rate, 1) === x);
  check('stretch: fast enough (2 s of 48 kHz < 150 ms here)', ms < 150, `${ms.toFixed(0)} ms`);
}

if (fails.length) { console.error(`check-voice: ${fails.length} failed\n  ${fails.join('\n  ')}`); process.exit(1); }
console.log('check-voice: ok');
