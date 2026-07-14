import { Suspense } from 'react';
import Link from 'next/link';
import SearchBar from '@/components/SearchBar';
import { getLeaderboard } from '@/server/leaderboard-service';
import type { Platform } from '@/config/regions';

export const dynamic = 'force-dynamic';

const HOME_REGION: Platform = 'euw1';

export default function HomePage() {
  return (
    <main className="page home">
      <section className="home-hero">
        <h1 className="home-title">Teamfight Tactics, decoded.</h1>
        <p className="home-sub">
          Player profiles, full match breakdowns, and live regional leaderboards.
        </p>
        <SearchBar />
        <span className="home-hint">
          Search any player by Riot ID, e.g. <b>Name#TAG</b>
        </span>
      </section>

      <section className="home-grid">
        <div className="home-top">
          <div className="card-head">
            <h2>Top Challenger</h2>
            <span className="card-sub">EUW</span>
          </div>
          <Suspense fallback={<TopSkeleton />}>
            <TopPlayers region={HOME_REGION} />
          </Suspense>
        </div>

        <div className="home-cards">
          <Link className="feature" href={`/leaderboard/${HOME_REGION}`}>
            <span className="feature-name">Leaderboards</span>
            <span className="feature-desc">Challenger, Grandmaster & Master ladders by region</span>
          </Link>
          <Link className="feature" href="/comps">
            <span className="feature-name">Comps</span>
            <span className="feature-desc">Meta team comps derived from analyzed matches</span>
          </Link>
          <div className="feature soon">
            <span className="feature-name">
              Tier Lists <em>Soon</em>
            </span>
            <span className="feature-desc">Auto-ranked units & traits by patch</span>
          </div>
          <Link className="feature" href="/planner">
            <span className="feature-name">Team Planner</span>
            <span className="feature-desc">Build a board and export a team code</span>
          </Link>
        </div>
      </section>
    </main>
  );
}

async function TopPlayers({ region }: { region: Platform }) {
  let rows: Awaited<ReturnType<typeof getLeaderboard>>['rows'] = [];
  try {
    const vm = await getLeaderboard(region, 'challenger', 1, 5);
    rows = vm.rows;
  } catch {
    rows = [];
  }

  if (rows.length === 0) {
    return <div className="top-empty">Leaderboard preview is unavailable right now.</div>;
  }

  return (
    <>
      <ol className="top-list">
        {rows.map((r) => {
          const inner = (
            <>
              <span className={`top-rank ${r.rank === 1 ? 'top1' : ''}`}>{r.rank}</span>
              <span className="top-name">
                {r.name}
                {r.tagLine && <span className="top-tag">#{r.tagLine}</span>}
              </span>
              <span className="top-lp num">{r.leaguePoints.toLocaleString()} LP</span>
            </>
          );
          return (
            <li key={r.puuid || r.rank}>
              {r.tagLine ? (
                <Link
                  className="top-row"
                  href={`/${region}/${encodeURIComponent(r.name)}/${encodeURIComponent(r.tagLine)}`}
                >
                  {inner}
                </Link>
              ) : (
                <span className="top-row">{inner}</span>
              )}
            </li>
          );
        })}
      </ol>
      <Link className="top-all" href={`/leaderboard/${region}`}>
        View full leaderboard →
      </Link>
    </>
  );
}

function TopSkeleton() {
  return (
    <ol className="top-list">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i}>
          <span className="top-row">
            <span className="top-rank">
              <span className="skeleton" style={{ width: 16, height: 14, display: 'inline-block' }} />
            </span>
            <span className="top-name">
              <span className="skeleton" style={{ width: '60%', height: 13, display: 'inline-block' }} />
            </span>
            <span className="top-lp">
              <span className="skeleton" style={{ width: 50, height: 13, display: 'inline-block' }} />
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
