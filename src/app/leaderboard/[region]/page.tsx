import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isPlatform } from '@/config/regions';
import {
  getLeaderboard,
  isLeaderboardTier,
  LEADERBOARD_TIERS,
  TIER_LABELS,
} from '@/server/leaderboard-service';
import type { LeaderboardTier } from '@/server/view-models';
import RegionSelect from '@/components/RegionSelect';
import { RateLimited } from '@/components/RateLimited';
import { limitRiotRead } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ region: string }>;
  searchParams: Promise<{ tier?: string; page?: string }>;
}) {
  const { region } = await params;
  if (!isPlatform(region)) notFound();

  const sp = await searchParams;
  const tier: LeaderboardTier = isLeaderboardTier(sp.tier ?? '')
    ? (sp.tier as LeaderboardTier)
    : 'challenger';
  const requestedPage = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  // The ladder itself is cached ~30m, but an uncached page still resolves up to
  // PAGE_SIZE names through Riot on a cold accounts table.
  const limit = await limitRiotRead('leaderboard');
  if (!limit.ok) {
    return (
      <main className="page">
        <RateLimited retryAfter={limit.retryAfter} />
      </main>
    );
  }

  const vm = await getLeaderboard(region, tier, requestedPage, PAGE_SIZE);

  const hrefFor = (t: LeaderboardTier, p: number) =>
    `/leaderboard/${region}?tier=${t}${p > 1 ? `&page=${p}` : ''}`;

  return (
    <main className="page">
      <section className="lb">
        <div className="lb-head">
          <div className="lb-title">
            <h1>Leaderboard</h1>
            <span className="lb-sub">
              {region.toUpperCase()} · {vm.tierLabel} · {vm.total.toLocaleString()} ranked
            </span>
          </div>
          <RegionSelect region={region} tier={tier} />
        </div>

        <div className="lb-tabs">
          {LEADERBOARD_TIERS.map((t) => (
            <Link key={t} href={hrefFor(t, 1)} className={t === tier ? 'on' : ''}>
              {TIER_LABELS[t]}
            </Link>
          ))}
        </div>

        <div className="lb-table">
          <div className="lb-row lb-h">
            <span className="c-rank">#</span>
            <span className="c-name">Player</span>
            <span className="c-lp">LP</span>
            <span className="c-w wl">Wins</span>
            <span className="c-l wl">Losses</span>
            <span className="c-wr">Win%</span>
          </div>

          {vm.rows.length === 0 ? (
            <div className="lb-empty">
              No ranked players found for {vm.tierLabel} on {region.toUpperCase()}.
            </div>
          ) : (
            vm.rows.map((r) => {
              const inner = (
                <>
                  <span className={`c-rank ${r.rank === 1 ? 'top1' : ''}`}>{r.rank}</span>
                  <span className="c-name">
                    <span className="lb-name">{r.name}</span>
                    {r.tagLine && <span className="lb-tag">#{r.tagLine}</span>}
                  </span>
                  <span className="c-lp num">{r.leaguePoints.toLocaleString()}</span>
                  <span className="c-w wl num">{r.wins}</span>
                  <span className="c-l wl num">{r.losses}</span>
                  <span className="c-wr">
                    {r.winRate < 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        <span className="wr-bar">
                          <i style={{ width: `${Math.round(r.winRate * 100)}%` }} />
                        </span>
                        <span className="wr-pct num">{Math.round(r.winRate * 100)}%</span>
                      </>
                    )}
                  </span>
                </>
              );

              return r.tagLine ? (
                <Link
                  key={r.puuid || r.rank}
                  href={`/${region}/${encodeURIComponent(r.name)}/${encodeURIComponent(r.tagLine)}`}
                  className="lb-row"
                >
                  {inner}
                </Link>
              ) : (
                <div key={r.puuid || r.rank} className="lb-row">
                  {inner}
                </div>
              );
            })
          )}
        </div>

        {vm.totalPages > 1 && (
          <nav className="pager" aria-label="Leaderboard pages">
            <Link className={`pg ${vm.page <= 1 ? 'off' : ''}`} href={hrefFor(tier, 1)}>
              « First
            </Link>
            <Link className={`pg ${vm.page <= 1 ? 'off' : ''}`} href={hrefFor(tier, vm.page - 1)}>
              ‹ Prev
            </Link>
            <span className="pg-info">
              Page {vm.page} of {vm.totalPages}
            </span>
            <Link
              className={`pg ${vm.page >= vm.totalPages ? 'off' : ''}`}
              href={hrefFor(tier, vm.page + 1)}
            >
              Next ›
            </Link>
            <Link
              className={`pg ${vm.page >= vm.totalPages ? 'off' : ''}`}
              href={hrefFor(tier, vm.totalPages)}
            >
              Last »
            </Link>
          </nav>
        )}
      </section>
    </main>
  );
}
