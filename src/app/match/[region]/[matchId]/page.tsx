import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isPlatform } from '@/config/regions';
import { getMatchDetail } from '@/server/match-service';
import { PlacementBadge, BoardStrip } from '@/components/Board';
import { RateLimited } from '@/components/RateLimited';
import { limitRiotRead } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

// e.g. "EUW1_7412345678" — platform prefix, underscore, digits.
const MATCH_ID_RE = /^[A-Za-z0-9]{2,8}_[0-9]{1,24}$/;

const QUEUE_LABELS: Record<number, string> = {
  1090: 'Normal',
  1100: 'Ranked',
  1130: 'Hyper Roll',
  1160: 'Double Up',
  1180: 'Ranked',
};

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function duration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default async function MatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ region: string; matchId: string }>;
  searchParams: Promise<{ puuid?: string }>;
}) {
  const { region, matchId } = await params;
  if (!isPlatform(region)) notFound();

  const { puuid: highlight } = await searchParams;

  // Reject a malformed id before spending a Riot call on it.
  const id = decodeURIComponent(matchId);
  if (!MATCH_ID_RE.test(id)) notFound();

  const limit = await limitRiotRead('match');
  if (!limit.ok) {
    return (
      <main className="page">
        <RateLimited retryAfter={limit.retryAfter} />
      </main>
    );
  }

  const detail = await getMatchDetail(region, id);
  if (!detail) notFound();

  const queue = QUEUE_LABELS[detail.queueId] ?? 'TFT';

  return (
    <main className="page">
      <section className="match-page">
        <header className="mp-head">
          <div className="mp-title">
            <h1>{queue} lobby</h1>
            <span className="mp-id num">{detail.matchId}</span>
          </div>
          <div className="mp-meta">
            <span>Set {detail.setNumber}</span>
            <span>·</span>
            <span>{relativeTime(detail.playedAt)}</span>
            <span>·</span>
            <span>{duration(detail.gameLengthSeconds)}</span>
          </div>
        </header>

        <div className="mp-lobby">
          {detail.participants.map((p) => {
            const nameNode = (
              <span className="pl-id">
                <span className="pl-name">{p.name}</span>
                {p.tagLine && <span className="pl-tag">#{p.tagLine}</span>}
              </span>
            );
            return (
              <div
                key={p.puuid}
                className={`pl ${highlight && p.puuid === highlight ? 'you' : ''}`}
              >
                <PlacementBadge placement={p.placement} bucket={p.bucket} variant="lobby" />
                <div className="pl-main">
                  <div className="pl-top">
                    {p.tagLine ? (
                      <Link
                        className="pl-link"
                        href={`/${region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tagLine)}`}
                      >
                        {nameNode}
                      </Link>
                    ) : (
                      nameNode
                    )}
                    <span className="pl-lv num">Lv {p.level}</span>
                  </div>
                  <BoardStrip board={p.board} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
