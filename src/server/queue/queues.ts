import { Queue } from 'bullmq';
import { bullConnection } from './connection';

// One queue per pipeline stage so each tunes concurrency, retries, and
// backpressure independently — ladder-crawl enqueues match IDs, match-fetch
// consumes them, and so on. These names double as ingestion_jobs.job_type
// values. 2a runs only the demo queue; 2b adds the stage workers.
export const QUEUE = {
  ladderCrawl: 'ladder-crawl',
  matchFetch: 'match-fetch',
  cluster: 'cluster',
  rollup: 'rollup',
  merge: 'merge',
  trendTier: 'trend-tier',
  elect: 'elect',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Construct a Queue (producer) bound to the shared BullMQ connection. */
export function makeQueue(name: string): Queue {
  return new Queue(name, { connection: bullConnection });
}
