// env.ts — one place that answers "is this process actually configured?", and
// says so AT BOOT rather than at the first request that needs the value.
//
// The old arrangement was three ad-hoc `NODE_ENV === 'production'` throws in
// lib/db, lib/redis and lib/riot/client, and NOTHING for the admin secrets. So
// a deployment missing ADMIN_SESSION_SECRET started fine and then failed per
// request inside getSecret(), while a missing ADMIN_PASSWORD was worse still:
// passwordMatches() logged to console and returned false, which reads exactly
// like "wrong password" to whoever is trying to log in.
//
// Two tiers, deliberately:
//
//   FATAL   the variable is absent, or still holds the literal placeholder from
//           .env.example. Neither is ever intentional, so both throw — with
//           EVERY problem listed at once, not just the first one, because
//           fixing config one restart at a time is miserable.
//   WARN    the value is present and plausible but weak or oddly shaped. These
//           are judgement calls about someone else's deployment, so they are
//           reported and never fatal.
//
// The point-of-use guards in lib/* stay: scripts import those modules directly
// without going through a boot path, so they are the backstop for that case.

export type Runtime = 'web' | 'worker';

interface Requirement {
  name: string;
  runtimes: Runtime[];
  /** What breaks without it — shown verbatim in the failure message. */
  why: string;
  /** The literal .env.example value, if leaving it unedited is a real risk. */
  placeholder?: string;
  /** Present-but-questionable check. Returns a warning string, or null. */
  suspect?: (value: string) => string | null;
}

const REQUIRED: Requirement[] = [
  {
    name: 'DATABASE_URL',
    runtimes: ['web', 'worker'],
    why: 'Postgres connection string. Nothing reads or writes without it.',
    suspect: (v) =>
      /^postgres(ql)?:\/\//.test(v) ? null : 'does not look like a postgres:// URL',
  },
  {
    name: 'REDIS_URL',
    runtimes: ['web', 'worker'],
    why: 'Redis connection string. Backs the Riot cache, the rate limiter and every BullMQ queue.',
    suspect: (v) => (/^rediss?:\/\//.test(v) ? null : 'does not look like a redis:// URL'),
  },
  {
    name: 'RIOT_API_KEY',
    runtimes: ['web', 'worker'],
    why: 'Riot API key. The crawler and the profile page both spend it.',
    placeholder: 'RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    suspect: (v) =>
      v.startsWith('RGAPI-') ? null : 'does not start with RGAPI- (Riot keys do)',
  },
  {
    name: 'ADMIN_PASSWORD',
    runtimes: ['web'],
    why: 'The single admin password. Without it login is disabled and every attempt reads as "wrong password".',
    placeholder: 'pick-a-strong-password',
    suspect: (v) =>
      v.length < 12
        ? `is ${v.length} characters — short for the only credential guarding /admin`
        : null,
  },
  {
    name: 'ADMIN_SESSION_SECRET',
    runtimes: ['web'],
    why: 'HMAC key for the admin session cookie. Without it every admin request throws inside getSecret().',
    placeholder: 'paste-a-long-random-hex-string',
    suspect: (v) =>
      v.length < 32
        ? `is ${v.length} characters — too short to sign a session cookie with (want 32+, e.g. openssl rand -hex 32)`
        : null,
  },
];

/**
 * Validate this process's configuration. Throws once, listing every fatal
 * problem; warns about the rest. Call at boot: `register()` in
 * src/instrumentation.ts for the web app, the top of worker.ts for the worker.
 */
export function assertEnv(runtime: Runtime): void {
  const fatal: string[] = [];
  const warn: string[] = [];

  for (const req of REQUIRED) {
    if (!req.runtimes.includes(runtime)) continue;
    const value = process.env[req.name]?.trim();

    if (!value) {
      fatal.push(`  ${req.name} is not set — ${req.why}`);
      continue;
    }
    if (req.placeholder && value === req.placeholder) {
      fatal.push(`  ${req.name} still holds the .env.example placeholder — ${req.why}`);
      continue;
    }
    const s = req.suspect?.(value);
    if (s) warn.push(`  ${req.name} ${s}`);
  }

  for (const w of warn) console.warn(`[env] warning:\n${w}`);

  if (fatal.length > 0) {
    throw new Error(
      `Missing or placeholder configuration for the ${runtime} process:\n` +
        `${fatal.join('\n')}\n` +
        `Set these in .env (see .env.example) and restart.`,
    );
  }
}
