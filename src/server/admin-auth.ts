import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// Minimal single-operator admin auth. No user table: one password lives in
// ADMIN_PASSWORD, and a signed (HMAC) cookie carries the session. Upgrading to
// multiple admins later is localized to this file — swap passwordMatches() to a
// table/hash lookup and nothing else changes.

const COOKIE_NAME = 'admin_session';
// Session lifetime before re-login is required. Tune freely.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set');
  return secret;
}

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}

/** Constant-time equality. Hash to fixed length first so input length never leaks. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function signPayload(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/**
 * Signed session token: `base64url(json).hmac`.
 *
 * Exported alongside verifyToken as the token contract: together they are the
 * whole of the admin authentication surface, and everything else in this file
 * is cookie plumbing around them. Keeping them private meant the security
 * cases that matter — forgery, tampering, expiry, secret rotation — could not be
 * tested at all, which is the wrong trade for the only thing guarding /admin.
 */
export function issueToken(): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${payload}.${signPayload(payload)}`;
}

/**
 * Verify signature + expiry. True only for a valid, unexpired token.
 *
 * THROWS if ADMIN_SESSION_SECRET is unset (via signPayload). That is deliberate
 * — a missing secret is a deployment fault, not a failed login — so callers
 * that must not crash catch it and treat it as unauthenticated, as isAuthed
 * does. Boot validation (config/env.ts) should make this unreachable in
 * practice.
 */
export function verifyToken(token: string): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(signPayload(payload));
  if (sigBuf.length !== expBuf.length) return false;
  if (!timingSafeEqual(sigBuf, expBuf)) return false;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof decoded.exp === 'number' && decoded.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** True if the submitted password matches ADMIN_PASSWORD (constant-time). */
export function passwordMatches(submitted: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    console.error('[admin-auth] ADMIN_PASSWORD is not set — login is disabled.');
    return false;
  }
  return safeEqual(submitted, expected);
}

/** Set the signed session cookie. Call only from a Server Action / Route Handler. */
export async function startSession(): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Clear the session cookie. Call only from a Server Action / Route Handler. */
export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** True if the current request carries a valid admin session. */
export async function isAuthed(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return false;
  try {
    return verifyToken(token);
  } catch {
    // e.g. ADMIN_SESSION_SECRET missing → treat as unauthenticated, never crash.
    return false;
  }
}

/**
 * Redirect to the login page unless authed. Call at the top of any protected
 * server code — the (panel) layout calls it, and any future /api/admin route
 * handler must call it too (a layout guard does not cover API routes).
 */
export async function requireAdmin(): Promise<void> {
  if (!(await isAuthed())) {
    redirect('/admin/login');
  }
}
