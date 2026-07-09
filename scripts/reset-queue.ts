import { makeQueue, QUEUE } from '../src/server/queue/queues';


const ma = makeQueue(QUEUE.matchFetch);
await ma.obliterate({ force: true });
await ma.close();
console.log('match-fetch queue cleared');

const c = makeQueue(QUEUE.ladderCrawl);
await c.obliterate({ force: true });
await c.close();
console.log('ladder-crawl queue cleared');

const cl = makeQueue(QUEUE.cluster);
await cl.obliterate({ force: true });
await cl.close();
console.log('cluster queue cleared');

const r = makeQueue(QUEUE.rollup);
await r.obliterate({ force: true });
await r.close();
console.log('rollup queue cleared');

const me = makeQueue(QUEUE.merge);
await me.obliterate({ force: true });
await me.close();
console.log('merge queue cleared');

const t = makeQueue(QUEUE.trendTier);
await t.obliterate({ force: true });
await t.close();
console.log('trend-tier queue cleared');

process.exit(0);