// Statistics helpers. Listed in docs/SPEC.md → "Science sources".

/** Welch's unequal-variances t-test (Welch 1947, Biometrika 34(1–2):28–35), two-sided.
 *  df by the Welch–Satterthwaite equation; p from Student's t via the regularized incomplete beta. */
export function welch(a: number[], b: number[]) {
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const variance = (x: number[], m: number) => x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
  const ma = mean(a), mb = mean(b), va = variance(a, ma), vb = variance(b, mb);
  const se2 = va / a.length + vb / b.length;
  if (se2 === 0) return { t: 0, df: a.length + b.length - 2, p: 1, meanDiff: mb - ma };
  const t = (mb - ma) / Math.sqrt(se2);
  const df = se2 ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1));
  const p = betaInc(df / 2, 0.5, df / (df + t * t)); // two-sided p = I_{df/(df+t²)}(df/2, 1/2)
  return { t, df, p, meanDiff: mb - ma };
}

/** Regularized incomplete beta I_x(a,b), continued fraction (Numerical Recipes, 3rd ed., §6.4). */
function betaInc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b + lbeta);
  if (x < (a + 1) / (a + b + 2)) return (front * cf(a, b, x)) / a;
  return 1 - (front * cf(b, a, 1 - x)) / b;
}
function cf(a: number, b: number, x: number) {
  const tiny = 1e-30; let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny; d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
/** log Γ(x), Lanczos approximation (g=7, n=9). */
function lgamma(x: number): number {
  const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let s = g[0];
  for (let i = 1; i < 9; i++) s += g[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}
