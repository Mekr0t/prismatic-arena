'use server';

import { redirect } from 'next/navigation';
import { passwordMatches, startSession, endSession } from '@/server/admin-auth';

export async function loginAction(formData: FormData): Promise<void> {
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
