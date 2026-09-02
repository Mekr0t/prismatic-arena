'use client';

// UnitStatsGrid — the champion stat block, shared by the game-data popup and
// the Library detail. CommunityDragon stores 1★ base stats; HP and Attack
// Damage scale by the standard TFT multipliers each star (HP ×1.8, AD ×1.5),
// so those render as "base / 2★ / 3★" (matching in-client tooltips). Everything
// else is star-invariant and shows a single value.
//
// Note the CDragon key for Attack Damage is `damage` (not `attackDamage`); AP
// is omitted from base stats and defaults to 100.

import { StatLabel } from './StatIcon';

const round = (v: number): string => String(Math.round(v));

/** "base/×mult/×mult²" for a star-scaling stat (no spaces — stays one line). */
function perStar(base: number, mult: number): string {
  return [base, base * mult, base * mult * mult].map(round).join('/');
}

interface StatLine {
  label: string;
  value: string;
  scaling?: boolean; // renders the per-star slashed value distinctly
}

export function unitStatLines(stats: Record<string, number>): StatLine[] {
  const has = (k: string): number | undefined =>
    typeof stats[k] === 'number' ? stats[k] : undefined;
  const lines: StatLine[] = [];

  const hp = has('hp');
  if (hp !== undefined) lines.push({ label: 'HP', value: perStar(hp, 1.8), scaling: true });

  const ad = has('damage') ?? has('attackDamage');
  if (ad !== undefined) lines.push({ label: 'AD', value: perStar(ad, 1.5), scaling: true });

  lines.push({ label: 'AP', value: round(has('abilityPower') ?? 100) });

  const as = has('attackSpeed');
  if (as !== undefined) lines.push({ label: 'AS', value: as.toFixed(2) });

  const armor = has('armor');
  if (armor !== undefined) lines.push({ label: 'Armor', value: round(armor) });

  const mr = has('magicResist');
  if (mr !== undefined) lines.push({ label: 'MR', value: round(mr) });

  const cc = has('critChance');
  if (cc !== undefined) lines.push({ label: 'Crit Chance', value: `${Math.round(cc * 100)}%` });

  const range = has('range');
  if (range !== undefined) lines.push({ label: 'Range', value: round(range) });

  const mana = has('mana');
  const initMana = has('initialMana');
  if (mana !== undefined)
    lines.push({ label: 'Mana', value: `${round(initMana ?? 0)} / ${round(mana)}` });

  return lines;
}

export function UnitStatsGrid({ stats }: { stats: Record<string, number> | null | undefined }) {
  if (!stats) return null;
  const lines = unitStatLines(stats);
  if (lines.length === 0) return null;
  return (
    <div className="ustat-grid">
      {lines.map((l) => (
        <div key={l.label} className="ustat">
          <span className="ustat-k"><StatLabel label={l.label} /></span>
          <span className={`ustat-v${l.scaling ? ' scaling' : ''}`}>{l.value}</span>
        </div>
      ))}
    </div>
  );
}
