'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Nav() {
  const path = usePathname() || '/';
  const onHome = path === '/';
  const onLeaderboard = path.startsWith('/leaderboard');
  const onPlanner = path.startsWith('/planner');
  const onLibrary = path.startsWith('/library');
  const onComps = path.startsWith('/comps');

  return (
    <nav className="nav">
      <Link href="/" className={onHome ? 'active' : ''}>
        Profiles
      </Link>

      <Link href="/leaderboard/euw1" className={onLeaderboard ? 'active' : ''}>
        Leaderboards
      </Link>

      <Link href="/planner" className={onPlanner ? 'active' : ''}>
        Planner
      </Link>

      <Link href="/library" className={onLibrary ? 'active' : ''}>
        Library
      </Link>

      <Link href="/comps" className={onComps ? 'active' : ''}>
        Comps
      </Link>
    </nav>
  );
}