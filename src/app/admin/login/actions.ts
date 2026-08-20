'use server';

import { redirect } from 'next/navigation';
import { passwordMatches, startSession, endSession } from '@/server/admin-auth';
import { rateLimit, LIMITS } from '@/server/rate-limit';

export async function loginAction(formData: FormData): Promise<void> {
  // Throttle BEFORE comparing, so a wrong guess still costs the attacker its
  // slot in the window. One shared password means online brute force is the
  // whole threat model here.
  const limit = await rateLimit('login', LIMITS.adminLogin);
  if (!limit.ok) redirect('/admin/login?error=rate');

  const password = formData.get('password');
  if (typeof password !== 'string' || !passwordMatches(password)) {
    redirect('/admin/login?error=1');
  }

  try {
    await startSession();
  } catch {
    // Missing ADMIN_SESSION_SECRET (or similar) — surface as a config error.
    redirect('/admin/login?error=config');
  }

  redirect('/admin');
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect('/admin/login');
}
