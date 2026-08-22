import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { issueToken, verifyToken, passwordMatches } from './admin-auth';

// The only thing guarding /admin. These cover the surface the audit named as
// the top testing gap: token FORGERY, TAMPERING, EXPIRY and secret rotation.
//
// The module imports next/headers, which is fine outside a request — those APIs
// only throw when CALLED, and nothing here calls them. The cookie-bound
// functions (startSession/isAuthed/requireAdmin) are therefore out of scope;
// they are thin wrappers over the two functions tested here.

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const keys = Object.keys(patch);
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  const quiet = console.error;
  console.error = () => {};
  for (const k of keys) {
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    console.error = quiet;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Forge a token whose SIGNATURE is valid for `secret` but whose payload is ours. */
function forge(payloadObj: unknown, secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// ── the happy path ───────────────────────────────────────────────────────────

test('a freshly issued token verifies', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    assert.equal(verifyToken(issueToken()), true);
  });
});

// ── tampering ────────────────────────────────────────────────────────────────

test('a tampered payload is rejected', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    const [payload, sig] = issueToken().split('.');
    const flipped = (payload[0] === 'e' ? 'f' : 'e') + payload.slice(1);
    assert.equal(verifyToken(`${flipped}.${sig}`), false);
  });
});

test('a tampered signature is rejected', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    const [payload, sig] = issueToken().split('.');
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    assert.equal(verifyToken(`${payload}.${flipped}`), false);
  });
});

test('structurally malformed tokens are rejected, not thrown on', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    for (const bad of ['', '.', '.sig', 'nodot', 'payload.', '..', 'a.b.c']) {
      assert.equal(verifyToken(bad), false, `expected false for ${JSON.stringify(bad)}`);
    }
  });
});

// ── forgery: a correct signature is not enough ───────────────────────────────

test('a validly signed token still fails without a numeric exp', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    assert.equal(verifyToken(forge({})), false, 'no exp claim');
    assert.equal(verifyToken(forge({ exp: 'never' })), false, 'exp as a string');
    assert.equal(verifyToken(forge({ exp: null })), false, 'exp null');
    assert.equal(verifyToken(forge({ admin: true })), false, 'unrelated claims');
  });
});

test('a validly signed non-JSON payload is rejected', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    const payload = Buffer.from('not json at all').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    assert.equal(verifyToken(`${payload}.${sig}`), false);
  });
});

test('a forged signature from the wrong secret is rejected', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    const far = Math.floor(Date.now() / 1000) + 99_999;
    assert.equal(verifyToken(forge({ exp: far }, OTHER_SECRET)), false);
  });
});

// ── expiry ───────────────────────────────────────────────────────────────────

test('an expired token is rejected', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    assert.equal(verifyToken(forge({ exp: past })), false);
  });
});

test('a token issued in the past, beyond its TTL, is rejected', () => {
  withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => {
    const realNow = Date.now;
    // Issue it eight days ago; the TTL is seven.
    Date.now = () => realNow() - 8 * 24 * 60 * 60 * 1000;
    let stale: string;
    try {
      stale = issueToken();
    } finally {
      Date.now = realNow;
    }
    assert.equal(verifyToken(stale), false);
  });
});

// ── secret rotation ──────────────────────────────────────────────────────────

test('rotating ADMIN_SESSION_SECRET invalidates outstanding tokens', () => {
  const token = withEnv({ ADMIN_SESSION_SECRET: SECRET }, () => issueToken());
  withEnv({ ADMIN_SESSION_SECRET: OTHER_SECRET }, () => {
    assert.equal(verifyToken(token), false, 'rotation must log everyone out');
  });
});

// Documents a KNOWN GAP rather than a guarantee (audit §2.1, "Session mgmt"):
// the token payload carries only `exp`, so a password change does NOT revoke
// live sessions. Only rotating the signing secret does. If that is ever fixed
// by adding a secret-version or password-hash claim, this test SHOULD fail.
test('changing ADMIN_PASSWORD does NOT invalidate sessions (known gap)', () => {
  const token = withEnv({ ADMIN_SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'old-password' }, () =>
    issueToken(),
  );
  withEnv({ ADMIN_SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'a-brand-new-password' }, () => {
    assert.equal(verifyToken(token), true, 'still valid — see audit §2.1 Session mgmt');
  });
});

test('a missing secret throws rather than silently accepting', () => {
  withEnv({ ADMIN_SESSION_SECRET: undefined }, () => {
    assert.throws(() => verifyToken('anything.atall'), /ADMIN_SESSION_SECRET/);
    assert.throws(() => issueToken(), /ADMIN_SESSION_SECRET/);
  });
});

// ── password ─────────────────────────────────────────────────────────────────

test('passwordMatches accepts the configured password and nothing else', () => {
  withEnv({ ADMIN_PASSWORD: 'correct horse battery staple' }, () => {
    assert.equal(passwordMatches('correct horse battery staple'), true);
    assert.equal(passwordMatches('correct horse battery stapl'), false);
    assert.equal(passwordMatches(''), false);
    assert.equal(passwordMatches('CORRECT HORSE BATTERY STAPLE'), false);
  });
});

test('passwordMatches compares hashes, so length mismatch cannot crash it', () => {
  withEnv({ ADMIN_PASSWORD: 'short' }, () => {
    // timingSafeEqual throws on unequal buffer lengths; sha256-first prevents it.
    assert.doesNotThrow(() => passwordMatches('x'.repeat(10_000)));
    assert.equal(passwordMatches('x'.repeat(10_000)), false);
  });
});

test('an unset ADMIN_PASSWORD disables login instead of accepting anything', () => {
  withEnv({ ADMIN_PASSWORD: undefined }, () => {
    assert.equal(passwordMatches(''), false);
    assert.equal(passwordMatches('anything'), false);
  });
});
