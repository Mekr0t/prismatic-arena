'use client';

import { useState } from 'react';
import type { ProfileVM } from '@/server/view-models';

const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

const REGION_LABELS: Record<string, string> = {
  euw1: 'EUW',
  eun1: 'EUNE',
  na1: 'NA',
  kr: 'KR',
  br1: 'BR',
  jp1: 'JP',
  oc1: 'OCE',
  la1: 'LAN',
  la2: 'LAS',
  tr1: 'TR',
  ru: 'RU',
};

function Stat({ v, k, good }: { v: React.ReactNode; k: string; good?: boolean }) {
  return (
    <div className="stat">
      <div className={`v ${good ? 'good' : ''}`}>{v}</div>
      <div className="k">{k}</div>
    </div>
  );
}

function RankCrest({ tier }: { tier: string }) {
  const [failed, setFailed] = useState(false);
  const tierLow = tier.toLowerCase();
  if (failed) return <div className={`crest ${tierLow}`} />;
  return (
    <div className="crest-wrap">
      <img
        className="crest-img"
        //src={`https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/images/ranked-emblem/emblem-${tierLow}.png`}
        src={`https://raw.communitydragon.org/15.9/plugins/rcp-fe-lol-static-assets/global/default/ranked-emblem/emblem-${tierLow}.png`}
        alt={tier}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export default function ProfileHeader({ vm }: { vm: ProfileVM }) {
  return (
    <section className="profile">
      <div className="avatar">
        {vm.profileIconId != null ? (
          <img
            className="avatar-icon"
            src={`https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${vm.profileIconId}.jpg`}
            alt=""
          />
        ) : (
          vm.initial
        )}
      </div>

      <div className="identity">
        <h1>
          {vm.gameName} <span className="tag">#{vm.tagLine}</span>
        </h1>
        <div className="region-row">
          <span className="region-text">
            {REGION_LABELS[vm.platform] ?? vm.platform.toUpperCase()}
          </span>
          {vm.summonerLevel != null && (
            <span className="lv-badge">Level {vm.summonerLevel}</span>
          )}
        </div>
      </div>

      {vm.rank ? (
        <div className="rank">
          <RankCrest tier={vm.rank.tier} />
          <div>
            <div className="tier">
              {vm.rank.tier}
              {vm.rank.division && !APEX.has(vm.rank.tier) ? ` ${vm.rank.division}` : ''}
            </div>
            <div className="lp">
              <b className="num">{vm.rank.lp.toLocaleString()}</b> LP · {vm.rank.wins}W / {vm.rank.losses}L
            </div>
          </div>
        </div>
      ) : (
        <div className="rank-unranked">Unranked this set.</div>
      )}

      <div className="summary">
        <Stat v={vm.summary.avgPlacement.toFixed(1)} k={`Avg place · last ${vm.summary.games}`} />
        <Stat v={`${Math.round(vm.summary.top4Rate * 100)}%`} k="Top 4" good />
        <Stat v={`${Math.round(vm.summary.firstRate * 100)}%`} k="First" />
        <Stat v={vm.summary.games} k="Games" />
      </div>
    </section>
  );
}
