import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="page">
      <div className="notice">
        <h2>Match not found</h2>
        <p>This match isn’t available — it may be too old to fetch, or the ID/region is off.</p>
        <Link className="btn" href="/leaderboard/euw1">
          Browse leaderboard
        </Link>
      </div>
    </main>
  );
}
