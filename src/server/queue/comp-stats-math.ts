// comp-stats-math.ts — pure statistics over comp_stats sufficient stats. Used by
// the trend-tier stage to score and tier comps on write, and reused by the M5
// read path to recompute the same metrics/intervals on demand — so a method
// change here updates both at once, with no re-rollup. Nothing here touches the
// DB. This (plus the band cutoffs) is the tuning surface.
//
// Scoring uses SHRINKAGE toward the lobby-average prior: a comp's rate is pulled
// toward average by k/(n+k), fading as n grows, so a thin sample can't post a
// flashy score. Honest 95% intervals are computed for hover tooltips.

export interface SufficientStats {
  n: number;
  placementSum: number; // sum placement
  placementSumsq: number; // sum placement^2
  top4Count: number;
  winCount: number;
}

export interface Interval {
  low: number;
  high: number;
}

export interface CompMetrics {
  n: number;
  avgPlacement: number;
  top4Rate: number;
  winRate: number;
  placementSem: number;
  placementCi95: Interval; // honest display width for avg placement
  top4Ci95: Interval; // honest display width for top-4 rate (Wilson)
  score: number; // tier score in ~[0,1]; shrinks toward 0.5 for thin samples
  lowSample: boolean; // simple n-below-threshold flag (UI may mute)
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// z for the *displayed* intervals — 95%, the honest width shown in the UI.
const Z_DISPLAY = 1.96;
// Tier-score weights (sum to 1). Placement and top-4 capture different things.
const W_PLACEMENT = 0.5;
const W_TOP4 = 0.5;

// Lobby-average priors (8-player): mean placement 4.5, top-4 rate exactly 0.5.
const PRIOR_PLACEMENT = 4.5;
const PRIOR_TOP4 = 0.5;
// Shrinkage strength, in pseudo-games. Higher = small samples held down harder
// (a comp needs ~k real games before its own rate outweighs the prior). Default
// 40: a 9-game comp is pulled ~80% back to average; a 100+-game comp barely moves.
const SCORE_PRIOR_WEIGHT = num(process.env.SCORE_PRIOR_WEIGHT, 40);
// Comps below this n are flagged low-sample (UI may mute) — derived on read.
const LOW_SAMPLE_N = num(process.env.LOW_SAMPLE_N, 30);

// Absolute score -> tier bands, ordered high to low. SEED VALUES — calibrate
// against the generated tier list once there's volume to spread (a thin sample
// shrinks everything toward 0.5, so bands can't be tuned on it).
const TIER_BANDS: ReadonlyArray<{ tier: string; min: number }> = [
  { tier: 'S', min: 0.55 },
  { tier: 'A', min: 0.5 },
  { tier: 'B', min: 0.45 },
  { tier: 'C', min: 0.4 },
  { tier: 'D', min: Number.NEGATIVE_INFINITY },
];

/** Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = Z_DISPLAY): Interval {
  if (n <= 0) return { low: 0, high: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** Standard error of the mean placement from sufficient stats. */
export function placementSem(s: SufficientStats): number {
  if (s.n < 2) return 0;
  const mean = s.placementSum / s.n;
  // sample variance, guarded against a tiny negative from float error
  const variance = Math.max(0, (s.placementSumsq - s.n * mean * mean) / (s.n - 1));
  return Math.sqrt(variance / s.n);
}

/** Full derived metric set + tier score from sufficient stats. */
export function computeMetrics(s: SufficientStats): CompMetrics {
  const n = s.n;
  const avgPlacement = n > 0 ? s.placementSum / n : PRIOR_PLACEMENT;
  const top4Rate = n > 0 ? s.top4Count / n : PRIOR_TOP4;
  const winRate = n > 0 ? s.winCount / n : 0;
  const sem = placementSem(s);

  const placementCi95: Interval = {
    low: avgPlacement - Z_DISPLAY * sem,
    high: avgPlacement + Z_DISPLAY * sem,
  };
  const top4Ci95 = wilson(s.top4Count, n, Z_DISPLAY);

  // Shrink both rates toward the lobby-average prior; weight fades as n grows.
  const w = n / (n + SCORE_PRIOR_WEIGHT);
  const shrunkPlacement = w * avgPlacement + (1 - w) * PRIOR_PLACEMENT;
  const shrunkTop4 = w * top4Rate + (1 - w) * PRIOR_TOP4;
  const placementGoodness = clamp01((8 - shrunkPlacement) / 7);
  const score = W_PLACEMENT * placementGoodness + W_TOP4 * shrunkTop4;

  return {
    n,
    avgPlacement,
    top4Rate,
    winRate,
    placementSem: sem,
    placementCi95,
    top4Ci95,
    score,
    lowSample: n < LOW_SAMPLE_N,
  };
}

/** Map a tier score to its S/A/B/C/D band. */
export function scoreToTier(score: number): string {
  for (const b of TIER_BANDS) if (score >= b.min) return b.tier;
  return 'D';
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}