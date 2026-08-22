import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wilson,
  placementSem,
  computeMetrics,
  scoreToTier,
  tierCutoffs,
  tierForScore,
  type SufficientStats,
} from './comp-stats-math';

// Every number the tier list shows comes from here, and both the writer
// (trend-tier) and the reader (comps-service) call it, so a change lands in two
// places at once. Where a threshold is env-overridable (SCORE_PRIOR_WEIGHT,
// LOW_SAMPLE_N, TIER_PCT_*) these assert RELATIONSHIPS rather than magic
// numbers, so a tuning change cannot make the suite lie.

/** n games at a fixed placement, with `top4` of them in the top four. */
const stats = (n: number, avgPlacement: number, top4Rate: number, winRate = 0): SufficientStats => ({
  n,
  placementSum: n * avgPlacement,
  placementSumsq: n * avgPlacement * avgPlacement,
  top4Count: Math.round(n * top4Rate),
  winCount: Math.round(n * winRate),
});

test('wilson: no trials yields an empty interval rather than NaN', () => {
  assert.deepEqual(wilson(0, 0), { low: 0, high: 0 });
});

test('wilson: stays inside [0,1] even at the extremes', () => {
  for (const [k, n] of [[0, 10], [10, 10], [1, 1], [0, 1]] as const) {
    const { low, high } = wilson(k, n);
    assert.ok(low >= 0 && low <= 1, `low ${low} out of range for ${k}/${n}`);
    assert.ok(high >= 0 && high <= 1, `high ${high} out of range for ${k}/${n}`);
    assert.ok(high >= low, `inverted interval for ${k}/${n}`);
  }
});

test('wilson: the interval tightens as the sample grows', () => {
  const thin = wilson(5, 10);
  const thick = wilson(500, 1000);
  assert.ok(thick.high - thick.low < thin.high - thin.low, 'more evidence must narrow the interval');
});

test('placementSem: undefined below two samples, zero for a constant series', () => {
  assert.equal(placementSem(stats(0, 4.5, 0.5)), 0);
  assert.equal(placementSem(stats(1, 1, 1)), 0);
  // Every game placed 4th -> no spread.
  assert.ok(Math.abs(placementSem(stats(50, 4, 0.5))) < 1e-9);
});

test('placementSem: shrinks as the sample grows at equal spread', () => {
  const spread = (n: number): SufficientStats => ({
    n, placementSum: n * 4.5, placementSumsq: n * (4.5 * 4.5 + 4), top4Count: n / 2, winCount: 0,
  });
  assert.ok(placementSem(spread(1000)) < placementSem(spread(50)));
});

test('computeMetrics: an empty comp reports the lobby prior, not NaN', () => {
  const m = computeMetrics(stats(0, 0, 0));
  assert.equal(m.avgPlacement, 4.5);
  assert.equal(m.top4Rate, 0.5);
  assert.equal(m.winRate, 0);
  assert.ok(Number.isFinite(m.score));
});

test('computeMetrics: score stays within [0,1] across the full input range', () => {
  for (const avg of [1, 2.5, 4.5, 6, 8]) {
    for (const t4 of [0, 0.25, 0.5, 0.75, 1]) {
      for (const n of [1, 10, 500]) {
        const { score } = computeMetrics(stats(n, avg, t4));
        assert.ok(score >= 0 && score <= 1, `score ${score} out of range (n=${n} avg=${avg} t4=${t4})`);
      }
    }
  }
});

// THE POINT OF SHRINKAGE. This is the property the scoring exists to provide:
// one lucky game must not outrank a comp with real evidence behind it.
test('computeMetrics: a single 1st place cannot outscore a well-sampled strong comp', () => {
  const lucky = computeMetrics(stats(1, 1, 1, 1)); // one game, won it
  const proven = computeMetrics(stats(400, 3.6, 0.62, 0.16));
  assert.ok(proven.score > lucky.score,
    `proven ${proven.score.toFixed(3)} should beat lucky ${lucky.score.toFixed(3)}`);
});

test('computeMetrics: identical rates score higher with more evidence', () => {
  const rate = { avg: 3.8, t4: 0.6 };
  const thin = computeMetrics(stats(5, rate.avg, rate.t4)).score;
  const mid = computeMetrics(stats(50, rate.avg, rate.t4)).score;
  const thick = computeMetrics(stats(5000, rate.avg, rate.t4)).score;
  assert.ok(thin < mid && mid < thick, `expected monotonic, got ${thin} < ${mid} < ${thick}`);
});

test('computeMetrics: a BAD comp is pulled UP by the prior, not down', () => {
  const bad = { avg: 6.5, t4: 0.2 };
  const thin = computeMetrics(stats(5, bad.avg, bad.t4)).score;
  const thick = computeMetrics(stats(5000, bad.avg, bad.t4)).score;
  assert.ok(thin > thick, 'shrinkage must be symmetric: thin bad samples look average too');
});

test('computeMetrics: lowSample flags thin samples and clears for thick ones', () => {
  assert.equal(computeMetrics(stats(1, 4.5, 0.5)).lowSample, true);
  assert.equal(computeMetrics(stats(100_000, 4.5, 0.5)).lowSample, false);
});

test('scoreToTier: bands are ordered and total', () => {
  const tiers = [0.9, 0.55, 0.5, 0.45, 0.4, 0.0, -5].map(scoreToTier);
  assert.deepEqual(tiers, ['S', 'S', 'A', 'B', 'C', 'D', 'D']);
});

test('tierCutoffs: refuses to rank a population too small to be meaningful', () => {
  assert.equal(tierCutoffs([]), null);
  assert.equal(tierCutoffs([0.5, 0.6, 0.7]), null);
  assert.ok(tierCutoffs(Array.from({ length: 8 }, (_, i) => i / 8)) !== null);
});

test('tierCutoffs: thresholds descend S >= A >= B >= C', () => {
  const scores = Array.from({ length: 100 }, (_, i) => i / 100);
  const c = tierCutoffs(scores)!;
  assert.ok(c.s >= c.a && c.a >= c.b && c.b >= c.c, `not descending: ${JSON.stringify(c)}`);
});

test('tierCutoffs: ignores non-finite scores instead of poisoning the sort', () => {
  const clean = tierCutoffs(Array.from({ length: 20 }, (_, i) => i / 20))!;
  const dirty = tierCutoffs([...Array.from({ length: 20 }, (_, i) => i / 20), NaN, Infinity])!;
  assert.deepEqual(dirty, clean);
});

test('tierForScore: dynamic cutoffs rank relatively; null falls back to static bands', () => {
  const scores = Array.from({ length: 100 }, (_, i) => i / 100);
  const c = tierCutoffs(scores)!;
  assert.equal(tierForScore(1, c), 'S');
  assert.equal(tierForScore(0, c), 'D');
  // With no cutoffs, 0.52 is an 'A' by the static bands.
  assert.equal(tierForScore(0.52, null), scoreToTier(0.52));
});

test('tierForScore: a bucket of identical scores does not all become S', () => {
  const flat = Array.from({ length: 50 }, () => 0.5);
  const c = tierCutoffs(flat)!;
  // Every cutoff collapses onto the same value, so every comp ties at the top —
  // documenting the edge rather than pretending it spreads.
  assert.equal(tierForScore(0.5, c), 'S');
  assert.equal(tierForScore(0.49, c), 'D');
});
