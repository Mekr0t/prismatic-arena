'use client';

import { useState, useMemo } from 'react';
import type { ProfileVM, MatchSummaryVM } from '@/server/view-models';
import ProfileHeader from './ProfileHeader';
import MatchList from './MatchList';

type GameMode = 'all' | 'ranked' | 'double_up' | 'unranked';

const TABS: { id: GameMode; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ranked', label: 'Ranked' },
  { id: 'double_up', label: 'Double Up' },
  { id: 'unranked', label: 'Unranked' },
];

function queueMode(queueId: number): Exclude<GameMode, 'all'> {
  if (queueId === 1100) return 'ranked';
  if (queueId === 1160) return 'double_up';
  return 'unranked';
}

function computeSummary(matches: MatchSummaryVM[]): ProfileVM['summary'] {
  const n = matches.length;
  const acc = matches.reduce(
    (a, m) => {
      a.place += m.placement;
      if (m.placement <= 4) a.top4 += 1;
      if (m.placement === 1) a.first += 1;
      return a;
    },
    { place: 0, top4: 0, first: 0 },
  );
  return {
    games: n,
    avgPlacement: n ? acc.place / n : 0,
    top4Rate: n ? acc.top4 / n : 0,
    firstRate: n ? acc.first / n : 0,
  };
}

export default function ProfileContent({ vm }: { vm: ProfileVM }) {
  const [mode, setMode] = useState<GameMode>('all');

  const filteredMatches = useMemo(
    () => (mode === 'all' ? vm.matches : vm.matches.filter((m) => queueMode(m.queueId) === mode)),
    [vm.matches, mode],
  );

  const filteredVm = useMemo(
    () => ({ ...vm, summary: computeSummary(filteredMatches) }),
    [vm, filteredMatches],
  );

  return (
    <>
      <ProfileHeader vm={filteredVm} />
      <div className="mode-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`mode-tab${mode === tab.id ? ' on' : ''}`}
            onClick={() => setMode(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <MatchList matches={filteredMatches} viewedPuuid={vm.puuid} platform={vm.platform} />
    </>
  );
}
