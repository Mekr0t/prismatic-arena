export interface RateWindow {
  /** Max requests allowed within `intervalMs`. */
  limit: number;
  intervalMs: number;
}

// Standard Riot DEVELOPMENT-key ceiling, enforced per host (region):
//   20 requests / 1s  AND  100 requests / 2min.
// With a production key these become higher, per-method, and are reported in
// response headers — read them and reconfigure rather than hardcoding.
export const DEV_APP_WINDOWS: RateWindow[] = [
  { limit: 20, intervalMs: 1_000 },
  { limit: 100, intervalMs: 120_000 },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sliding-window-log limiter with a priority queue in front of it.
 *
 * Single-process only: it tracks request timestamps in memory. When you add
 * worker processes in Phase 3, ALL processes must share one budget — swap this
 * for a Redis-backed limiter (e.g. `bottleneck` with clustering, or a Lua
 * sliding-window script) so the crawl and the web app don't each spend 20/s.
 */
export class SlidingWindowQueue {
  private hits: number[] = []; // ascending request timestamps (ms)
  private waiters: { priority: number; seq: number; resolve: () => void }[] = [];
  private draining = false;
  private seq = 0;
  private readonly maxIntervalMs: number;

  constructor(private readonly windows: RateWindow[]) {
    this.maxIntervalMs = Math.max(...windows.map((w) => w.intervalMs));
  }

  /** Resolves when the caller is allowed to make one request. */
  acquire(priority = 0): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push({ priority, seq: this.seq++, resolve });
      // Highest priority first; FIFO within the same priority level.
      this.waiters.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      void this.drain();
    });
  }

  private prune(now: number): void {
    const cutoff = now - this.maxIntervalMs;
    let i = 0;
    while (i < this.hits.length && this.hits[i] <= cutoff) i++;
    if (i > 0) this.hits.splice(0, i);
  }

  /** Milliseconds to wait before the next request is allowed across all windows. */
  private waitMs(now: number): number {
    let wait = 0;
    const len = this.hits.length;
    for (const w of this.windows) {
      const cutoff = now - w.intervalMs;
      let count = 0;
      for (let i = len - 1; i >= 0 && this.hits[i] > cutoff; i--) count++;
      if (count >= w.limit) {
        // The (limit)-th most recent hit must expire before a slot frees.
        const freesAt = this.hits[len - w.limit] + w.intervalMs;
        wait = Math.max(wait, freesAt - now);
      }
    }
    return wait;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.waiters.length > 0) {
        const now = Date.now();
        this.prune(now);
        const wait = this.waitMs(now);
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        const next = this.waiters.shift()!;
        this.hits.push(Date.now());
        next.resolve();
      }
    } finally {
      this.draining = false;
    }
  }
}
