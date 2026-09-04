// worker-now.ts — start the worker AND kick the pipeline immediately.
//
// `npm run worker` waits for the scheduler's next tick, which is
// SCHED_PIPELINE_MIN away (60 minutes here). This sets the boot flag the worker
// already understands and then hands off to it, so a change can be seen now
// rather than on the hour.
//
// A file rather than an inline env prefix because the prefix form differs per
// shell: `RUN_CLUSTER=1 npm run worker` is a parse error in PowerShell, and
// `$env:RUN_CLUSTER=1; ...` means nothing to bash. This works in both, and adds
// no dependency to do it.
//
// Only the HEAD is kicked. The chain advances the rest on success, so this runs
// cluster → rollup → merge → trend-tier → elect exactly as a scheduled tick
// would — not a special path that could behave differently from the real one.
export {}; // makes this a module, so the top-level await below is legal

process.env.RUN_CLUSTER = '1';
if (process.env.PIPELINE_SET) process.env.CLUSTER_SET = process.env.PIPELINE_SET;

await import('../src/server/queue/worker');
