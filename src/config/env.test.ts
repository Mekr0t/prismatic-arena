import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnv } from './env';

// assertEnv reads process.env, so every case runs against a controlled snapshot
// and restores it afterwards. Warnings are silenced: they are expected output
// here, not signal.
const COMPLETE: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  RIOT_API_KEY: 'RGAPI-11111111-2222-3333-4444-555555555555',
  ADMIN_PASSWORD: 'a-sufficiently-long-password',
  ADMIN_SESSION_SECRET: 'a'.repeat(64),
};

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const keys = [...new Set([...Object.keys(COMPLETE), ...Object.keys(patch)])];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  const warn = console.warn;
  console.warn = () => {};
  for (const k of keys) {
    const v = k in patch ? patch[k] : COMPLETE[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    console.warn = warn;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const failure = (runtime: 'web' | 'worker'): string | null => {
  try {
    assertEnv(runtime);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

test('a complete environment validates for both runtimes', () => {
  withEnv({}, () => {
    assert.equal(failure('web'), null);
    assert.equal(failure('worker'), null);
  });
});

test('a missing variable is fatal, named, and explained', () => {
  withEnv({ ADMIN_SESSION_SECRET: undefined }, () => {
    const msg = failure('web');
    assert.ok(msg, 'expected a throw');
    assert.match(msg, /ADMIN_SESSION_SECRET is not set/);
    assert.match(msg, /getSecret/); // says what actually breaks
  });
});

test('every problem is reported in one throw, not one per restart', () => {
  withEnv(
    { DATABASE_URL: undefined, ADMIN_PASSWORD: undefined, ADMIN_SESSION_SECRET: undefined },
    () => {
      const msg = failure('web') ?? '';
      for (const k of ['DATABASE_URL', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']) {
        assert.ok(msg.includes(k), `${k} should be listed`);
      }
    },
  );
});

test('an unedited .env.example placeholder is fatal', () => {
  withEnv({ RIOT_API_KEY: 'RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }, () => {
    assert.match(failure('web') ?? '', /placeholder/);
  });
});

test('requirements are scoped per runtime: the worker needs no admin secrets', () => {
  withEnv({ ADMIN_PASSWORD: undefined, ADMIN_SESSION_SECRET: undefined }, () => {
    assert.equal(failure('worker'), null);
    assert.ok(failure('web'), 'the web app still requires them');
  });
});

test('present-but-weak values warn rather than blocking boot', () => {
  withEnv({ ADMIN_SESSION_SECRET: 'short', ADMIN_PASSWORD: 'x' }, () => {
    assert.equal(failure('web'), null);
  });
});

test('a malformed connection string warns but does not block boot', () => {
  withEnv({ DATABASE_URL: 'mysql://nope', REDIS_URL: 'http://nope' }, () => {
    assert.equal(failure('web'), null);
  });
});
