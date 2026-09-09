/**
 * Small-sample statistics for pass-rate comparisons.
 *
 * Every number a deadrules run produces comes from a handful of trials, so the
 * honest default is "no evidence of a difference", not "no difference". These
 * helpers exist to keep that distinction visible in the report.
 */

export interface Proportion {
  /** Trials that passed. */
  k: number;
  /** Trials that ran. Excluded trials are never counted here. */
  n: number;
}

export interface Interval {
  lo: number;
  hi: number;
}

export type Verdict = 'better' | 'worse' | 'inconclusive';

export interface Comparison {
  baseline: Proportion;
  candidate: Proportion;
  /** candidate rate minus baseline rate. */
  diff: number;
  pValue: number;
  /** Set once false-discovery correction has run across a family of tests. */
  qValue?: number;
  verdict: Verdict;
}

export function rate(p: Proportion): number {
  return p.n === 0 ? 0 : p.k / p.n;
}

/**
 * Wilson score interval. Preferred over the normal approximation because it
 * stays inside [0, 1] and behaves at n = 3, which is the common case here.
 */
export function wilson(p: Proportion, z = 1.96): Interval {
  if (p.n === 0) return { lo: 0, hi: 1 };
  const phat = p.k / p.n;
  const z2 = z * z;
  const denom = 1 + z2 / p.n;
  const centre = phat + z2 / (2 * p.n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * p.n)) / p.n);
  return {
    lo: Math.max(0, (centre - margin) / denom),
    hi: Math.min(1, (centre + margin) / denom),
  };
}

const logFactorialCache = [0, 0];

function logFactorial(n: number): number {
  for (let i = logFactorialCache.length; i <= n; i++) {
    logFactorialCache[i] = (logFactorialCache[i - 1] ?? 0) + Math.log(i);
  }
  return logFactorialCache[n] ?? 0;
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * Two-tailed Fisher exact test on the 2x2 table of pass/fail by variant.
 *
 * Chosen over a chi-square or normal approximation because trial counts here
 * are routinely below the threshold where those approximations mean anything.
 */
export function fisherExact(a: Proportion, b: Proportion): number {
  const rowA = a.n;
  const rowB = b.n;
  const total = rowA + rowB;
  if (rowA === 0 || rowB === 0) return 1;

  const successes = a.k + b.k;
  const logDenom = logChoose(total, successes);

  const observed = logChoose(rowA, a.k) + logChoose(rowB, successes - a.k) - logDenom;
  const threshold = observed + 1e-9;

  let p = 0;
  const lo = Math.max(0, successes - rowB);
  const hi = Math.min(rowA, successes);
  for (let i = lo; i <= hi; i++) {
    const logP = logChoose(rowA, i) + logChoose(rowB, successes - i) - logDenom;
    if (logP <= threshold) p += Math.exp(logP);
  }
  return Math.min(1, p);
}

export function compare(baseline: Proportion, candidate: Proportion, alpha = 0.05): Comparison {
  const pValue = fisherExact(baseline, candidate);
  const diff = rate(candidate) - rate(baseline);
  const significant = pValue < alpha;
  return {
    baseline,
    candidate,
    diff,
    pValue,
    verdict: significant ? (diff > 0 ? 'better' : 'worse') : 'inconclusive',
  };
}

/**
 * Benjamini-Hochberg false-discovery correction.
 *
 * Ablating 40 rules means 40 simultaneous tests; without this, two of them come
 * back "significant" by chance alone and the headline number is a lie.
 */
export function adjustFdr<T extends { pValue: number }>(
  tests: T[],
  alpha = 0.05,
): (T & { qValue: number; significant: boolean })[] {
  const m = tests.length;
  if (m === 0) return [];

  const ordered = tests
    .map((t, index) => ({ t, index }))
    .sort((x, y) => x.t.pValue - y.t.pValue);

  // Walk from the largest p-value down so each q stays monotone.
  const q = new Array<number>(m).fill(1);
  let running = 1;
  for (let i = m - 1; i >= 0; i--) {
    const raw = ((ordered[i]?.t.pValue ?? 1) * m) / (i + 1);
    running = Math.min(running, raw);
    q[i] = Math.min(1, running);
  }

  const out = new Array<T & { qValue: number; significant: boolean }>(m);
  ordered.forEach((entry, i) => {
    const qValue = q[i] ?? 1;
    out[entry.index] = { ...entry.t, qValue, significant: qValue < alpha };
  });
  return out;
}

/**
 * The smallest pass-rate difference this many trials could have detected, at
 * 80% power and alpha 0.05. Reported alongside every inconclusive result so a
 * null finding can be read for what it is: a limit of the budget, not proof.
 */
export function minDetectableEffect(nPerArm: number, baselineRate = 0.5): number {
  if (nPerArm <= 0) return 1;
  const zAlpha = 1.96;
  const zBeta = 0.84;
  // The variance term collapses to zero at a rate of 0 or 1, which would claim
  // an arbitrarily small effect is detectable from a handful of trials. A
  // baseline that passed 5 of 5 is not evidence that the true rate is exactly
  // 1, so the rate is clamped before it reaches the boundary.
  const clamped = Math.min(0.9, Math.max(0.1, baselineRate));
  const variance = 2 * clamped * (1 - clamped);
  const delta = ((zAlpha + zBeta) * Math.sqrt(variance)) / Math.sqrt(nPerArm);
  return Math.min(1, delta);
}
