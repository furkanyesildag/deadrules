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
 *
 * This is a normal-approximation figure while the tests actually used here are
 * exact and discrete, and discrete tests are conservative -- they spend some of
 * their significance budget on outcomes that cannot occur. So the true
 * detectable effect is somewhat larger than this returns. Treat it as an
 * optimistic bound, which is why the report words it as "about".
 */
export function effectiveArmSize(n1: number, n2: number): number {
  // Harmonic mean: an unequal comparison is only as powerful as its smaller
  // arm allows. Feeding a deep baseline's own count into the power formula
  // would advertise a sensitivity the comparison does not have.
  if (n1 <= 0 || n2 <= 0) return 0;
  return 2 / (1 / n1 + 1 / n2);
}

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

/** One task's 2x2 table: how each arm did on that task alone. */
export interface Stratum {
  key: string;
  baseline: Proportion;
  candidate: Proportion;
}

/** Deterministic RNG, so a p-value does not move between runs on the same data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StratumTable {
  /** Baseline passes: the cell the statistic is built on. */
  a: number;
  n1: number; // baseline trials
  n2: number; // candidate trials
  m1: number; // passes across both arms
  total: number;
  expected: number;
  /** Cumulative hypergeometric distribution of `a` under the null. */
  cdf: number[];
  /** Smallest value `a` can take given the margins. */
  lo: number;
}

function tableOf(s: Stratum): StratumTable | null {
  const n1 = s.baseline.n;
  const n2 = s.candidate.n;
  const total = n1 + n2;
  const m1 = s.baseline.k + s.candidate.k;
  // A task nobody ran, or one where every trial went the same way, carries no
  // information about the rules: its table has zero variance and drops out.
  if (n1 === 0 || n2 === 0 || m1 === 0 || m1 === total) return null;

  const lo = Math.max(0, m1 - n2);
  const hi = Math.min(n1, m1);
  const cdf: number[] = [];
  let acc = 0;
  const logDenom = logChoose(total, n1);
  for (let a = lo; a <= hi; a++) {
    acc += Math.exp(logChoose(m1, a) + logChoose(total - m1, n1 - a) - logDenom);
    cdf.push(Math.min(1, acc));
  }
  return { a: s.baseline.k, n1, n2, m1, total, expected: (n1 * m1) / total, cdf, lo };
}

function sampleA(t: StratumTable, u: number): number {
  for (let i = 0; i < t.cdf.length; i++) if (u <= (t.cdf[i] ?? 1)) return t.lo + i;
  return t.lo + t.cdf.length - 1;
}

/**
 * Mantel-Haenszel test of the rule's effect, stratified by task.
 *
 * Trials are not exchangeable: they cluster inside tasks, because a task is
 * easy or hard regardless of which rules were in play. Pooling every trial into
 * one 2x2 table lets that between-task spread masquerade as variance in the
 * rule's effect, which both misstates the p-value and throws away power that
 * costs nothing to keep -- comparing each task only against itself removes task
 * difficulty from the comparison entirely.
 *
 * The null distribution is sampled rather than approximated: at three trials
 * per task per arm the chi-square limit that the usual CMH test relies on has
 * nothing to stand on, whereas the margins of each stratum are fixed, so `a`
 * is hypergeometric and can be drawn exactly.
 */
export function stratifiedTest(
  strata: Stratum[],
  opts: { resamples?: number; seed?: number } = {},
): { pValue: number; statistic: number; informativeStrata: number } {
  const tables = strata.map(tableOf).filter((t): t is StratumTable => t !== null);
  if (tables.length === 0) return { pValue: 1, statistic: 0, informativeStrata: 0 };

  // With a single informative task there is nothing to stratify over, and the
  // permutation null is exactly Fisher's, so use the closed form and skip the
  // Monte Carlo error.
  if (tables.length === 1) {
    const only = strata.find((s) => tableOf(s) !== null);
    const t = tables[0] as StratumTable;
    return {
      pValue: only ? fisherExact(only.baseline, only.candidate) : 1,
      statistic: t.a - t.expected,
      informativeStrata: 1,
    };
  }

  const observed = tables.reduce((sum, t) => sum + (t.a - t.expected), 0);
  const resamples = opts.resamples ?? 20_000;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const target = Math.abs(observed) - 1e-9;

  let atLeastAsExtreme = 0;
  for (let i = 0; i < resamples; i++) {
    let s = 0;
    for (const t of tables) s += sampleA(t, rand()) - t.expected;
    if (Math.abs(s) >= target) atLeastAsExtreme++;
  }

  // The +1s keep the p-value away from zero: a resampled test can never prove
  // more than its own resolution, which is 1/(B+1).
  return {
    pValue: (atLeastAsExtreme + 1) / (resamples + 1),
    statistic: observed,
    informativeStrata: tables.length,
  };
}

/**
 * Compares two arms across tasks, stratifying by task.
 *
 * The reported rate and difference stay pooled, because that is the number a
 * reader can check against the trial counts printed beside it; only the
 * p-value comes from the stratified test.
 */
export function compareStratified(
  strata: Stratum[],
  alpha = 0.05,
  opts: { resamples?: number; seed?: number } = {},
): Comparison {
  const pool = (pick: (s: Stratum) => Proportion): Proportion =>
    strata.reduce((acc, s) => ({ k: acc.k + pick(s).k, n: acc.n + pick(s).n }), { k: 0, n: 0 });

  const baseline = pool((s) => s.baseline);
  const candidate = pool((s) => s.candidate);
  const { pValue, statistic } = stratifiedTest(strata, opts);

  // Direction comes from the stratified statistic, not the pooled rates: a
  // positive statistic means the baseline passed more often than the fixed
  // margins predict, so removing the rule hurt.
  const significant = pValue < alpha;
  const direction = statistic > 0 ? 'worse' : 'better';
  return {
    baseline,
    candidate,
    diff: rate(candidate) - rate(baseline),
    pValue,
    verdict: significant ? direction : 'inconclusive',
  };
}
