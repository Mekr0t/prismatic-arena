'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// router.refresh() re-runs the server component for the current route, pulling
// fresh ops data without a full navigation or losing scroll position.
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return (
    <div className="auto-refresh">
      <span className="auto-dot" aria-hidden />
      <span>Auto-refreshing every {seconds}s</span>
      <button type="button" className="auto-btn" onClick={() => router.refresh()}>
        Refresh now
      </button>
    </div>
  );
}
