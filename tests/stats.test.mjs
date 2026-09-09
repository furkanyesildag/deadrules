import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adjustFdr,
  compare,
  fisherExact,
  minDetectableEffect,
  wilson,
} from '../dist/ablate/stats.js';

const close = (actual, expected, tol, what) =>
  assert.ok(
    Math.abs(actual - expected) < tol,
    `${what}: expected ~${expected}, got ${actual}`,
  );

test("Fisher exact matches Fisher's own tea-tasting table", () => {
  // 3/4 vs 1/4 successes: the textbook two-tailed answer is 0.4857.
  const p = fisherExact({ k: 3, n: 4 }, { k: 1, n: 4 });
  close(p, 0.4857, 0.001, 'tea tasting');
});

test('Fisher exact on a perfectly separated table', () => {
  // 10/10 vs 0/10 has exactly 2 / C(20,10) of the probability mass.
  const p = fisherExact({ k: 10, n: 10 }, { k: 0, n: 10 });
  close(p, 2 / 184756, 1e-9, 'perfect separation');
});

test('identical proportions are never significant', () => {
  assert.equal(fisherExact({ k: 5, n: 10 }, { k: 5, n: 10 }), 1);
});

test('three trials cannot separate anything, which is the point', () => {
  // A clean 3/3 against 0/3 is still p = 0.1: the default budget is honest
  // about being unable to call a single-rule effect on its own.
  const p = fisherExact({ k: 3, n: 3 }, { k: 0, n: 3 });
  close(p, 0.1, 1e-9, 'n=3 separation');
  assert.equal(compare({ k: 3, n: 3 }, { k: 0, n: 3 }).verdict, 'inconclusive');
});

test('Wilson interval for zero successes stays inside the unit interval', () => {
  const ci = wilson({ k: 0, n: 10 });
  assert.equal(ci.lo, 0);
  close(ci.hi, 0.2775, 0.001, 'wilson upper');
});

test('Wilson interval narrows as trials accumulate', () => {
  const few = wilson({ k: 5, n: 10 });
  const many = wilson({ k: 50, n: 100 });
  assert.ok(many.hi - many.lo < few.hi - few.lo);
});

test('compare reports direction as well as significance', () => {
  const worse = compare({ k: 10, n: 10 }, { k: 0, n: 10 });
  assert.equal(worse.verdict, 'worse');
  close(worse.diff, -1, 1e-9, 'diff');

  const better = compare({ k: 0, n: 10 }, { k: 10, n: 10 });
  assert.equal(better.verdict, 'better');
});

test('Benjamini-Hochberg rejects only the two smallest p-values here', () => {
  const ps = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205];
  const out = adjustFdr(ps.map((pValue) => ({ pValue })), 0.05);

  assert.equal(out.filter((o) => o.significant).length, 2);
  close(out[0].qValue, 0.008, 1e-9, 'q1');
  close(out[1].qValue, 0.032, 1e-9, 'q2');
  close(out[2].qValue, 0.0672, 1e-9, 'q3');
});

test('correction preserves input order and never lowers a p-value', () => {
  const ps = [0.4, 0.01, 0.9, 0.02];
  const out = adjustFdr(ps.map((pValue) => ({ pValue })), 0.05);
  assert.deepEqual(out.map((o) => o.pValue), ps);
  for (const o of out) assert.ok(o.qValue >= o.pValue - 1e-12, `q ${o.qValue} < p ${o.pValue}`);
});

test('q-values are monotone in p', () => {
  const ps = [0.001, 0.01, 0.02, 0.03, 0.5];
  const out = adjustFdr(ps.map((pValue) => ({ pValue })), 0.05);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].qValue >= out[i - 1].qValue - 1e-12);
  }
});

test('an empty family of tests is not an error', () => {
  assert.deepEqual(adjustFdr([], 0.05), []);
});

test('a perfect baseline does not claim a zero detectable effect', () => {
  // 5/5 is not proof the true rate is 1, so the estimate must stay meaningful.
  const mde = minDetectableEffect(5, 1);
  assert.ok(mde > 0.2, `expected a real threshold, got ${mde}`);
  assert.ok(mde <= 1);
  // Both boundaries clamp to the same distance from 0.5, so they agree.
  close(minDetectableEffect(5, 1), minDetectableEffect(5, 0), 1e-12, 'boundary symmetry');
});

test('the detectable effect shrinks as trials are added', () => {
  assert.ok(minDetectableEffect(9) > minDetectableEffect(36));
  assert.ok(minDetectableEffect(36) > minDetectableEffect(144));
  assert.ok(minDetectableEffect(0) === 1);
});
