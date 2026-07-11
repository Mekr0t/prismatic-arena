'use client';

// Comp-detail view (M6) — one archetype drilled down: header stats, core/flex
// unit strips, level distribution, hit-state variants, per-unit table with
// placement delta, carry item builds, and the most-played exact boards.
// Client component: every unit/trait/item tile wires the shared game-data
// popups, same as ExampleTeam.

import Link from 'next/link';
import { useState } from 'react';
import { useGameData } from '@/lib/game-data';
import { ExampleTeam } from './ExampleTeam';
import type {
  CompDetailVM,
  DetailUnitVM,
  DetailVariantVM,
  DetailBuildVM,
  DetailTrendPointVM,
  CarryPortraitVM,
  KeyTraitChipVM,
} from '@/server/comps-types';

const fmtAvg = (v: number): string => v.toFixed(2);
const fmtPct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
const fmtDelta = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

function UnitTile({ unit, showFreq }: { unit: DetailUnitVM; showFreq: boolean }) {
  const { showTooltip, hideTooltip, openModal } = useGameData();
  return (
    <div className="ex-unit cd-unit">
      <div className={`ex-star${unit.modalStar === 3 ? '' : ' hide'}`}>★★★</div>
      <div
        className={`ex-tile c${unit.cost || 1}`}
        onMouseEnter={(e) => showTooltip(e, 'unit', unit.characterId, unit.name)}
        onMouseLeave={hideTooltip}
        onClick={() => openModal('unit', unit.characterId, unit.name)}
      >
        {unit.iconUrl ? <img src={unit.iconUrl} alt={unit.name} /> : <span>{unit.name}</span>}
      </div>
      {unit.items.length > 0 && (
        <div className="ex-items">
          {unit.items.map((it, i) =>
            it.iconUrl ? (
              <img
                key={`${it.itemId}:${i}`}
                className="ex-itemimg"
                src={it.iconUrl}
                alt={it.name}
                onMouseEnter={(e) => {
                  e.stopPropagation();
                  showTooltip(e, 'item', it.itemId, it.name);
                }}
                onMouseLeave={hideTooltip}
                onClick={(e) => {
                  e.stopPropagation();
                  openModal('item', it.itemId, it.name);
                }}
              />
            ) : (
              <i key={`${it.itemId}:${i}`} className="ex-itemimg ex-item-ph" title={it.name} />
            ),
          )}
        </div>
      )}
      {showFreq && <div className="cd-freq">{fmtPct(unit.freq, 0)}</div>}
    </div>
  );
}

function TraitChip({ trait }: { trait: KeyTraitChipVM }) {
  const { showTooltip, hideTooltip, openModal } = useGameData();
  return (
    <span
      className={`ex-trait s${trait.style || 1}`}
      onMouseEnter={(e) => showTooltip(e, 'trait', trait.traitId, trait.name)}
      onMouseLeave={hideTooltip}
      onClick={() => openModal('trait', trait.traitId, trait.name)}
    >
      {trait.iconUrl ? <img src={trait.iconUrl} alt="" /> : <span className="ex-dot" />}
      <span className="ex-n">{trait.minUnits}</span>
    </span>
  );
}

function MiniUnit({ unit }: { unit: CarryPortraitVM }) {
  const { showTooltip, hideTooltip, openModal } = useGameData();
  return (
    <span
      className={`cd-mini c${unit.cost || 1}`}
      onMouseEnter={(e) => showTooltip(e, 'unit', unit.characterId, unit.name)}
      onMouseLeave={hideTooltip}
      onClick={() => openModal('unit', unit.characterId, unit.name)}
    >
      {unit.iconUrl ? <img src={unit.iconUrl} alt={unit.name} /> : unit.name}
    </span>
  );
}

function VariantRow({ v }: { v: DetailVariantVM }) {
  const label =
    v.key === '__other__' ? 'Other hit states' : v.key === '' ? 'No 3★ hits' : null;
  return (
    <tr>
      <td className="cd-var-units">
        {label ?? (
          <>
            {v.units.map((u) => (
              <MiniUnit key={u.characterId} unit={u} />
            ))}
            <span className="cd-var-star">3★</span>
          </>
        )}
      </td>
      <td className="num">{v.n.toLocaleString()}</td>
      <td className="num">{fmtPct(v.share, 0)}</td>
      <td className="num">{fmtAvg(v.avgPlacement)}</td>
      <td className="num">{fmtPct(v.top4Rate, 0)}</td>
      <td className="num">{fmtPct(v.winRate, 0)}</td>
    </tr>
  );
}

function BuildRow({ build }: { build: DetailBuildVM }) {
  const { showTooltip, hideTooltip, openModal } = useGameData();
  return (
    <div className="cd-build">
      <MiniUnit
        unit={{
          characterId: build.characterId,
          name: build.name,
          cost: build.cost,
          iconUrl: build.iconUrl,
        }}
      />
      <div className="cd-build-sets">
        {build.sets.map((s, i) => (
          <div className="cd-build-set" key={i}>
            <span className="cd-build-items">
              {s.items.map((it, j) =>
                it.iconUrl ? (
                  <img
                    key={`${it.itemId}:${j}`}
                    src={it.iconUrl}
                    alt={it.name}
                    onMouseEnter={(e) => showTooltip(e, 'item', it.itemId, it.name)}
                    onMouseLeave={hideTooltip}
                    onClick={() => openModal('item', it.itemId, it.name)}
                  />
                ) : (
                  <i key={`${it.itemId}:${j}`} className="ex-item-ph" title={it.name} />
                ),
              )}
            </span>
            <span className="cd-build-stat">
              {fmtPct(s.rate, 0)} · avg {fmtAvg(s.avgPlacement)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Dependency-free SVG trend: avg placement as a line in the upper zone
 *  (inverted — up is better) with the value printed at every dot, games per
 *  period as bars in the lower zone with counts, dates along the bottom.
 *  Self-explanatory without hover; when there are many points, labels thin
 *  out to every k-th column. */
function TrendChart({ trend }: { trend: DetailTrendPointVM[] }) {
  if (trend.length < 2) {
    return (
      <p className="cd-note">
        Not enough daily snapshots yet — the trend fills in as the trend-tier stage keeps
        running.
      </p>
    );
  }
  const W = 560;
  const H = 240;
  const PAD_X = 34;
  const LINE_TOP = 34; // room for the avg label above the highest dot
  const LINE_BOT = 108; // upper zone: the avg-placement line
  const BAR_BOT = 206; // lower zone: the games bars
  const BAR_MAX = 72;
  const DATE_Y = 228;

  const xs = (i: number) => PAD_X + (i * (W - 2 * PAD_X)) / (trend.length - 1);
  const avgs = trend.map((t) => t.avgPlacement);
  const lo = Math.min(...avgs) - 0.2;
  const hi = Math.max(...avgs) + 0.2;
  const ys = (v: number) => LINE_TOP + ((v - lo) / (hi - lo)) * (LINE_BOT - LINE_TOP);
  const maxGames = Math.max(...trend.map((t) => t.games), 1);
  const barW = Math.min(Math.max(((W - 2 * PAD_X) / trend.length) * 0.45, 6), 42);
  // Thin out per-column labels when the series grows (always label the last).
  const labelEvery = Math.ceil(trend.length / 8);
  const labeled = (i: number) => i % labelEvery === 0 || i === trend.length - 1;
  const tip = (t: DetailTrendPointVM): string =>
    `${t.date}: ${t.games.toLocaleString()} games · avg ${fmtAvg(t.avgPlacement)} · ` +
    `top 4 ${fmtPct(t.top4Rate, 0)} · play ${fmtPct(t.playRate, 1)}`;
  const points = trend
    .map((t, i) => `${xs(i).toFixed(1)},${ys(t.avgPlacement).toFixed(1)}`)
    .join(' ');

  return (
    <div className="cd-trend">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Average placement and games per day">
        <text className="cd-trend-zone" x={PAD_X - 26} y={LINE_TOP - 14}>
          AVG PLACE
        </text>
        <text className="cd-trend-zone" x={PAD_X - 26} y={BAR_BOT - BAR_MAX - 10}>
          GAMES
        </text>
        {trend.map((t, i) => {
          const bh = Math.max((t.games / maxGames) * BAR_MAX, 2);
          return (
            <g key={t.date}>
              <rect
                className="cd-trend-bar"
                x={xs(i) - barW / 2}
                y={BAR_BOT - bh}
                width={barW}
                height={bh}
              >
                <title>{tip(t)}</title>
              </rect>
              {labeled(i) && (
                <text className="cd-trend-games" x={xs(i)} y={BAR_BOT - bh - 5}>
                  {t.games.toLocaleString()}
                </text>
              )}
              {labeled(i) && (
                <text className="cd-trend-date" x={xs(i)} y={DATE_Y}>
                  {t.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
        <polyline className="cd-trend-line" points={points} />
        {trend.map((t, i) => (
          <g key={t.date}>
            <circle className="cd-trend-dot" cx={xs(i)} cy={ys(t.avgPlacement)} r={3.5}>
              <title>{tip(t)}</title>
            </circle>
            {labeled(i) && (
              <text className="cd-trend-avg" x={xs(i)} y={ys(t.avgPlacement) - 9}>
                {fmtAvg(t.avgPlacement)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <p className="cd-note">
        Each column is one snapshot period: the line is that period&rsquo;s average placement
        (higher on the chart = better), the bars are how many games it was played.
      </p>
    </div>
  );
}

export function CompDetail({ detail, backHref }: { detail: CompDetailVM; backHref: string }) {
  const id = detail.identity;
  const m = detail.metrics;
  // Placement distribution is the universal default; hit states take over as
  // the opening tab only for hit-shaped (reroll) lines.
  const [panel, setPanel] = useState<'placement' | 'hits' | 'trend'>(
    detail.hitStatesDefault ? 'hits' : 'placement',
  );
  const maxPlacementShare = Math.max(...detail.placements.map((p) => p.share), 0.0001);

  return (
    <section className="cd">
      <div className="cd-back">
        <Link href={backHref}>← Tier list</Link>
        <span className="cd-scope">
          Patch <b>{detail.selection.patch}</b> · <b>{detail.selection.region.toUpperCase()}</b> ·{' '}
          <b>{detail.selection.rankBucket}</b>
        </span>
      </div>

      <header className="cd-head">
        <span className={`tier-badge t-${detail.tier}`}>{detail.tier}</span>
        <div className="cd-title">
          <h1>{id.displayName ?? '—'}</h1>
          <div className="cd-tags">
            {id.keyTraits.map((t) => (
              <TraitChip key={t.traitId} trait={t} />
            ))}
            {id.dupUnits.length > 0 && (
              <span className="rr-tag tag-fast">Augment: 2× {id.dupUnits.join(', ')}</span>
            )}
            {id.heroAugmentUnit && (
              <span className="rr-tag tag-reroll">{id.heroAugmentUnit} Hero Aug</span>
            )}
          </div>
        </div>
        <div className="cd-stats">
          <div className="cd-stat">
            <b>{fmtAvg(m.avgPlacement)}</b>
            <span>Avg place</span>
          </div>
          <div className="cd-stat">
            <b>{fmtPct(m.top4Rate, 1)}</b>
            <span>Top 4</span>
          </div>
          <div className="cd-stat">
            <b>{fmtPct(m.winRate, 1)}</b>
            <span>Win</span>
          </div>
          <div className="cd-stat">
            <b>{fmtPct(detail.playRate, 1)}</b>
            <span>Play</span>
          </div>
          <div className="cd-stat">
            <b>{m.n.toLocaleString()}</b>
            <span>Games</span>
          </div>
        </div>
      </header>

      <div className="cd-strips">
        <div className="cd-strip">
          <h2>Core</h2>
          <div className="cd-strip-units">
            {detail.core.map((u) => (
              <UnitTile key={u.characterId} unit={u} showFreq={false} />
            ))}
          </div>
        </div>
        {detail.flex.length > 0 && (
          <div className="cd-strip">
            <h2>Flex</h2>
            <div className="cd-strip-units">
              {detail.flex.map((u) => (
                <UnitTile key={u.characterId} unit={u} showFreq />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="cd-cols">
        <div className="cd-panel">
          <div className="cd-tabs">
            <button
              type="button"
              className={panel === 'placement' ? 'active' : ''}
              onClick={() => setPanel('placement')}
            >
              Placement
            </button>
            <button
              type="button"
              className={panel === 'hits' ? 'active' : ''}
              onClick={() => setPanel('hits')}
            >
              Hit states
            </button>
            <button
              type="button"
              className={panel === 'trend' ? 'active' : ''}
              onClick={() => setPanel('trend')}
            >
              Trend
            </button>
          </div>

          {panel === 'trend' ? (
            <TrendChart trend={detail.trend} />
          ) : panel === 'placement' ? (
            <div className="cd-bands cd-pl">
              {detail.placements.map((p) => (
                <div className="cd-band" key={p.placement}>
                  <span className="cd-band-label">{ORDINALS[p.placement - 1]}</span>
                  <span className="cd-band-bar">
                    <i
                      className={p.placement <= 4 ? 'top' : 'bot'}
                      style={{ width: `${Math.max((p.share / maxPlacementShare) * 100, 1)}%` }}
                    />
                  </span>
                  <span className="cd-band-val">{fmtPct(p.share, 1)}</span>
                </div>
              ))}
            </div>
          ) : (
            <>
              <p className="cd-note">
                Same line, split by which units actually hit 3★ — you can’t choose to hit, so
                the comp’s tier is earned on all of them together.
              </p>
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Hit</th>
                    <th className="num">Games</th>
                    <th className="num">Share</th>
                    <th className="num">Avg</th>
                    <th className="num">Top 4</th>
                    <th className="num">Win</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.variants.map((v) => (
                    <VariantRow key={v.key} v={v} />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="cd-panel">
          <h2>Final level</h2>
          <div className="cd-bands">
            {detail.levelBands.map((b) => (
              <div className="cd-band" key={b.band}>
                <span className="cd-band-label">{b.band}</span>
                <span className="cd-band-bar">
                  <i style={{ width: `${Math.max(b.share * 100, 0.5)}%` }} />
                </span>
                <span className="cd-band-val">
                  {fmtPct(b.share, 1)} · avg {fmtAvg(b.avgPlacement)}
                </span>
              </div>
            ))}
          </div>

          {detail.builds.length > 0 && (
            <>
              <h2 className="cd-gap">Carry items</h2>
              <div className="cd-builds">
                {detail.builds.map((b) => (
                  <BuildRow key={b.characterId} build={b} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="cd-panel">
        <h2>Units</h2>
        <table className="cd-table cd-units-table">
          <thead>
            <tr>
              <th>Unit</th>
              <th className="num">Games</th>
              <th className="num">Play</th>
              <th className="num">Avg</th>
              <th className="num">Δ</th>
              <th className="num">Top 4</th>
              <th className="num">Win</th>
            </tr>
          </thead>
          <tbody>
            {detail.unitsTable.map((u) => (
              <tr key={u.characterId}>
                <td>
                  <span className="cd-unit-cell">
                    <MiniUnit
                      unit={{
                        characterId: u.characterId,
                        name: u.name,
                        cost: u.cost,
                        iconUrl: u.iconUrl,
                      }}
                    />
                    <span className="cd-unit-name">
                      {u.name}
                      {u.perStar.length > 1 && (
                        <span className="cd-star-split">
                          {u.perStar.map((s) => `${s.star}★ ${fmtAvg(s.avgPlacement)}`).join(' · ')}
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="num">{u.boards.toLocaleString()}</td>
                <td className="num">{fmtPct(u.freq, 0)}</td>
                <td className="num">{fmtAvg(u.avgPlacement)}</td>
                <td className={`num ${u.delta < -0.05 ? 'good' : u.delta > 0.05 ? 'bad' : ''}`}>
                  {fmtDelta(u.delta)}
                </td>
                <td className="num">{fmtPct(u.top4Rate, 0)}</td>
                <td className="num">{fmtPct(u.winRate, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="cd-panel">
        <h2>Most played boards</h2>
        <div className="cd-boards">
          {detail.topBoards.map((b) => (
            <div className="cd-board" key={b.compId}>
              <div className="cd-board-meta">
                <b>{b.n.toLocaleString()}</b> games · avg <b>{fmtAvg(b.avgPlacement)}</b>
              </div>
              <ExampleTeam team={b.team} />
            </div>
          ))}
        </div>
        <p className="cd-note">
          {detail.memberCount.toLocaleString()} exact boards pooled into this archetype.
        </p>
      </div>
    </section>
  );
}
