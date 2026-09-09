import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareStratified,
  fisherExact,
  stratifiedTest,
} from '../dist/ablate/stats.js';

const stratum = (key, bk, bn, ck, cn) => ({
  key,
  baseline: { k: bk, n: bn },
  candidate: { k: ck, n: cn },
});

const pool = (strata, pick) =>
  strata.reduce((acc, s) => ({ k: acc.k + pick(s).k, n: acc.n + pick(s).n }), { k: 0, n: 0 });

test('one informative task falls back to the exact test', () => {
  const strata = [stratum('only', 10, 10, 2, 10)];
  const { pValue, informativeStrata } = stratifiedTest(strata);

  assert.equal(informativeStrata, 1);
  // Not merely close: with a single stratum the permutation null is Fisher's,
  // so the closed form is used and there is no Monte Carlo error at all.
  assert.equal(pValue, fisherExact({ k: 10, n: 10 }, { k: 2, n: 10 }));
});

test('tasks where every trial went the same way carry no information', () => {
  const strata = [
    stratum('all-pass', 6, 6, 6, 6),
    stratum('all-fail', 0, 6, 0, 6),
    stratum('real', 6, 6, 1, 6),
  ];
  assert.equal(stratifiedTest(strata).informativeStrata, 1);
});

test('stratifying recovers power that pooling throws away', () => {
  // Two easy tasks and two hard ones. The rule helps a little on every one of
  // them, but pooled together the gap between easy and hard swamps the effect.
  const strata = [
    stratum('easy-1', 6, 6, 5, 6),
    stratum('easy-2', 6, 6, 5, 6),
    stratum('hard-1', 1, 6, 0, 6),
    stratum('hard-2', 1, 6, 0, 6),
  ];

  const pooled = fisherExact(
    pool(strata, (s) => s.baseline),
    pool(strata, (s) => s.candidate),
  );
  const { pValue } = stratifiedTest(strata);

  assert.ok(pValue < pooled, `stratified ${pValue} should beat pooled ${pooled}`);
  // Every stratum can only move the statistic by +-0.5 and all four moved the
  // same way, so the two-tailed answer is 2 / 2^4.
  assert.ok(Math.abs(pValue - 0.125) < 0.02, `expected ~0.125, got ${pValue}`);
  assert.ok(pooled > 0.3, `pooled should be uninformative here, got ${pooled}`);
});

test('a consistent effect across many tasks reaches significance', () => {
  const strata = Array.from({ length: 8 }, (_, i) => stratum(`t${i}`, 3, 3, 0, 3));
  const { pValue } = compareStratified(strata);
  assert.ok(pValue < 0.01, `expected a small p-value, got ${pValue}`);
});

test('no effect anywhere is not significant', () => {
  const strata = Array.from({ length: 6 }, (_, i) => stratum(`t${i}`, 2, 4, 2, 4));
  const cmp = compareStratified(strata);
  assert.equal(cmp.verdict, 'inconclusive');
  assert.ok(cmp.pValue > 0.5, `got ${cmp.pValue}`);
});

test('direction is read from the stratified statistic', () => {
  const worse = compareStratified(
    Array.from({ length: 8 }, (_, i) => stratum(`t${i}`, 3, 3, 0, 3)),
  );
  assert.equal(worse.verdict, 'worse');
  assert.ok(worse.diff < 0);

  const better = compareStratified(
    Array.from({ length: 8 }, (_, i) => stratum(`t${i}`, 0, 3, 3, 3)),
  );
  assert.equal(better.verdict, 'better');
  assert.ok(better.diff > 0);
});

test('the p-value is reproducible across calls', () => {
  const strata = [
    stratum('a', 5, 6, 3, 6),
    stratum('b', 4, 6, 2, 6),
    stratum('c', 6, 6, 4, 6),
  ];
  const first = stratifiedTest(strata).pValue;
  const second = stratifiedTest(strata).pValue;
  assert.equal(first, second, 'the same data must give the same p-value');
});

test('a resampled p-value never claims more resolution than it has', () => {
  const strata = Array.from({ length: 12 }, (_, i) => stratum(`t${i}`, 4, 4, 0, 4));
  const { pValue } = stratifiedTest(strata, { resamples: 999 });
  assert.ok(pValue >= 1 / 1000, `p-value ${pValue} is below the resolution of the test`);
});

test('no informative task at all is reported as no evidence', () => {
  const { pValue, informativeStrata } = stratifiedTest([stratum('x', 4, 4, 4, 4)]);
  assert.equal(informativeStrata, 0);
  assert.equal(pValue, 1);
});
