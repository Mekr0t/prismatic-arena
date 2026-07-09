import { redirect } from 'next/navigation';
import { isAuthed } from '@/server/admin-auth';
import { loginAction } from './actions';

export const metadata = { title: 'Admin — Sign in' };

const ERRORS: Record<string, string> = {
  '1': 'Incorrect password.',
  config: 'Admin login isn’t configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET.',
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in → straight to the dashboard.
  if (await isAuthed()) redirect('/admin');

  const { error } = await searchParams;
  const message = error ? (ERRORS[error] ?? 'Something went wrong.') : null;

  return (
    <main className="admin-login">
      <form className="login-card" action={loginAction}>
        <h1>Admin</h1>
        <p className="login-sub">Sign in to manage the platform.</p>
        {message ? <p className="login-error">{message}</p> : null}
        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>
        <button type="submit" className="login-btn">
          Sign in
        </button>
      </form>
    </main>
  );
}
