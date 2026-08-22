// instrumentation.ts — Next's one guaranteed server-startup hook. `register()`
// runs once when the server boots, which is the only place in the App Router
// where "check this before serving anything" is actually possible: there is no
// other module every request path is guaranteed to import first.
//
// Node runtime only. The Edge runtime has neither the Postgres nor the Redis
// connection this validates, so asserting there would fail for the wrong reason.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertEnv } = await import('@/config/env');
  assertEnv('web');
}
