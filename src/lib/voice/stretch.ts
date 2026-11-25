// Pitch-preserving time-stretch for speech (WSOLA: waveform-similarity overlap-add). Used when the TTS model has no
// speed parameter (eleven-v4-turbo): the server says how much faster to play (X-Tapin-Speed) and the player stretches
// the decoded audio before scheduling it. Plain playbackRate would raise the pitch (chipmunk voice).
// Pure (no Web Audio), so it runs in tests on generated buffers. Cost: ~8 M multiply-adds per second of 48 kHz audio
// with the decimated search below, i.e. a few tens of ms for a sentence on a phone.

const FRAME_MS = 30;
const SEARCH_MS = 8;

/** speed > 1 = faster/shorter. Returns the input itself when there is nothing to do. */
export function timeStretch(x: Float32Array, rate: number, speed: number): Float32Array {
  if (!(speed > 0) || Math.abs(speed - 1) < 0.01 || x.length < rate * 0.1) return x;
  const N = Math.max(64, Math.round((rate * FRAME_MS) / 1000));
  const Hs = N >> 1; // synthesis hop: 50 % overlap
  const Ha = Hs * speed; // analysis hop (fractional: no drift over long buffers)
  const tol = Math.round((rate * SEARCH_MS) / 1000);
  const L = N - Hs; // overlap length compared when searching
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const outLen = Math.round(x.length / speed);
  const y = new Float32Array(outLen + N);
  const w = new Float32Array(outLen + N);
  const sampleStep = rate > 30000 ? 3 : 2; // decimated correlation: plenty for speech periods
  let prev = 0; // where in x the previous frame started
  for (let m = 0, out = 0; out < outLen; m++, out += Hs) {
    let start = Math.round(m * Ha);
    if (m > 0) {
      // the natural continuation of the previous frame is x[prev + Hs ...]; pick the start near the nominal position
      // whose waveform matches it best, so frames overlap in phase (no warble)
      const ref = prev + Hs;
      let best = -Infinity, bestD = 0;
      for (let d = -tol; d <= tol; d += 2) {
        const s = start + d;
        if (s < 0 || s + L >= x.length || ref + L >= x.length) continue;
        let c = 0;
        for (let i = 0; i < L; i += sampleStep) c += x[ref + i] * x[s + i];
        if (c > best) { best = c; bestD = d; }
      }
      start = Math.max(0, start + bestD);
    }
    if (start >= x.length) break;
    for (let i = 0; i < N && start + i < x.length; i++) { y[out + i] += x[start + i] * win[i]; w[out + i] += win[i]; }
    prev = start;
  }
  for (let i = 0; i < outLen; i++) if (w[i] > 1e-3) y[i] /= w[i];
  return y.subarray(0, outLen);
}
