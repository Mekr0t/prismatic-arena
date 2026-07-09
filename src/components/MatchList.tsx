'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { MatchSummaryVM, MatchDetailVM } from '@/server/view-models';
import { PlacementBadge, BoardStrip } from './Board';

type DetailState = MatchDetailVM | 'loading' | 'error' | undefined;

function formatTftRound(lastRound: number) {
  if (lastRound <= 4) {
    return `1-${lastRound}`;
  }

  const adjusted = lastRound - 5;
  const stage = 2 + Math.floor(adjusted / 7);
  const round = 1 + (adjusted % 7);

  return `${stage}-${round}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

export default function MatchList({
  matches,
  viewedPuuid,
  platform,
}: {
  matches: MatchSummaryVM[];
  viewedPuuid: string;
  platform: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});

  async function toggle(matchId: string) {
    if (openId === matchId) {
      setOpenId(null);
      return;
    }
    setOpenId(matchId);
    const existing = details[matchId];
    if (existing && existing !== 'error') return; // already loaded
    setDetails((d) => ({ ...d, [matchId]: 'loading' }));
    try {
      const res = await fetch(`/api/match/${platform}/${encodeURIComponent(matchId)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data: MatchDetailVM = await res.json();
      setDetails((d) => ({ ...d, [matchId]: data }));
    } catch {
      setDetails((d) => ({ ...d, [matchId]: 'error' }));
    }
  }

  if (matches.length === 0) {
    return (
      <section className="matches">
        <div className="notice"><p>No matches found for this game mode.</p></div>
      </section>
    );
  }

  return (
    <section className="matches">
      {matches.map((m) => (
        <MatchRow
          key={m.matchId}
          match={m}
          platform={platform}
          expanded={openId === m.matchId}
          detail={details[m.matchId]}
          viewedPuuid={viewedPuuid}
          onToggle={() => toggle(m.matchId)}
        />
      ))}
    </section>
  );
}

function MatchRow({
  match,
  platform,
  expanded,
  detail,
  viewedPuuid,
  onToggle,
}: {
  match: MatchSummaryVM;
  platform: string;
  expanded: boolean;
  detail: DetailState;
  viewedPuuid: string;
  onToggle: () => void;
}) {
  return (
    <>
      <article className={`match ${match.bucket} ${expanded ? 'expanded' : ''}`}>
        <div className="result">
          <PlacementBadge placement={match.placement} bucket={match.bucket} />
          <div className="place-label">{ordinal(match.placement)}</div>
        </div>
        <div className="board">
          <BoardStrip board={match.board} maxTraits={6} />
        </div>
        <div className="meta">
          <div className="lvl">Lv {match.level}</div>
          <div className="when">Round {formatTftRound(match.lastRound)}</div>
        </div>
        <button
          className="match-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse lobby' : 'Expand lobby'}
          onClick={onToggle}
        />
      </article>
      {expanded && <LobbyPanel detail={detail} viewedPuuid={viewedPuuid} platform={platform} />}
    </>
  );
}

function LobbyPanel({
  detail,
  viewedPuuid,
  platform,
}: {
  detail: DetailState;
  viewedPuuid: string;
  platform: string;
}) {
  if (!detail || detail === 'loading') {
    return (
      <div className="match-detail">
        <div className="ld-head">Loading lobby…</div>
      </div>
    );
  }
  if (detail === 'error') {
    return (
      <div className="match-detail">
        <div className="ld-head">Couldn’t load this match. Open it again to retry.</div>
      </div>
    );
  }
  return (
    <div className="match-detail">
      <div className="ld-head">
        <span>Full lobby — all 8 boards</span>
        <Link
          className="ld-link"
          href={`/match/${platform}/${encodeURIComponent(detail.matchId)}?puuid=${viewedPuuid}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open match ↗
        </Link>
      </div>
      {detail.participants.map((p) => {
        const nameNode = (
          <span className="pl-id">
            <span className="pl-name">{p.name}</span>
            {p.tagLine && <span className="pl-tag">#{p.tagLine}</span>}
          </span>
        );
        return (
          <div key={p.puuid} className={`pl ${p.puuid === viewedPuuid ? 'you' : ''}`}>
            <PlacementBadge placement={p.placement} bucket={p.bucket} variant="lobby" />
            <div className="pl-main">
              <div className="pl-top">
                {p.tagLine ? (
                  <Link
                    className="pl-link"
                    href={`/${platform}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tagLine)}`}
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
  );
}
