import type { ReactNode } from 'react';
import Link from 'next/link';
import { requireAdmin } from '@/server/admin-auth';
import { logoutAction } from '../login/actions';

// Layout for the guarded admin subtree. The (panel) route group keeps these
// pages under /admin/* while leaving /admin/login outside the guard, so an
// unauthenticated visit redirects to login without looping.
export default async function AdminPanelLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireAdmin();

  return (
    <div className="admin">
      <div className="admin-bar">
        <span className="admin-bar-title">Admin</span>
        <nav className="admin-bar-nav">
          <Link href="/admin">Pipeline health</Link>
        </nav>
        <nav className="admin-bar-nav">
          <Link href="/admin/inspector">Inspector</Link>
        </nav>
        <div className="admin-bar-right">
          <Link href="/" className="admin-bar-link">
            View site
          </Link>
          <form action={logoutAction}>
            <button type="submit" className="admin-logout">
              Log out
            </button>
          </form>
        </div>
      </div>
      <main className="admin-main">{children}</main>
    </div>
  );
}
